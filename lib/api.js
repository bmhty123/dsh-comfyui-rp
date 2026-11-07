import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyOverrides,
  analyzeOutputs,
  comfyStatus,
  defaultOutputIds,
  detectTokens,
  interrupt,
  parseWorkflowJson,
  scanPromptNodes,
} from './comfy.js';
import { publicConfig } from './config.js';
import {
  applyLoraState,
  clearLoraCatalogCache,
  clearRuntimeLoraState,
  fetchLoraCatalog,
  loraLabel,
  readLoraNames,
  resolveLoraState,
  runtimeLoraInfo,
  scanLoraStacks,
  setRuntimeLoraState,
} from './lora.js';
import { parseByRule, previewSets, ruleList } from './rule.js';
import {
  askLocal,
  captureLocal,
  latestRemoteSessionText,
  listLocalSessions,
  listRemoteSessions,
  remoteProbe,
  resolveSessionController,
  sessionIdOf,
} from './session.js';
import {
  HttpError,
  cleanBodyText,
  deepMerge,
  fmtBytes,
  nowIso,
  num,
  readJson,
  sendJson,
  sendText,
} from './util.js';

function parseUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    return new URL('http://127.0.0.1/');
  }
}

function viewImage(rec) {
  return rec;
}

/** 悬浮球只需要列表 / 翻页字段；提示词正文和磁盘路径不往 compact state 里塞。 */
function compactImageView(rec) {
  return {
    id: rec.id,
    url: rec.url,
    fileName: rec.fileName,
    bytes: rec.bytes,
    createdAt: rec.createdAt,
    sessionId: rec.sessionId,
    sessionTitle: rec.sessionTitle,
    jobId: rec.jobId,
    title: rec.title,
    anchor: rec.anchor || '',
    turn: rec.turn ?? null,
    seed: rec.seed,
    setIndex: rec.setIndex,
    continuousShot: rec.continuousShot || null,
    favorited: rec.favorited,
    recycled: rec.recycled,
    favoritedAt: rec.favoritedAt,
    deletedAt: rec.deletedAt,
  };
}

/**
 * 对外 HTTP API。
 *
 *   <route>/api/<action>   控制面（面板 + 另一台 DSH 的插件）
 *   <route>/img/<imageId>  图片（同源 <img>，支持 ETag / 304 / ?download=1）
 *   <route>/api/events     SSE：job / image / log
 *   <route>/api/stream     SSE：给另一台 DSH 的插件抓这个进程的助手回复
 *   <route>/api/session-text 给另一台 DSH 的插件读指定会话最新正文
 *
 * ★ 没有 Origin 闸门：这是同源面板自己的接口；DSH 的插件路由本来就只在
 *   本机监听，跨站页面拿不到同源权限。要更保险就在网关上把 DSH 关在本机。
 */
// 随插件附带的格式参考（英文文件名，方便跨平台 / 打包）；插件不会读取它。
const FORMAT_REFERENCE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'PROMPT_FORMAT_REFERENCE.md',
);

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function mimeOf(file) {
  return IMAGE_MIME[String(path.extname(file) || '').toLowerCase()] || 'application/octet-stream';
}

/** 用系统文件管理器打开一个目录；目录不存在就先建出来。 */
function openFolderInManager(dir) {
  return new Promise((resolve, reject) => {
    let target = dir;
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (e) {
      reject(new HttpError(500, `建不了目录：${e?.message || e}`, 'mkdir-failed'));
      return;
    }
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'explorer.exe';
      args = [target];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [target];
    } else {
      cmd = 'xdg-open';
      args = [target];
    }
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      reject(new HttpError(500, `打不开文件夹：${e?.message || e}`, 'open-folder'));
      return;
    }
    child.once('error', (e) => reject(new HttpError(500, `打不开文件夹：${e?.message || e}`, 'open-folder')));
    child.once('spawn', () => {
      try { child.unref(); } catch { /* ignore */ }
      resolve({ path: target });
    });
  });
}

/** 用系统文件管理器定位到规范文件；只在本机弹窗，不经过浏览器。 */
function revealFileInManager(file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) {
      reject(new HttpError(404, `文件不存在：${file}`, 'format-file-missing'));
      return;
    }
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'explorer.exe';
      args = ['/select,', file];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = ['-R', file];
    } else {
      cmd = 'xdg-open';
      args = [path.dirname(file)];
    }
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      reject(new HttpError(500, `打不开文件管理器：${e?.message || e}`, 'reveal-failed'));
      return;
    }
    child.once('error', (e) => {
      reject(new HttpError(500, `打不开文件管理器：${e?.message || e}`, 'reveal-failed'));
    });
    child.once('spawn', () => {
      try { child.unref(); } catch { /* ignore */ }
      resolve({ path: file, dir: path.dirname(file) });
    });
  });
}

export function createApi({ store, jobs, hub, getConfig, ctx, sc, routePath, version, onConfigChanged, onActiveSessionChanged }) {
  const runtime = {
    activeSessionId: '',
    activeSessionTitle: '',
    startedAt: nowIso(),
  };
  if (jobs && typeof jobs.setActiveSessionProvider === 'function') {
    jobs.setActiveSessionProvider(() => runtime.activeSessionId, () => runtime.activeSessionTitle);
  }

  const ok = (data) => ({ ok: true, ...(data || {}) });

  /**
   * 写操作只接受同源浏览器请求：跨站页面即使能发 no-cors POST，也会带
   * 自己的 Origin，这里直接拒绝。Node / 远程插件不带 Origin，不受影响。
   */
  function requireSameOrigin(req) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    // 现代浏览器会带 Sec-Fetch-Site；这比只看 Origin 更早拦住跨站表单。
    const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
    if (site === 'cross-site') throw new HttpError(403, '跨站请求被拒绝', 'csrf');
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return;
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = ''; }
    const host = String(req.headers.host || '').trim().toLowerCase();
    if (!originHost || !host || originHost !== host) {
      throw new HttpError(403, '跨站请求被拒绝', 'csrf');
    }
  }

  /**
   * 远程接口的共享口令：只要来源 / 提示词来源里配过口令，就必须带对
   * x-prompt-relay-token。没配口令时保持旧行为（本机 / 局域网默认无口令）。
   */
  function requireRemoteToken(req) {
    const cfg = getConfig();
    const expected = [cfg.source?.token, cfg.target?.token]
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    if (!expected.length) return;
    const got = String(req.headers['x-prompt-relay-token'] || '').trim();
    if (!expected.includes(got)) {
      throw new HttpError(401, '共享口令不正确，远程请求被拒绝', 'unauthorized');
    }
  }
  // 会话上报有时只带 sessionId（dock 席位不一定给标题）；补一次标题查询，
  // 概览 / 正文来源才显示会话名，而不是 session-xxxx。
  const activeTitleCache = new Map();
  async function resolveActiveSessionTitle(sid, { fresh = false } = {}) {
    const key = String(sid || '').trim();
    if (!key) return '';
    if (fresh) activeTitleCache.delete(key);
    const hit = activeTitleCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60000) return hit.title;
    // apply 时 sessionController 可能还没 provide；必须和 listLocalSessions 一样
    // 每次通过 ctx 重新取，不能只看闭包里的 sc。
    const controller = resolveSessionController(ctx, sc);
    if (!controller) return '';
    // 手动「检测」时先问 projection：会话刚改名 / 刚开时，list 里的标题可能还是旧的。
    if (fresh) {
      try {
        const proj = await controller.projections({ sessionId: key });
        const title = String(proj?.values?.title || '').trim();
        if (title) {
          activeTitleCache.set(key, { title, at: Date.now() });
          return title;
        }
      } catch { /* 退回 list */ }
    }
    try {
      const raw = await controller.list({});
      const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
      const item = items.find((s) => s && sessionIdOf(s) === key);
      let title = String(item?.title || item?.projections?.values?.title || '').trim();
      if (!title) {
        const proj = await controller.projections({ sessionId: key });
        title = String(proj?.values?.title || '').trim();
      }
      if (title) activeTitleCache.set(key, { title, at: Date.now() });
      return title;
    } catch {
      return '';
    }
  }

  /** 正文来源：勾了「本会话」就用当前活动会话，否则用配置里的模式 / 会话。 */
  function resolveSource() {
    const src = getConfig().source || {};
    if (src.followActive !== false) {
      return {
        ...src,
        mode: 'local',
        sessionId: runtime.activeSessionId || '',
        title: runtime.activeSessionTitle || '',
      };
    }
    return src;
  }

  /**
   * 手动操作（正文预览 / 投递 / 重新生成）优先用请求里带的当前面板 sessionId。
   * Host 的 activeSessionId 是全局最后上报者；多窗口同时开时会被别的窗口覆盖，
   * 不能把「本会话」的手动投递交给它猜。
   */
  function resolveBodySource(input = {}) {
    const base = getConfig().source || {};
    if (base.followActive !== false) {
      const sid = String(input.sessionId || '').trim();
      if (sid) {
        return {
          ...base,
          mode: 'local',
          sessionId: sid,
          title: String(input.title || '').trim()
            || (sid === runtime.activeSessionId ? runtime.activeSessionTitle : ''),
        };
      }
    }
    return resolveSource();
  }

  /** 统一读「某个来源」最新一条助手正文：本进程返回 { text, turn }，远程没有 turn。 */
  async function latestPartyText(party, label = '会话') {
    if (!party || !party.sessionId) {
      throw new HttpError(400, `还没选${label}`, 'no-session');
    }
    if (party.mode === 'remote') {
      const remote = await latestRemoteSessionText({
        baseUrl: party.baseUrl,
        routePath: party.routePath,
        token: party.token,
        sessionId: party.sessionId,
      });
      return { text: cleanBodyText(remote.text), turn: null, opening: !!remote.opening };
    }
    const got = await jobs.latestSessionText(party.sessionId);
    return { text: cleanBodyText(got.text), turn: got.turn ?? null, opening: !!got.opening };
  }

  /**
   * 只有人物卡开场的会话不能当正文来源。
   * Tavern 会把人物卡开场种成会话的第一条助手消息：选错会话 / 刚开的会话里，
   * 「最新一条助手消息」就是开场白，投出去等于把开场当成新剧情。
   */
  function assertNotOpening(got, label = '正文来源') {
    if (!got || !got.opening) return;
    throw new HttpError(409,
      `${label}这个会话里只有人物卡开场：最新一条助手消息就是整个会话的第一条，还没有真正的正文。`
      + '换到正在写的那个会话再试；确实要用开场的话，把它贴进正文框手动投递。',
      'opening-only');
  }

  function statePayload(compact = false) {
    const cfg = getConfig();
    const pub = publicConfig(cfg);
    const source = resolveSource();
    const publicSource = cfg.source.followActive !== false
      ? { ...pub.source, mode: source.mode, sessionId: source.sessionId, title: source.title }
      : pub.source;
    const activeWf = store.getActiveWorkflow();
    const activeSid = runtime.activeSessionId || '';
    const jobRows = store.listJobs(50).filter((j) => !activeSid
      || j.ownerSessionId === activeSid
      || j.sourceSessionId === activeSid
      || j.targetSessionId === activeSid);
    // 悬浮球用 compact state；保留最近几条任务，黑图补图可能同时有多条内部任务，
    // 只给 1 条会让后面的补图完成事件看不到。
    const jobsList = jobRows.slice(0, compact ? 8 : 12).map((j) => jobs.jobView(j, { compact: true }));
    // 悬浮球 / 概览的最近图只取当前会话；图库页自己用 sessionId 再筛。
    const images = store.listImages({ page: 1, size: compact ? 100 : 12, sessionId: runtime.activeSessionId || null });
    const imageItems = compact ? images.items.map(compactImageView) : images.items;
    return {
      ok: true,
      version,
      routePath,
      config: pub,
      workflows: compact ? [] : store.listWorkflows(),
      activeWorkflowId: cfg.workflowId,
      activeWorkflow: activeWf
        ? { id: activeWf.id, name: activeWf.name, size: activeWf.size || null, sizeMode: activeWf.sizeMode || 'manual', randomSeed: activeWf.randomSeed !== false, blackRetry: activeWf.blackRetry !== false, nodeCount: Object.keys(activeWf.json || {}).length }
        : null,
      jobs: jobsList,
      images: imageItems,
      imagesTotal: images.total,
      imagesGhost: compact ? 0 : images.ghost,
      favoritesTotal: compact ? 0 : store.listFavorites({ page: 1, size: 1 }).total,
      recycleTotal: compact ? 0 : store.listRecycled().total,
      rules: compact ? [] : ruleList(),
      logs: compact ? [] : hub.logs.slice(-120),
      activeSessionId: runtime.activeSessionId,
      activeSessionTitle: runtime.activeSessionTitle,
      runtime: {
        dataDir: store.dir,
        outputDir: store.outputDir(),
        favoriteDir: store.favoriteDir(),
        recycleDir: store.recycleDir(),
        savedAt: nowIso(),
        lastSaveError: store.lastSaveError,
        clients: hub.clientCount,
      },
      capture: {
        source: publicSource,
        target: { ...pub.target },
        autoForward: cfg.capture.autoForward,
        autoGenerate: cfg.capture.autoGenerate,
      },
    };
  }

  /* ------------------------------- 图片 ------------------------------- */

  async function serveImage(req, res, url, rest) {
    const id = decodeURIComponent(rest.slice(4).split('/')[0] || '');
    const rec = store.getImage(id);
    if (!rec) return sendText(res, 404, 'image not found');
    const p = store.mediaPathOf(rec);
    if (!p) return sendText(res, 404, '这张图的文件已经不在磁盘上了');
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return sendText(res, 404, '读不到这张图');
    }
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const lastModified = stat.mtime.toUTCString();
    const cacheControl = 'private, max-age=604800, immutable';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
      });
      res.end();
      return;
    }
    const headers = {
      'Content-Type': mimeOf(p),
      'Content-Length': stat.size,
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    };
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(p))}"`;
    }
    // 直接流式读盘：桥不把整张图缓存在内存里，浏览器自己按需缓存。
    const stream = fs.createReadStream(p);
    stream.on('error', (e) => {
      if (!res.headersSent) sendText(res, 500, `读取图片失败：${e?.message || e}`);
      else res.destroy();
    });
    res.writeHead(200, headers);
    res.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
  }

  /* ------------------------------- SSE ------------------------------- */

  function serveEvents(req, res) {
    hub.addClient(res);
  }

  function serveStream(req, res, url) {
    const sid = String(url.searchParams.get('sessionId') || '').trim();
    if (!sid) return sendText(res, 400, 'sessionId 不能为空');
    if (!ctx || typeof ctx.on !== 'function') return sendText(res, 503, '宿主没有 session/event 服务');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const dispose = captureLocal(ctx, sid, (entry) => {
      try {
        res.write(`event: message\ndata: ${JSON.stringify(entry)}\n\n`);
      } catch { /* ignore */ }
    });
    const ping = setInterval(() => {
      try { res.write('event: ping\ndata: {}\n\n'); } catch { /* ignore */ }
    }, 25000);
    if (typeof ping.unref === 'function') ping.unref();
    const cleanup = () => {
      clearInterval(ping);
      try { dispose(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /* ------------------------------ 远程投递 ------------------------------ */

  async function handleAsk(req, res, body) {
    requireRemoteToken(req);
    const sid = String(body.sessionId || '').trim();
    // 远程投递过来的正文也可能带 @bubble 包装；在真正送进会话前清掉。
    const text = cleanBodyText(body.text ?? '');
    if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId 不能为空', code: 'bad-request' });
    if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text 不能为空', code: 'bad-request' });
    const ac = new AbortController();
    const onClose = () => { try { ac.abort(); } catch { /* ignore */ } };
    req.on('close', onClose);
    try {
      const r = await askLocal(ctx, sc, {
        sessionId: sid,
        text,
        timeoutMs: body.timeoutMs,
        signal: ac.signal,
      });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      const status = Number(e?.status) || 500;
      return sendJson(res, status, {
        ok: false,
        error: String(e?.message || e),
        code: e?.code || 'internal',
      });
    } finally {
      req.removeListener('close', onClose);
    }
  }

  /* ------------------------------ LoRA ------------------------------ */

  async function handleLoras(req, res, body) {
    const cfg = getConfig();
    const wf = store.getWorkflow(body.workflowId || cfg.workflowId);
    if (!wf) throw new HttpError(404, '工作流不存在');
    const json = body.json ? parseWorkflowJson(body.json) : wf.json;
    const scanned = scanLoraStacks(json);
    const catalog = await fetchLoraCatalog(cfg.comfy.baseUrl, { refresh: body.refresh === true }).catch((e) => ({
      items: [], source: 'none', error: String(e?.message || e),
    }));
    const names = readLoraNames();
    const byName = new Map((catalog.items || []).map((it) => [it.name.toLowerCase(), it]));
    const state = resolveLoraState(wf);
    const info = runtimeLoraInfo(wf.id);

    // 出图时到底哪一堆生效（ComfySwitchNode 的 trueStack / falseStack）。
    // 只对真正参与开关的堆标记生效 / 不生效；单 LoRA、Power、Stacker 这类
    // 没有开关控制的节点不能被误标成「不生效」。
    const activeStackIds = new Set();
    const controlledStackIds = new Set();
    for (const sw of scanned.switches) {
      for (const id of [sw.trueStack, sw.falseStack]) if (id) controlledStackIds.add(String(id));
      const pick = sw.value === true ? sw.trueStack : sw.falseStack;
      if (pick) activeStackIds.add(String(pick));
    }

    const stacks = scanned.stacks.map((st) => {
      const rows = (state?.stacks?.[st.nodeId] || null);
      const entries = st.entries.map((e, i) => {
        const override = rows ? rows.find((r) => String(r.name).toLowerCase() === String(e.name).toLowerCase()) : null;
        const cat = byName.get(String(e.name).toLowerCase()) || null;
        const labelDefault = loraLabel(e.name, names, cat);
        const labelCustom = override && typeof override.label === 'string' ? override.label.trim() : '';
        return {
          index: i,
          name: e.name,
          label: labelCustom || labelDefault,
          labelDefault,
          labelCustom: !!labelCustom,
          active: override ? override.on === true : e.active === true,
          strength: override && typeof override.strength === 'number' ? override.strength : e.strength,
          clipStrength: override && typeof override.clip === 'number' ? override.clip : e.clipStrength,
          words: (override && Array.isArray(override.words) ? override.words : (cat?.trainedWords || [])),
          wordsOff: (override && Array.isArray(override.wordsOff) ? override.wordsOff : []),
          previewUrl: cat?.previewUrl || '',
          baseModel: cat?.baseModel || '',
          inCatalog: !!cat,
        };
      });
      return {
        nodeId: st.nodeId,
        title: st.title,
        classType: st.classType,
        kind: st.kind || 'manager',
        group: st.group || (st.kind === 'manager' ? 'stack' : 'loose'),
        order: Number(st.order) || 0,
        entries,
        toggles: st.toggles || [],
        active: controlledStackIds.has(String(st.nodeId)) ? activeStackIds.has(String(st.nodeId)) : true,
        managed: !!rows,
      };
    });

    return ok({
      workflowId: wf.id,
      workflowName: wf.name,
      stacks,
      switches: scanned.switches,
      catalog: {
        source: catalog.source || 'none',
        error: catalog.error || '',
        count: (catalog.items || []).length,
        cached: catalog.cached === true,
      },
      names,
      state: {
        active: !!state,
        temporary: info.temporary,
        savedInWorkflow: !!wf.loraState,
        effectiveSource: info.temporary ? 'temporary' : wf.loraState ? 'record' : 'none',
        temporaryState: info.state,
      },
    });
  }

  /* ------------------------------ 工作流 ------------------------------ */

  function workflowPayload(wf) {
    return {
      id: wf.id,
      name: wf.name,
      json: wf.json || {},
      mapping: wf.mapping || {},
      mappingSeeded: wf.mappingSeeded === true,
      mappingVersion: Number(wf.mappingVersion) || 0,
      outputNodes: wf.outputNodes || [],
      outputSelectionVersion: Number(wf.outputSelectionVersion) || 0,
      tokenEmpty: 'blank',
      size: wf.size || null,
      sizeMode: wf.sizeMode || 'manual',
      randomSeed: wf.randomSeed !== false,
      seed: wf.seed === null || wf.seed === undefined ? null : Number(wf.seed),
      lastSeed: wf.lastSeed === null || wf.lastSeed === undefined ? null : Number(wf.lastSeed),
      blackRetry: wf.blackRetry !== false,
      pruneOutputs: wf.pruneOutputs !== false,
      onlyFirst: wf.onlyFirst === true,
      loraState: wf.loraState || null,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
    };
  }

  function handleScan(body) {
    const wf = body.json ? parseWorkflowJson(body.json) : (body.workflowId ? store.getWorkflow(body.workflowId)?.json : null);
    if (!wf) throw new HttpError(400, '没有可扫描的工作流 JSON');
    const nodes = scanPromptNodes(wf);
    const tokens = detectTokens(wf);
    const outputs = analyzeOutputs(wf);
    return ok({
      nodeCount: Object.keys(wf).length,
      nodes,
      tokens,
      outputs: outputs.outputs,
      suggestedKeep: outputs.suggestedKeep,
      defaultOutputIds: outputs.defaultOutputIds,
    });
  }

  /**
   * 输出节点不能为空：保存时若调用方没给，默认勾选一个 SaveImage（优先标准 SaveImage）。
   * 工作流页自己也做了同样的默认勾选，这里兜住「没点解析预览就直接保存」的情况。
   */
  function withDefaultOutputNodes(body, fallbackJson) {
    if (!body || typeof body !== 'object') return body;
    // LoRA 页只发 { loraState } 这种局部 patch 时，不要把输出节点重置成默认值；
    // 只有真正保存工作流 JSON / 输出勾选时才补默认输出节点。
    if (!Array.isArray(body.outputNodes) && !body.json) return body;
    const current = Array.isArray(body.outputNodes) ? body.outputNodes : [];
    if (current.length) {
      body.outputSelectionVersion = 2;
      return body;
    }
    const json = body.json || fallbackJson;
    if (!json) return body;
    try {
      const wf = parseWorkflowJson(json);
      const ids = defaultOutputIds(wf);
      if (ids.length) body.outputNodes = ids;
      body.outputSelectionVersion = 2;
    } catch { /* 保存时的 JSON 错误由调用方自己报 */ }
    return body;
  }

  function handleDryRun(body) {
    const wf = store.getWorkflow(body.workflowId || getConfig().workflowId);
    const json = body.json ? parseWorkflowJson(body.json) : wf?.json;
    if (!json) throw new HttpError(400, '没有可干跑的工作流 JSON');
    const mapping = body.mapping || wf?.mapping || {};
    const size = body.size || wf?.size || null;
    const sizeMode = body.sizeMode || wf?.sizeMode || 'manual';
    const loraState = body.loraState !== undefined ? body.loraState : resolveLoraState(wf || {});
    const loraScan = scanLoraStacks(json);
    // 固定种子：干跑也要按工作流页填的那个值算，否则「干跑」和真出一张的结果对不上。
    const seed = body.seed !== undefined ? body.seed : (wf && wf.seed !== undefined ? wf.seed : null);
    const { workflow, report } = applyOverrides(json, {
      positive: String(body.positive ?? ''),
      negative: String(body.negative ?? ''),
      mapping,
      tokenEmpty: 'blank',
      randomSeed: body.randomSeed === true,
      seed,
      loraState,
      size,
      sizeSource: sizeMode,
    });
    return ok({
      report,
      loraDetected: {
        stacks: loraScan.stacks.length,
        entries: loraScan.stacks.reduce((n, s) => n + (s.entries?.length || 0), 0),
        switches: loraScan.switches.length,
      },
      nodeCount: Object.keys(workflow).length,
      json: body.includeJson ? workflow : undefined,
    });
  }

  /* ------------------------------ 主分发 ------------------------------ */

  async function handleApi(req, res, action, url) {
    const method = (req.method || 'GET').toUpperCase();
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      body = await readJson(req, 32 * 1024 * 1024);
    }
    const cfg = getConfig();

    if (action === 'health' && method === 'GET') {
      return sendJson(res, 200, ok({
        name: 'dsh-comfyui-rp',
        version,
        routePath,
        activeSessionId: runtime.activeSessionId,
        // 健康检查也可能被远程 / 浏览器读到：两边口令都必须脱敏。
        sessions: {
          source: { ...cfg.source, token: '' },
          target: { ...cfg.target, token: '' },
        },
        comfy: { baseUrl: cfg.comfy.baseUrl },
        clients: hub.clientCount,
      }));
    }

    if (action === 'state' && method === 'GET') {
      return sendJson(res, 200, statePayload(url.searchParams.get('compact') === '1'));
    }

    if (action === 'config' && method === 'GET') return sendJson(res, 200, ok({ config: publicConfig(cfg) }));
    if (action === 'config' && (method === 'PUT' || method === 'POST')) {
      const before = JSON.stringify(cfg.paths || {});
      const incoming = body && typeof body === 'object' ? { ...body } : body;
      // 刷新 / 重载后前端草稿可能暂时是空的；不要把已经保存的提示词来源
      // 用一次空 sessionId 回存抹掉（同模式才保护，切 remote/local 时允许改）。
      if (incoming?.target && Object.prototype.hasOwnProperty.call(incoming.target, 'sessionId')) {
        const nextSid = String(incoming.target.sessionId || '').trim();
        const oldSid = String(cfg.target.sessionId || '').trim();
        const nextMode = incoming.target.mode || cfg.target.mode;
        if (!nextSid && oldSid && nextMode === cfg.target.mode) {
          incoming.target = {
            ...incoming.target,
            sessionId: cfg.target.sessionId,
            title: incoming.target.title || cfg.target.title,
          };
        }
      }
      const patch = deepMerge(cfg, incoming);
      // 前端拿到的是脱敏配置（token 恒为空 + hasToken），回存时别把真 token 抹掉
      if (incoming?.target?.token === '' && incoming?.target?.hasToken) patch.target.token = cfg.target.token;
      if (incoming?.source?.token === '' && incoming?.source?.hasToken) patch.source.token = cfg.source.token;
      const next = store.updateConfig(patch);
      const changed = JSON.stringify(next.paths || {}) !== before;
      if (typeof onConfigChanged === 'function') onConfigChanged(next);
      // 悬浮球和概览各挂一个组件：配置保存后广播，两个开关 / A 才能立即同步。
      hub.broadcast('state', { reason: 'config' });
      hub.pushLog('info', '配置已保存');
      return sendJson(res, 200, ok({
        config: publicConfig(next),
        note: changed ? '数据目录改动要重启 DSH 才生效（当前仍用旧目录）' : '',
      }));
    }

    if (action === 'sessions' && method === 'GET') {
      const mode = url.searchParams.get('mode') || url.searchParams.get('scope') || 'local';
      const limit = num(url.searchParams.get('limit'), 80);
      if (mode === 'remote') {
        const data = await listRemoteSessions({
          baseUrl: url.searchParams.get('baseUrl') || cfg.target.baseUrl || cfg.source.baseUrl,
          routePath: url.searchParams.get('routePath') || cfg.target.routePath,
          token: url.searchParams.get('token') || cfg.target.token,
          limit,
        });
        return sendJson(res, 200, ok(data));
      }
      const data = await listLocalSessions(sc, { limit, withTitle: true, ctx });
      // 新开的会话可能还没进 controller.list()：至少把当前会话补进列表，
      // 设置页的下拉框不会显示成「未选择」。
      const sid = String(runtime.activeSessionId || '').trim();
      let sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (sid) {
        const row = sessions.find((s) => String(s.sessionId) === sid);
        if (row) {
          // 当前会话名以 Host 刚解析到的为准，列表里的旧标题不要盖回去。
          const title = String(runtime.activeSessionTitle || '').trim();
          if (title) { row.title = title; row.displayTitle = title; }
        } else {
          const title = runtime.activeSessionTitle || await resolveActiveSessionTitle(sid);
          sessions = [{
            sessionId: sid, title, displayTitle: title || sid.slice(0, 12),
            cwd: '', updatedAt: Date.now(), running: false, live: false, blank: false,
          }, ...sessions];
        }
      }
      return sendJson(res, 200, ok({ sessions, total: sessions.length }));
    }

    if (action === 'sessions/refresh' && method === 'POST') {
      // 概览右上「检测」：强制重读可用会话和标题，不吃 60 秒标题缓存。
      activeTitleCache.clear();
      // fresh=true：每个会话都重新问一次 projection，名称不用 list 里的旧值。
      const data = await listLocalSessions(sc, { limit: 200, withTitle: true, ctx, fresh: true });
      const byId = new Map((Array.isArray(data.sessions) ? data.sessions : [])
        .map((s) => [String(s.sessionId || ''), String(s.title || '').trim()]));
      const prevActive = String(runtime.activeSessionId || '').trim();
      const want = String(body.sessionId || prevActive || '').trim();
      const active = { sessionId: want, title: '' };
      if (want) {
        runtime.activeSessionId = want;
        active.title = String(byId.get(want) || await resolveActiveSessionTitle(want, { fresh: true }) || '').trim();
        // 同一会话重读失败时保留旧标题，避免一次抖动把会话名抹成短 id。
        if (!active.title && want === prevActive) active.title = runtime.activeSessionTitle || '';
        runtime.activeSessionTitle = active.title;
        if (active.title) activeTitleCache.set(want, { title: active.title, at: Date.now() });
        // 捕获层的标题来自这里；刷新后要让捕获重建，别继续用旧标题。
        if (typeof onActiveSessionChanged === 'function') {
          onActiveSessionChanged(runtime.activeSessionId, runtime.activeSessionTitle);
        }
      }
      let sourceTitle = String(cfg.source.title || '');
      let targetTitle = String(cfg.target.title || '');
      if (cfg.source.mode !== 'remote' && cfg.source.sessionId) {
        const t = byId.get(String(cfg.source.sessionId));
        if (t) sourceTitle = t;
      }
      if (cfg.target.mode !== 'remote' && cfg.target.sessionId) {
        const t = byId.get(String(cfg.target.sessionId));
        if (t) targetTitle = t;
      }
      let changed = false;
      if (sourceTitle !== String(cfg.source.title || '')) { cfg.source.title = sourceTitle; changed = true; }
      if (targetTitle !== String(cfg.target.title || '')) { cfg.target.title = targetTitle; changed = true; }
      if (changed) {
        store.saveConfig();
        if (typeof onConfigChanged === 'function') onConfigChanged(cfg);
      }
      let sessions = (Array.isArray(data.sessions) ? data.sessions : []).slice();
      if (active.sessionId && !sessions.some((s) => String(s.sessionId) === active.sessionId)) {
        sessions.unshift({
          sessionId: active.sessionId,
          title: active.title,
          displayTitle: active.title || active.sessionId.slice(0, 12),
          cwd: '', updatedAt: Date.now(), running: false, live: false, blank: false,
        });
      }
      const applyTitle = (sid, title) => {
        if (!sid || !title) return;
        const row = sessions.find((s) => String(s.sessionId) === String(sid));
        if (row) { row.title = title; row.displayTitle = title; }
      };
      applyTitle(active.sessionId, active.title);
      applyTitle(cfg.source.sessionId, sourceTitle);
      applyTitle(cfg.target.sessionId, targetTitle);
      hub.broadcast('state', { reason: 'sessions-refreshed' });
      hub.pushLog('info', `已刷新可用会话：${sessions.length} 个${active.title ? `，当前「${active.title}」` : ''}`);
      return sendJson(res, 200, ok({
        sessions,
        total: sessions.length,
        active,
      }));
    }

    if (action === 'remote/probe' && method === 'POST') {
      const data = await remoteProbe({
        baseUrl: body.baseUrl || cfg.target.baseUrl || cfg.source.baseUrl,
        routePath: body.routePath || cfg.target.routePath || cfg.source.routePath,
        // 口令输入已隐藏；测试远程时用配置里保存的 target / source 口令兜底。
        token: body.token || cfg.target.token || cfg.source.token,
      });
      return sendJson(res, 200, ok(data));
    }

    if (action === 'active-session' && method === 'POST') {
      runtime.activeSessionId = String(body.sessionId || '');
      let title = String(body.title || '').trim();
      if (!title) title = await resolveActiveSessionTitle(runtime.activeSessionId);
      if (title && runtime.activeSessionId) {
        activeTitleCache.set(runtime.activeSessionId, { title, at: Date.now() });
      }
      runtime.activeSessionTitle = title;
      hub.broadcast('active-session', { sessionId: runtime.activeSessionId, title: runtime.activeSessionTitle });
      if (typeof onActiveSessionChanged === 'function') {
        onActiveSessionChanged(runtime.activeSessionId, runtime.activeSessionTitle);
      }
      return sendJson(res, 200, ok({ sessionId: runtime.activeSessionId, title: runtime.activeSessionTitle }));
    }
    if (action === 'active-session' && method === 'GET') {
      return sendJson(res, 200, ok({ sessionId: runtime.activeSessionId, title: runtime.activeSessionTitle }));
    }

    if (action === 'capture' && method === 'POST') {
      const sid = String(body.sessionId || runtime.activeSessionId || '').trim();
      const rawText = String(body.text ?? '');
      let turn = null;
      let text = cleanBodyText(rawText);
      if (body.text === undefined || !rawText.trim()) {
        const got = await jobs.latestSessionText(sid);
        // 预览 / 试读照旧返回文本，真正投递前再拦一次。
        if (body.forward !== false && body.preview !== true) {
          assertNotOpening({ opening: got.opening, text: got.text });
        }
        text = got.text;
        turn = got.turn ?? null;
      } else if (!text.trim()) {
        // 手写正文只有 @bubble：清理后是空的，不能悄悄换成会话里的最新正文。
        if (body.forward === false || body.preview === true) {
          return sendJson(res, 200, ok({ text: '', sessionId: sid, chars: 0, turn: null, empty: true, emptied: true }));
        }
        throw new HttpError(400, '正文清理后是空的（只有 @bubble 指令）', 'empty-after-clean');
      }
      if (body.forward === false || body.preview === true) {
        return sendJson(res, 200, ok({ text, sessionId: sid, chars: text.length, turn }));
      }      const job = await jobs.forwardText({
        text,
        sourceSessionId: sid,
        sourceTurn: turn,
        ownerSessionId: String(body.ownerSessionId || runtime.activeSessionId || sid),
        ownerSessionTitle: String(body.ownerSessionTitle || runtime.activeSessionTitle || ''),
        autoGenerate: body.autoGenerate !== undefined ? body.autoGenerate === true : cfg.capture.autoGenerate,
        continuous: body.continuous === true,
        replaceOld: body.replaceOld === true,
      });
      return sendJson(res, 200, ok({ text, job: jobs.jobView(job) }));
    }

    if (action === 'body-source/preview' && method === 'POST') {
      // 概览正文框专用：只读，不投递。旧 Host 没有这个路由，客户端会显示
      // 读取失败，而不会把预览误当成一次真实投递。
      const src = resolveBodySource(body);
      if (!src.sessionId) {
        return sendJson(res, 200, ok({ text: '', sessionId: '', title: '', chars: 0, turn: null, missing: true }));
      }
      const got = await latestPartyText(src, '正文来源');
      const text = String(got.text || '');
      return sendJson(res, 200, ok({
        text,
        sessionId: src.sessionId,
        title: src.title || '',
        chars: text.length,
        turn: got.turn ?? null,
        empty: !text.trim(),
        // 只有人物卡开场时前端给一句提示：这种会话投出去的不是最新正文。
        opening: !!got.opening,
      }));
    }

    if (action === 'forward-source' && method === 'POST') {
      const src = resolveBodySource(body);
      // 概览正文框默认展示正文来源的最新回复；用户手动改过时，
      // 只有「投递最新正文」会把这段文本带上来，其它投递一律仍读来源会话。
      const rawText = String(body.text ?? '');
      let text = cleanBodyText(rawText);
      let turn = body.sourceTurn ?? null;
      if (body.text !== undefined && rawText.trim() && !text.trim()) {
        throw new HttpError(400, '正文清理后是空的（只有 @bubble 指令）', 'empty-after-clean');
      }
      if (!text.trim()) {
        const got = await latestPartyText(src, '正文来源');
        assertNotOpening(got);
        text = got.text;
        turn = got.turn ?? null;
      }
      if (!String(text || '').trim()) {
        throw new HttpError(404, '正文来源还没有助手回复，没有正文可以投递', 'no-text');
      }
      if (!src.sessionId) {
        throw new HttpError(400, '还没选正文来源，没法记录正文属于哪个会话', 'no-session');
      }
      const job = await jobs.forwardText({
        text,
        sourceSessionId: src.sessionId,
        sourceSessionTitle: src.title || '',
        sourceTurn: turn,
        ownerSessionId: String(body.ownerSessionId || runtime.activeSessionId || src.sessionId),
        ownerSessionTitle: String(body.ownerSessionTitle || runtime.activeSessionTitle || ''),
        autoGenerate: body.autoGenerate !== undefined ? body.autoGenerate === true : cfg.capture.autoGenerate,
        continuous: body.continuous === true,
        replaceOld: body.replaceOld === true,
      });
      return sendJson(res, 200, ok({ text, turn, sessionId: src.sessionId, job: jobs.jobView(job) }));
    }

    if (action === 'session-text' && method === 'GET') {
      requireRemoteToken(req);
      const sid = String(url.searchParams.get('sessionId') || '').trim();
      if (!sid) throw new HttpError(400, 'sessionId 不能为空', 'bad-request');
      const r = await jobs.latestSessionText(sid);
      return sendJson(res, 200, ok({
        text: r.text, sessionId: sid, chars: r.text.length, turn: r.turn ?? null,
        // 只有人物卡开场时对方（或前端）能据此拦下来，别把开场当正文投出去。
        opening: !!r.opening,
      }));
    }

    if (action === 'prompt-source/text' && method === 'POST') {
      const target = cfg.target || {};
      if (!target.sessionId) {
        throw new HttpError(400, '还没选提示词来源，先去设置里选一个会话', 'no-target');
      }
      const got = await latestPartyText(target, '提示词来源');
      const text = got.text;
      if (!String(text || '').trim()) {
        throw new HttpError(404, '提示词来源还没有助手回复，没有正文可以提取', 'no-text');
      }
      return sendJson(res, 200, ok({
        text,
        sessionId: target.sessionId,
        title: target.title || '',
        mode: target.mode,
        chars: text.length,
        turn: got.turn ?? null,
      }));
    }

    if (action === 'format/reference-reveal' && method === 'POST') {
      const opened = await revealFileInManager(FORMAT_REFERENCE_FILE);
      hub.pushLog('info', `已在文件管理器中定位格式参考：${opened.path}`);
      return sendJson(res, 200, ok(opened));
    }

    if (action === 'follow/clear-anchors' && method === 'POST') {
      // 只清当前会话的定位：别的会话里的图和锚点保持不动。
      const sid = String(body.sessionId || runtime.activeSessionId || '').trim();
      if (!sid) throw new HttpError(400, '没有当前会话，无法清空定位', 'no-session');
      const cleared = store.clearImageAnchors(sid);
      const title = String(body.sessionTitle || '').trim();
      hub.broadcast('state', { reason: 'anchors-cleared', sessionId: sid });
      hub.pushLog('info', `已清空${title ? `「${title}」` : '当前会话'} ${cleared.images} 张图的原文锚点，跟图改为按比例分配`);
      return sendJson(res, 200, ok(cleared));
    }

    if (action === 'forward' && method === 'POST') {
      const text = cleanBodyText(body.text ?? '');
      if (!text.trim()) {
        throw new HttpError(400, '正文是空的（或只有 @bubble 指令，清理后没有内容）', 'empty-after-clean');
      }
      const job = await jobs.forwardText({
        text,
        sourceSessionId: String(body.sourceSessionId || ''),
        sourceTurn: body.sourceTurn ?? null,
        ownerSessionId: String(body.ownerSessionId || runtime.activeSessionId || ''),
        ownerSessionTitle: String(body.ownerSessionTitle || runtime.activeSessionTitle || ''),
        autoGenerate: body.autoGenerate !== undefined ? body.autoGenerate === true : cfg.capture.autoGenerate,
        continuous: body.continuous === true,
        replaceOld: body.replaceOld === true,
      });
      return sendJson(res, 200, ok({ job: jobs.jobView(job) }));
    }

    if (action === 'generate' && method === 'POST') {
      const job = await jobs.generateSets({
        sets: body.sets,
        text: String(body.text || ''),
        workflowId: body.workflowId || '',
        positive: body.positive,
        negative: body.negative,
        continuous: body.continuous === true,
        imageCount: body.imageCount,
        ownerSessionId: String(body.sessionId || runtime.activeSessionId || ''),
        ownerSessionTitle: String(body.sessionTitle || runtime.activeSessionTitle || ''),
        sourceSessionId: String(body.sourceSessionId || body.sessionId || runtime.activeSessionId || ''),
        sourceSessionTitle: String(body.sourceSessionTitle || body.sessionTitle || runtime.activeSessionTitle || ''),
        sourceTurn: body.sourceTurn ?? null,
      });
      return sendJson(res, 200, ok({ job: jobs.jobView(job) }));
    }

    if (action === 'regenerate' && method === 'POST') {
      const mode = body.mode === 'all' ? 'all' : (body.mode === 'auto' ? 'auto' : 'single');
      // 手动重新生成也强制走正文来源的最新正文；黑图补图（auto）必须复用原提示词，不读最新。
      let latest = null;
      if (mode !== 'auto') {
        const source = resolveBodySource(body);
        const got = await latestPartyText(source, '正文来源');
        assertNotOpening(got);
        if (!String(got.text || '').trim()) {
          throw new HttpError(404, '正文来源还没有助手回复，无法用最新正文重新生成', 'no-text');
        }
        latest = {
          text: got.text,
          sessionId: source.sessionId,
          title: source.title || '',
          turn: got.turn ?? null,
        };
      }
      const job = await jobs.regenerate({
        jobId: body.jobId || '',
        imageId: body.imageId || '',
        setIndex: body.setIndex ?? null,
        workflowId: body.workflowId || '',
        imageCount: body.imageCount,
        continuous: body.continuous === true,
        ownerSessionId: String(body.sessionId || runtime.activeSessionId || ''),
        ownerSessionTitle: String(body.sessionTitle || runtime.activeSessionTitle || ''),
        mode,
        extra: String(body.extra || ''),
        latestText: latest ? latest.text : '',
        latestSessionId: latest ? latest.sessionId : '',
        latestSessionTitle: latest ? latest.title : '',
        latestTurn: latest ? latest.turn : null,
      });
      return sendJson(res, 200, ok({ job: jobs.jobView(job) }));
    }

    if (action === 'jobs' && method === 'GET') {
      const limit = num(url.searchParams.get('limit'), 40);
      const full = url.searchParams.get('full') === '1';
      return sendJson(res, 200, ok({ jobs: store.listJobs(limit).map((j) => jobs.jobView(j, { compact: !full })) }));
    }
    if (action === 'jobs/clear' && method === 'POST') {
      const left = store.clearJobs({ keepActive: body.keepActive !== false });
      return sendJson(res, 200, ok({ jobs: left.map(jobs.jobView) }));
    }
    let m = action.match(/^jobs\/([^/]+)$/);
    if (m && method === 'GET') {
      const job = store.getJob(m[1]);
      if (!job) throw new HttpError(404, '任务不存在');
      return sendJson(res, 200, ok({ job: jobs.jobView(job) }));
    }
    if (m && method === 'DELETE') {
      return sendJson(res, 200, ok({ deleted: store.deleteJob(m[1]) }));
    }
    m = action.match(/^jobs\/([^/]+)\/abort$/);
    if (m && method === 'POST') {
      const job = jobs.abortJob(m[1]);
      return sendJson(res, 200, ok({ job: jobs.jobView(job) }));
    }

    if (action === 'images' && method === 'GET') {
      const data = store.listImages({
        page: num(url.searchParams.get('page'), 1),
        size: num(url.searchParams.get('size'), 24),
        sessionId: url.searchParams.get('sessionId') || null,
        checkAlive: url.searchParams.get('check') !== '0',
      });
      return sendJson(res, 200, ok(data));
    }
    if (action === 'open-folder' && method === 'POST') {
      const scope = String(body.scope || 'all');
      let dir = '';
      let label = '';
      if (scope === 'favorites') {
        dir = store.favoriteDir();
        label = '收藏夹';
      } else if (scope === 'recycle') {
        dir = store.recycleDir();
        label = '回收站';
      } else if (scope === 'session') {
        const sid = String(body.sessionId || runtime.activeSessionId || '');
        if (!sid) throw new HttpError(400, '还没有当前会话，无法打开会话图片目录', 'no-session');
        const title = String(body.sessionTitle || runtime.activeSessionTitle || '');
        // 先过一遍目录索引：同会话改标题时复用旧目录，并把历史多目录合并掉。
        const folderName = store.chatFolderName(sid, title);
        const existing = store.sessionImageDir(sid);
        dir = existing || path.join(store.outputDir(), folderName);
        label = '当前会话';
        if (body.dry === true) return sendJson(res, 200, ok({ path: dir, scope, opened: false, noImages: !existing }));
        if (!existing) {
          return sendJson(res, 200, ok({
            scope,
            path: '',
            opened: false,
            noImages: true,
            message: '生成图片后自动创建文件夹',
          }));
        }
        // 有图才打开真实图片目录；顺手写入 / 更新会话元数据。
        store.stampChatFolder(dir, sid, title, { increment: false });
      } else {
        dir = store.outputDir();
        label = '全部图片';
      }
      if (body.dry === true) return sendJson(res, 200, ok({ path: dir, scope, opened: false }));
      const opened = await openFolderInManager(dir);
      hub.pushLog('info', `已打开${label}图片目录：${opened.path}`);
      return sendJson(res, 200, ok({ ...opened, scope }));
    }
    if (action === 'images/sync' && method === 'POST') {
      const favoritesOnly = body.favorites === true;
      const r = store.syncImagesWithDisk({ apply: body.apply === true, favoritesOnly });
      if (body.apply === true) hub.broadcast('state', { reason: favoritesOnly ? 'favorites-sync' : 'images-sync' });
      return sendJson(res, 200, ok(r));
    }
    m = action.match(/^images\/([^/]+)$/);
    if (m && method === 'GET') {
      const rec = store.getImage(m[1]);
      if (!rec) throw new HttpError(404, '图片记录不存在');
      return sendJson(res, 200, ok({ image: store.imageView(rec), alive: store.imageFileAlive(rec) }));
    }
    if (m && method === 'DELETE') {
      return sendJson(res, 200, ok({ deleted: store.deleteImage(m[1]) }));
    }
    m = action.match(/^images\/([^/]+)\/(favorite|unfavorite|recycle|restore)$/);
    if (m && method === 'POST') {
      const [, id, verb] = m;
      if (verb === 'favorite') {
        const r = store.favoriteImage(id);
        hub.broadcast('image', viewImage(r.rec));
        return sendJson(res, 200, ok({ already: r.already, to: r.to || '' }));
      }
      if (verb === 'unfavorite') {
        const r = store.unfavoriteImage(id);
        hub.broadcast('image', viewImage(r.rec));
        return sendJson(res, 200, ok({ already: r.already }));
      }
      if (verb === 'recycle') {
        const r = store.recycleImage(id);
        hub.broadcast('image', viewImage(r.rec));
        return sendJson(res, 200, ok({ already: r.already, to: r.to || '' }));
      }
      const r = store.restoreImage(id);
      hub.broadcast('image', viewImage(r.rec));
      return sendJson(res, 200, ok({ already: r.already, to: r.to || '' }));
    }

    if (action === 'favorites' && method === 'GET') {
      const data = store.listFavorites({
        page: num(url.searchParams.get('page'), 1),
        size: num(url.searchParams.get('size'), 60),
      });
      return sendJson(res, 200, ok(data));
    }
    if (action === 'recycle' && method === 'GET') return sendJson(res, 200, ok(store.listRecycled()));
    if (action === 'recycle/purge' && method === 'POST') {
      const r = store.purgeRecycle();
      hub.broadcast('state', { reason: 'recycle-purge' });
      return sendJson(res, 200, ok(r));
    }

    if (action === 'workflows' && method === 'GET') return sendJson(res, 200, ok({ workflows: store.listWorkflows() }));
    if (action === 'workflows' && method === 'POST') {
      const wf = store.saveWorkflow(withDefaultOutputNodes(body));
      return sendJson(res, 200, ok({ workflow: workflowPayload(wf) }));
    }
    if (action === 'workflows/scan' && method === 'POST') return sendJson(res, 200, handleScan(body));
    if (action === 'workflows/dry-run' && method === 'POST') return sendJson(res, 200, handleDryRun(body));
    m = action.match(/^workflows\/([^/]+)$/);
    if (m && method === 'GET') {
      const wf = store.getWorkflow(m[1]);
      if (!wf) throw new HttpError(404, '工作流不存在');
      return sendJson(res, 200, ok({ workflow: workflowPayload(wf) }));
    }
    if (m && method === 'PUT') {
      const before = store.getWorkflow(m[1]);
      const next = withDefaultOutputNodes(body, before?.json || null);
      const wf = store.patchWorkflow(m[1], next);
      if (!wf) throw new HttpError(404, '工作流不存在');
      return sendJson(res, 200, ok({ workflow: workflowPayload(wf) }));
    }
    if (m && method === 'DELETE') {
      return sendJson(res, 200, ok({ deleted: store.deleteWorkflow(m[1]) }));
    }
    m = action.match(/^workflows\/([^/]+)\/activate$/);
    if (m && method === 'POST') {
      store.setActiveWorkflow(m[1]);
      hub.broadcast('state', { reason: 'workflow-activated' });
      return sendJson(res, 200, ok({ workflowId: store.getConfig().workflowId }));
    }

    if (action === 'loras' && method === 'POST') return sendJson(res, 200, await handleLoras(req, res, body));
    if (action === 'loras/apply' && method === 'POST') {
      const id = String(body.workflowId || cfg.workflowId);
      const wf = store.getWorkflow(id);
      if (!wf) throw new HttpError(404, '工作流不存在');
      const r = setRuntimeLoraState(id, body.loraState === undefined ? undefined : body.loraState);
      hub.broadcast('state', { reason: 'lora-apply' });
      return sendJson(res, 200, ok({ ...r, workflowId: id }));
    }
    if (action === 'loras/reset' && method === 'POST') {
      const id = String(body.workflowId || cfg.workflowId);
      const wf = store.getWorkflow(id);
      if (!wf) throw new HttpError(404, '工作流不存在');
      clearRuntimeLoraState(id);
      wf.loraState = null;
      store.saveWorkflow(wf);
      clearLoraCatalogCache();
      hub.broadcast('state', { reason: 'lora-reset' });
      return sendJson(res, 200, ok({ workflowId: id }));
    }
    if (action === 'loras/preview' && method === 'POST') {
      const id = String(body.workflowId || cfg.workflowId);
      const wf = store.getWorkflow(id);
      if (!wf) throw new HttpError(404, '工作流不存在');
      const json = body.json ? parseWorkflowJson(body.json) : wf.json;
      const state = body.loraState !== undefined ? body.loraState : resolveLoraState(wf);
      const { report } = applyLoraState(json, state);
      return sendJson(res, 200, ok({ report }));
    }

    if (action === 'comfy/status' && method === 'GET') {
      const status = await comfyStatus(cfg.comfy.baseUrl);
      return sendJson(res, 200, ok({ status }));
    }
    if (action === 'comfy/interrupt' && method === 'POST') {
      const done = await interrupt(cfg.comfy.baseUrl);
      return sendJson(res, 200, ok({ interrupted: done }));
    }

    if (action === 'rules' && method === 'GET') return sendJson(res, 200, ok({ rules: ruleList() }));
    if (action === 'rule/preview' && method === 'POST') {
      const tags = body.customTags && typeof body.customTags === 'object'
        ? body.customTags
        : cfg.capture.customTags;
      const parsed = parseByRule(body.ruleId || cfg.capture.matchRule, cleanBodyText(String(body.text ?? '')), { customTags: tags });
      return sendJson(res, 200, ok({
        ruleId: parsed.ruleId,
        nonDelivery: parsed.nonDelivery,
        hasFence: parsed.hasFence,
        issues: parsed.issues || [],
        sets: previewSets(parsed.sets || []),
      }));
    }

    if (action === 'black-check' && method === 'POST') {
      const b = body || {};
      const stats = [
        b.darkRatio !== undefined ? `暗 ${(Number(b.darkRatio) * 100).toFixed(2)}%` : '',
        b.meanLum !== undefined ? `平均亮度 ${Number(b.meanLum).toFixed(1)}` : '',
        b.brightRatio !== undefined ? `亮点 ${(Number(b.brightRatio) * 100).toFixed(2)}%` : '',
        b.coverage !== undefined ? `不透明 ${Math.round(Number(b.coverage) * 100)}%` : '',
      ].filter(Boolean).join(' · ');
      const skippedText = b.skipped === 'bytes' ? '跳过（体积太大，不可能是纯黑）' : (b.skipped ? `跳过（${b.skipped}）` : '');
      const head = b.black === true ? '判为纯黑图' : (skippedText || '不是黑图');
      hub.pushLog(b.black === true ? 'warn' : 'info',
        `黑图检测：${head} · ${b.fileName || b.imageId || '?'}${b.bytes ? ` · ${b.bytes} B` : ''}${stats ? ` · ${stats}` : ''}`);
      return sendJson(res, 200, ok({ logged: true }));
    }

    if (action === 'logs' && method === 'GET') {
      return sendJson(res, 200, ok({ logs: hub.logs.slice(-300) }));
    }

    throw new HttpError(404, `未知接口：${method} ${action || '/'}`, 'not-found');
  }

  async function handle(req, res) {
    const url = parseUrl(req);
    const pathname = url.pathname || '/';
    if (pathname !== routePath && !pathname.startsWith(`${routePath}/`)) {
      return sendText(res, 404, 'airp-comfy: not found');
    }
    const rest = pathname.slice(routePath.length).replace(/^\/+/, '');
    try {
      requireSameOrigin(req);
      if (rest === '' || rest === 'api' || rest === 'api/health') {
        return sendJson(res, 200, ok({ name: 'dsh-comfyui-rp', version, routePath }));
      }
      if (rest === 'api/events') return serveEvents(req, res);
      if (rest === 'api/stream') {
        requireRemoteToken(req);
        return serveStream(req, res, url);
      }
      if (rest.startsWith('img/')) return await serveImage(req, res, url, rest);
      if (rest.startsWith('api/')) {
        const action = rest.slice(4).replace(/^\/+/, '');
        if (action === 'ask' && (req.method || '').toUpperCase() === 'POST') {
          // 先验口令，再读最大 8MB 的 body；没口令的请求不配吃内存。
          requireRemoteToken(req);
          // 必须 await：handleAsk 内部的 401 / 投递异常要落在外层 try / catch 里，
          // 否则会变成未处理的 Promise rejection 把 Host 进程带崩。
          return await handleAsk(req, res, await readJson(req, 8 * 1024 * 1024));
        }
        return await handleApi(req, res, action, url);
      }
      return sendText(res, 404, `airp-comfy: 未知路径 ${pathname}`);
    } catch (e) {
      const status = Number(e?.status) || 500;
      const code = e?.code || (status === 404 ? 'not-found' : 'internal');
      if (status >= 500) hub.pushLog('error', `${req.method} ${pathname} → ${status}：${e?.message || e}`);
      return sendJson(res, status, { ok: false, error: String(e?.message || e), code });
    }
  }

  return {
    handle,
    statePayload,
    get activeSessionId() { return runtime.activeSessionId; },
    get activeSessionTitle() { return runtime.activeSessionTitle; },
    setActiveSession(sessionId, title = '') {
      runtime.activeSessionId = String(sessionId || '');
      runtime.activeSessionTitle = String(title || '');
      if (typeof onActiveSessionChanged === 'function') {
        onActiveSessionChanged(runtime.activeSessionId, runtime.activeSessionTitle);
      }
    },
  };
}
