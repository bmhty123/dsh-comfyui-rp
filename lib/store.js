import fs from 'node:fs';
import path from 'node:path';
import { analyzeOutputs } from './comfy.js';
import { CONFIG_FILE, normalizeConfig } from './config.js';
import { parseByRule } from './rule.js';
import { ROUTE_PATH } from './meta.js';
import {
  HttpError,
  cleanBodyText,
  nowIso,
  num,
  readJsonFile,
  sanitizeName,
  uid,
  writeJsonAtomic,
} from './util.js';

const IMAGES_LIMIT = 5000;
const JOBS_LIMIT = 300;
/** 输出节点默认勾选规则版本：2 = 默认只勾一个 SaveImage（旧版是全部勾上）。 */
const OUTPUT_SELECTION_VERSION = 2;

/** child 是否在 parent 里面（用于「只删自己目录里的文件」）。 */
function isInside(parent, child) {
  const p = path.resolve(String(parent || ''));
  const c = path.resolve(String(child || ''));
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 目录里重名就加 _1 / _2，绝不覆盖。 */
function uniquePath(dir, fileName) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${i}${ext}`);
    i += 1;
  }
  return candidate;
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    // 跨盘 rename 会失败：复制后删源
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES')) {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return;
    }
    throw e;
  }
}

export function createStore(dataDir) {
  const dir = path.resolve(String(dataDir));
  const files = {
    config: path.join(dir, CONFIG_FILE),
    workflows: path.join(dir, 'workflows.json'),
    images: path.join(dir, 'images.json'),
    jobs: path.join(dir, 'jobs.json'),
    loraNames: path.join(dir, 'lora-names.json'),
  };

  const state = {
    dir,
    files,
    config: normalizeConfig({}),
    workflows: [],
    images: [],
    jobs: [],
    loraNames: {},
  };

  /** id -> 图片记录，避免每次 getImage 都在几千条里线性找。 */
  const imageIndex = new Map();

  /* ---------------------------- 会话目录索引 ----------------------------
   * 会话名目录的元数据统一放在 <output>/_chat.json；不再往每个图片文件夹里
   * 塞一份 _chat.json。旧版本留下的每目录文件会在第一次读取时迁移到根上。
   */
  let chatIndex = null;
  let chatIndexRoot = '';

  function blankChatIndex() {
    return { version: 1, folders: {} };
  }

  function normalizeChatMeta(meta, folder) {
    const m = meta && typeof meta === 'object' ? meta : {};
    return {
      sessionId: String(m.sessionId || ''),
      sessionTitle: String(m.sessionTitle || folder || ''),
      firstSeen: m.firstSeen || '',
      lastSeen: m.lastSeen || '',
      count: Math.max(0, num(m.count, 0)),
    };
  }

  function loadChatIndex() {
    const root = api.outputDir();
    if (chatIndex && chatIndexRoot === root) return chatIndex;
    chatIndexRoot = root;
    const file = path.join(root, '_chat.json');
    const raw = readJsonFile(file, null);
    if (raw && typeof raw === 'object' && raw.folders && typeof raw.folders === 'object') {
      chatIndex = blankChatIndex();
      for (const [folder, meta] of Object.entries(raw.folders)) {
        const normalized = normalizeChatMeta(meta, folder);
        if (normalized.sessionId) chatIndex.folders[folder] = normalized;
      }
      return chatIndex;
    }

    // 没有根索引：把旧版每个会话目录里的 _chat.json 收上来，写根文件后再删旧文件。
    chatIndex = blankChatIndex();
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => entry.name);
    } catch { entries = []; }
    for (const folder of entries) {
      const meta = normalizeChatMeta(readJsonFile(path.join(root, folder, '_chat.json'), null), folder);
      if (meta.sessionId) chatIndex.folders[folder] = meta;
    }
    if (Object.keys(chatIndex.folders).length) {
      try {
        fs.mkdirSync(root, { recursive: true });
        writeJsonAtomic(file, chatIndex);
        for (const folder of Object.keys(chatIndex.folders)) {
          try { fs.rmSync(path.join(root, folder, '_chat.json'), { force: true }); } catch { /* ignore */ }
        }
      } catch { /* 只是索引，失败不影响出图 */ }
    }
    return chatIndex;
  }

  function saveChatIndex() {
    if (!chatIndex) return false;
    try {
      const root = api.outputDir();
      fs.mkdirSync(root, { recursive: true });
      writeJsonAtomic(path.join(root, '_chat.json'), chatIndex);
      return true;
    } catch {
      return false;
    }
  }

  /** 会话标题 → 目录名（不再直接把这段逻辑散在 chatFolderName 里）。 */
  function chatBaseName(sessionTitle) {
    let base = sanitizeName(String(sessionTitle || '').trim() || '未命名会话', '未命名会话')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 48) || '未命名会话';
    if (base.startsWith('_')) base = '会话' + base;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) base = `会话-${base}`;
    return base;
  }

  function isExistingDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  /** Windows 路径不区分大小写，合并时按同一个 key 对齐记录。 */
  function pathKey(p) {
    const resolved = path.resolve(String(p || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  /** 索引里属于这个会话、而且磁盘上还在的目录。 */
  function sessionFolders(sessionId, index, root) {
    const sid = String(sessionId || '');
    const names = [];
    for (const [name, meta] of Object.entries(index.folders || {})) {
      if (String(meta?.sessionId || '') !== sid) continue;
      if (!name || name !== path.basename(name) || name.startsWith('_')) continue;
      if (isExistingDir(path.join(root, name))) names.push(name);
    }
    return names;
  }

  /** 旧版按标题拆出多个目录时，选一个最新的继续用；其余合并进来。 */
  function pickSessionFolder(names, index) {
    return names.slice().sort((a, b) => {
      const ma = index.folders[a] || {};
      const mb = index.folders[b] || {};
      const ta = Date.parse(ma.lastSeen || '') || 0;
      const tb = Date.parse(mb.lastSeen || '') || 0;
      if (tb !== ta) return tb - ta;
      return num(mb.count, 0) - num(ma.count, 0);
    })[0] || '';
  }

  /**
   * 把同一个会话的历史多目录合并到一个目录里。
   * 文件只搬不覆盖（重名自动加 _1）；搬不动的目录保留索引，下次再试。
   */
  function mergeSessionFolders(sessionId, targetName, names, sessionTitle, index, root) {
    const targetDir = path.join(root, targetName);
    const moved = new Map();
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of names) {
      if (name === targetName) continue;
      const srcDir = path.join(root, name);
      let entries = [];
      try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name === '_chat.json') continue;
        const src = path.join(srcDir, entry.name);
        try {
          const dst = uniquePath(targetDir, entry.name);
          moveFile(src, dst);
          moved.set(pathKey(src), dst);
        } catch {
          /* 单个文件被占用：保留原目录，下一次再合并 */
        }
      }
      try { fs.rmSync(path.join(srcDir, '_chat.json'), { force: true }); } catch { /* ignore */ }
      try { fs.rmdirSync(srcDir); } catch { /* 还有没搬走的文件，下次再试 */ }
    }

    if (moved.size) {
      for (const rec of state.images) {
        if (!rec.absPath) continue;
        const hit = moved.get(pathKey(rec.absPath));
        if (hit) {
          rec.absPath = hit;
          rec.fileName = path.basename(hit);
        }
      }
      for (const job of state.jobs) {
        if (!Array.isArray(job.images)) continue;
        for (const im of job.images) {
          if (!im.path) continue;
          const hit = moved.get(pathKey(im.path));
          if (hit) {
            im.path = hit;
            im.fileName = path.basename(hit);
          }
        }
      }
      save(files.images, state.images);
      save(files.jobs, state.jobs);
      clearAliveCache();
    }

    // 没搬空的旧目录保留索引，下次继续合并；已经空了的从索引里去掉。
    const remaining = [];
    for (const name of names) {
      if (name === targetName) continue;
      if (isExistingDir(path.join(root, name))) remaining.push(name);
    }
    const all = [targetName, ...remaining];
    let firstSeen = '';
    let lastSeen = '';
    for (const name of all) {
      const meta = index.folders[name] || {};
      if (meta.firstSeen && (!firstSeen || meta.firstSeen < firstSeen)) firstSeen = meta.firstSeen;
      if (meta.lastSeen && (!lastSeen || meta.lastSeen > lastSeen)) lastSeen = meta.lastSeen;
    }
    const targetMeta = index.folders[targetName] || {};
    const remainingMeta = remaining.map((name) => [name, index.folders[name] || {}]);
    for (const name of all) delete index.folders[name];
    index.folders[targetName] = {
      sessionId: String(sessionId || ''),
      sessionTitle: String(sessionTitle || targetMeta.sessionTitle || ''),
      firstSeen: firstSeen || targetMeta.firstSeen || nowIso(),
      lastSeen: lastSeen || nowIso(),
      count: Math.max(0, num(targetMeta.count, 0)) + moved.size,
    };
    // 搬不动的目录仍然属于这个会话，下次访问时继续合并。
    for (const [name, meta] of remainingMeta) {
      index.folders[name] = {
        ...meta,
        sessionId: String(meta.sessionId || sessionId || ''),
        sessionTitle: String(meta.sessionTitle || name),
      };
    }
    saveChatIndex();
  }

  /** 写盘失败不能拖垮请求：记一条 lastSaveError，下次保存还试。 */
  state.lastSaveError = '';

  function save(file, data) {
    try {
      writeJsonAtomic(file, data);
      state.lastSaveError = '';
      return true;
    } catch (e) {
      state.lastSaveError = `${path.basename(file)}: ${e?.message || e}`;
      return false;
    }
  }

  /* --------------------------- 写盘合并 / 活文件缓存 ---------------------------
   * jobs.json / images.json 会随着出图变大；每落一张图、每改一次状态就整份写盘，
   * 在几千条记录时会明显拖慢事件循环。这里：
   *   · 普通追加（图片记录 / 任务状态）合并到 200ms 后写一次；
   *   · 删除 / 收藏 / 回收 / 还原 / 同步这些用户动作立刻写；
   *   · 文件是否还在的 stat 结果缓存 10 秒，列表和任务卡不再每次逐条打磁盘。
   */
  const pendingSaves = new Map();
  let saveTimer = null;
  const ALIVE_TTL_MS = 10000;
  const aliveCache = new Map();

  function queueSave(file, data) {
    pendingSaves.set(file, data);
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 200);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    for (const [file, data] of pendingSaves) save(file, data);
    pendingSaves.clear();
  }

  function clearAliveCache() { aliveCache.clear(); }

  function fileAlive(p) {
    const key = String(p || '');
    if (!key) return false;
    const now = Date.now();
    const hit = aliveCache.get(key);
    if (hit && now - hit.at < ALIVE_TTL_MS) return hit.alive;
    let alive = false;
    try { alive = fs.statSync(key).isFile(); } catch { alive = false; }
    aliveCache.set(key, { at: now, alive });
    if (aliveCache.size > 8000) {
      // 简单清理：删掉最早的一批（Map 保持插入顺序）
      let n = 0;
      for (const k of aliveCache.keys()) {
        aliveCache.delete(k);
        if (++n >= 2000) break;
      }
    }
    return alive;
  }

  const api = {
    get dir() { return state.dir; },
    get files() { return state.files; },
    get lastSaveError() { return state.lastSaveError; },

    /* ------------------------------- 载入 ------------------------------- */

    loadAll() {
      fs.mkdirSync(dir, { recursive: true });
      state.config = normalizeConfig(readJsonFile(files.config, {}));
      // 数据目录以配置为准：配置里写的是「另一个目录」时，本轮仍用启动时定的目录
      //（切换目录需要重启宿主，避免运行中一半数据在新目录、一半在旧目录）。
      const wf = readJsonFile(files.workflows, []);
      state.workflows = Array.isArray(wf) ? wf.filter((w) => w && w.id && w.name) : [];
      // outputNodes 为空时默认只勾一个 SaveImage（优先标准 SaveImage）。
      // 旧版本曾把识别到的输出节点全部自动勾上；升级后只迁移一次，
      // 之后用户自己勾几个就保留几个。
      let workflowsFixed = false;
      for (const w of state.workflows) {
        const current = Array.isArray(w.outputNodes) ? w.outputNodes.filter(Boolean) : [];
        let target = current.map(String);
        let detected = [];
        let defaults = [];
        try {
          const analyzed = analyzeOutputs(w.json || {});
          detected = (analyzed.outputs || []).map((o) => String(o.id)).filter(Boolean);
          defaults = (analyzed.defaultOutputIds || []).map(String).filter(Boolean);
          if (detected.length) {
            const alive = new Set(detected);
            target = target.filter((id) => alive.has(id));
          }
        } catch { /* 坏工作流留给页面自己报 */ }
        const autoAll = target.length > 0
          && detected.length === target.length
          && detected.every((id) => target.includes(id));
        if (!target.length) target = defaults;
        else if (w.outputSelectionVersion !== OUTPUT_SELECTION_VERSION && autoAll) target = defaults;
        const same = Array.isArray(w.outputNodes)
          && w.outputNodes.length === target.length
          && w.outputNodes.every((id, i) => String(id) === target[i]);
        if (!same) {
          w.outputNodes = target;
          workflowsFixed = true;
        }
        if (w.outputSelectionVersion !== OUTPUT_SELECTION_VERSION) {
          w.outputSelectionVersion = OUTPUT_SELECTION_VERSION;
          workflowsFixed = true;
        }
      }
      if (workflowsFixed) save(files.workflows, state.workflows);
      const images = readJsonFile(files.images, []);
      state.images = Array.isArray(images) ? images.filter((r) => r && r.id) : [];
      if (state.images.length > IMAGES_LIMIT) state.images = state.images.slice(-IMAGES_LIMIT);
      imageIndex.clear();
      for (const r of state.images) imageIndex.set(r.id, r);
      const jobs = readJsonFile(files.jobs, []);
      state.jobs = Array.isArray(jobs) ? jobs.filter((j) => j && j.id) : [];
      if (state.jobs.length > JOBS_LIMIT) state.jobs = state.jobs.slice(-JOBS_LIMIT);
      // 旧版自动任务在 runJob 里把 anchor 丢了；原始回复还在 job.replyText，
      // 启动时按当时的规则重解析一次，把 anchor / title 补回 job.sets。
      const missingAnchorJobs = new Set(
        state.images.filter((r) => r && !r.anchor && r.jobId).map((r) => String(r.jobId)),
      );
      let jobsBackfilled = 0;
      for (const job of state.jobs) {
        if (!missingAnchorJobs.has(String(job.id))) continue;
        if (job.anchorCleared) continue;
        if (!job.replyText || !Array.isArray(job.sets) || !job.sets.length) continue;
        if (job.sets.some((s) => s && s.anchor)) continue;
        let parsed = null;
        try {
          parsed = parseByRule(
            job.ruleId || (state.config.capture && state.config.capture.matchRule) || 'contract_v2',
            String(job.replyText),
            { customTags: state.config.capture && state.config.capture.customTags },
          );
        } catch { parsed = null; }
        if (!parsed || !Array.isArray(parsed.sets) || parsed.sets.length !== job.sets.length) continue;
        let changed = false;
        for (let i = 0; i < job.sets.length; i += 1) {
          const set = job.sets[i];
          const hit = parsed.sets[i];
          if (!set || !hit) continue;
          if (!set.anchor && hit.anchor) { set.anchor = hit.anchor; changed = true; }
          if (!set.title && hit.title) { set.title = hit.title; changed = true; }
        }
        if (changed) jobsBackfilled += 1;
      }
      if (jobsBackfilled) save(files.jobs, state.jobs);
      // 旧版图片记录可能没有 anchor / turn（当时还没写这两个字段，或规则预览
      // 把 anchor 吃掉了）。只要对应的生成任务还在，就从 job.sets 回填一次，
      // 省得用户为了滚动切图把旧图全部重生成。
      let imagesBackfilled = 0;
      const jobById = new Map(state.jobs.map((j) => [String(j.id), j]));
      for (const rec of state.images) {
        const job = rec.jobId ? jobById.get(String(rec.jobId)) : null;
        if (!job || job.anchorCleared || !Array.isArray(job.sets) || !job.sets.length) continue;
        const jobImage = Array.isArray(job.images) ? job.images.find((im) => im && String(im.id) === String(rec.id)) : null;
        const rawIndex = rec.setIndex !== null && rec.setIndex !== undefined && rec.setIndex !== ''
          ? rec.setIndex : (jobImage ? jobImage.setIndex : null);
        const setIndex = rawIndex !== null && rawIndex !== undefined && rawIndex !== '' && Number.isInteger(Number(rawIndex))
          ? Number(rawIndex) : 0;
        const set = job.sets[setIndex] || (job.sets.length === 1 ? job.sets[0] : null);
        if (!set) continue;
        let changed = false;
        if (!rec.anchor && set.anchor) { rec.anchor = String(set.anchor); changed = true; }
        if (!rec.title && set.title) { rec.title = String(set.title); changed = true; }
        const sameSource = !job.sourceSessionId || String(job.sourceSessionId) === String(rec.sessionId || '');
        if ((rec.turn === null || rec.turn === undefined || rec.turn === '')
          && sameSource && job.sourceTurn !== null && job.sourceTurn !== undefined) {
          rec.turn = Number(job.sourceTurn);
          changed = true;
        }
        if (changed) imagesBackfilled += 1;
      }
      if (imagesBackfilled) save(files.images, state.images);
      const names = readJsonFile(files.loraNames, {});
      state.loraNames = names && typeof names === 'object' && !Array.isArray(names) ? names : {};

      // 没有工作流时至少留一个空记录，工作流页不会一片空白
      if (!state.workflows.length) {
        state.workflows.push({
          id: uid('wf_'),
          name: '未命名工作流',
          json: {},
          mapping: {},
          mappingSeeded: false,
          mappingVersion: 0,
          outputNodes: [],
          outputSelectionVersion: OUTPUT_SELECTION_VERSION,
          tokenEmpty: 'blank',
          size: null,
          sizeMode: 'manual',
          randomSeed: true,
          pruneOutputs: true,
          onlyFirst: false,
          loraState: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        save(files.workflows, state.workflows);
      }
      if (!state.config.workflowId || !state.workflows.some((w) => w.id === state.config.workflowId)) {
        state.config.workflowId = state.workflows[0].id;
        save(files.config, state.config);
      }
      return api;
    },

    /* ------------------------------- 配置 ------------------------------- */

    getConfig() { return state.config; },
    saveConfig() { return save(files.config, state.config); },
    updateConfig(patch) {
      state.config = normalizeConfig({ ...state.config, ...(patch || {}) });
      save(files.config, state.config);
      return state.config;
    },

    /* ------------------------------ 工作流 ------------------------------ */

    listWorkflows() {
      return state.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        size: w.size || null,
        sizeMode: w.sizeMode || 'manual',
        nodeCount: w.json ? Object.keys(w.json).length : 0,
        outputs: Array.isArray(w.outputNodes) ? w.outputNodes.length : 0,
        hasLora: !!w.loraState,
        active: w.id === state.config.workflowId,
        updatedAt: w.updatedAt || '',
      }));
    },

    getWorkflow(id) {
      return state.workflows.find((w) => w.id === String(id || '')) || null;
    },

    getActiveWorkflow() {
      return api.getWorkflow(state.config.workflowId) || state.workflows[0] || null;
    },

    saveWorkflow(input) {
      const now = nowIso();
      // 「占位符为空时」选项已删除：一律替换成空字符串。
      if (input && typeof input === 'object') input.tokenEmpty = 'blank';
      const rec = input && input.id ? state.workflows.find((w) => w.id === input.id) : null;
      if (rec) {
        Object.assign(rec, input, { id: rec.id, updatedAt: now });
      } else {
        const w = {
          id: uid('wf_'),
          name: sanitizeName(input?.name || '未命名工作流', '工作流'),
          json: {},
          mapping: {},
          mappingSeeded: false,
          mappingVersion: 0,
          outputNodes: [],
          outputSelectionVersion: OUTPUT_SELECTION_VERSION,
          tokenEmpty: 'blank',
          size: null,
          sizeMode: 'manual',
          randomSeed: true,
          pruneOutputs: true,
          onlyFirst: false,
          loraState: null,
          createdAt: now,
          updatedAt: now,
          ...(input || {}),
        };
        state.workflows.push(w);
        if (!state.config.workflowId) {
          state.config.workflowId = w.id;
          save(files.config, state.config);
        }
        save(files.workflows, state.workflows);
        return w;
      }
      save(files.workflows, state.workflows);
      return rec;
    },

    /** 局部更新（分辨率那行 / 自动载入时用），只动白名单字段。 */
    patchWorkflow(id, patch) {
      const w = api.getWorkflow(id);
      if (!w) return null;
      const allow = ['name', 'json', 'mapping', 'mappingSeeded', 'mappingVersion', 'outputNodes', 'outputSelectionVersion', 'tokenEmpty', 'size', 'sizeMode',
        'randomSeed', 'pruneOutputs', 'onlyFirst', 'loraState'];
      for (const k of allow) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, k)) w[k] = k === 'tokenEmpty' ? 'blank' : patch[k];
      }
      w.updatedAt = nowIso();
      save(files.workflows, state.workflows);
      return w;
    },

    deleteWorkflow(id) {
      const i = state.workflows.findIndex((w) => w.id === String(id || ''));
      if (i < 0) return false;
      state.workflows.splice(i, 1);
      if (state.config.workflowId === String(id || '')) {
        state.config.workflowId = state.workflows[0]?.id || '';
        save(files.config, state.config);
      }
      save(files.workflows, state.workflows);
      return true;
    },

    setActiveWorkflow(id) {
      if (!api.getWorkflow(id)) throw new HttpError(404, '工作流不存在');
      state.config.workflowId = String(id);
      save(files.config, state.config);
      return state.config.workflowId;
    },

    /* ------------------------------- 图片 ------------------------------- */

    outputDir() {
      const custom = String(state.config.paths.outputDir || '').trim();
      return custom ? path.resolve(custom) : path.join(dir, 'output');
    },

    outputSubdir(name) {
      return path.join(api.outputDir(), sanitizeName(name, 'misc'));
    },

    favoriteDir() {
      return path.join(api.outputDir(), '_favorites');
    },

    recycleDir() {
      return path.join(api.outputDir(), '_recycle');
    },

    chatFolderName(sessionId, sessionTitle = '') {
      const s = String(sessionId || '').trim();
      if (!s) return '_console';
      const root = api.outputDir();
      const index = loadChatIndex();
      const base = chatBaseName(sessionTitle);

      // 同一个会话只认一个目录：改标题不再新建。
      // 旧版已经按标题拆开的目录，在这里合并到最新的那个目录里。
      const known = sessionFolders(s, index, root);
      if (known.length) {
        const target = known.includes(base) ? base : pickSessionFolder(known, index);
        if (known.length > 1) {
          try {
            mergeSessionFolders(s, target, known, sessionTitle, index, root);
          } catch {
            /* 合并失败不影响本次出图；目录还在，下次再试 */
          }
        }
        return target;
      }

      // 没有历史目录：会话名目录空着就用；被别人占了才加 -2 / -3。
      for (let i = 1; i < 1000; i += 1) {
        const name = i === 1 ? base : `${base}-${i}`;
        const dir = path.join(root, name);
        if (!fs.existsSync(dir)) return name;
        const meta = index.folders[name] || normalizeChatMeta(readJsonFile(path.join(dir, '_chat.json'), null), name);
        if (String(meta.sessionId || '') === s) {
          if (!index.folders[name]) {
            index.folders[name] = meta;
            if (saveChatIndex()) {
              try { fs.rmSync(path.join(dir, '_chat.json'), { force: true }); } catch { /* ignore */ }
            }
          }
          return name;
        }
      }
      return `${base}-${Date.now().toString(36)}`;
    },

    /** 当前会话的图片目录；同会话复用旧目录，不写 sessionId 目录。 */
    folderForSession(sessionId, sessionTitle = '') {
      const sid = String(sessionId || '').trim();
      if (!sid) return api.outputDir();
      return path.join(api.outputDir(), api.chatFolderName(sid, sessionTitle));
    },

    /** 这个会话已有图片时，返回图片实际所在目录；没图返回空。 */
    sessionImageDir(sessionId) {
      const sid = String(sessionId || '').trim();
      if (!sid) return '';
      for (let i = state.images.length - 1; i >= 0; i -= 1) {
        const rec = state.images[i];
        if (String(rec.sessionId || '') !== sid) continue;
        if (rec.absPath && fileAlive(rec.absPath)) return path.dirname(rec.absPath);
      }
      return '';
    },

    /** 每聊天一个文件夹：记完整 sessionId / 会话名，方便以后按会话找图。 */
    stampChatFolder(chatDir, sessionId, sessionTitle = '', { increment = true } = {}) {
      try {
        fs.mkdirSync(chatDir, { recursive: true });
        const index = loadChatIndex();
        const key = path.basename(chatDir);
        const old = index.folders[key] || {};
        const now = nowIso();
        index.folders[key] = {
          sessionId: String(sessionId || old.sessionId || ''),
          sessionTitle: String(sessionTitle || old.sessionTitle || ''),
          firstSeen: old.firstSeen || now,
          lastSeen: now,
          count: Math.max(0, num(old.count, 0)) + (increment ? 1 : 0),
        };
        if (saveChatIndex()) {
          // 迁移后不再在每个图片目录里留一份。
          try { fs.rmSync(path.join(chatDir, '_chat.json'), { force: true }); } catch { /* ignore */ }
        }
      } catch {
        /* 只是索引文件，失败不影响出图 */
      }
    },

    addImage(meta) {
      const rec = {
        id: uid('img_'),
        createdAt: nowIso(),
        ...meta,
      };
      state.images.push(rec);
      imageIndex.set(rec.id, rec);
      if (state.images.length > IMAGES_LIMIT) {
        const drop = state.images.slice(0, state.images.length - IMAGES_LIMIT);
        state.images = state.images.slice(-IMAGES_LIMIT);
        for (const r of drop) imageIndex.delete(r.id);
      }
      queueSave(files.images, state.images);
      return rec;
    },

    getImage(id) {
      return imageIndex.get(String(id || '')) || null;
    },

    findImageByPath(p) {
      const key = path.resolve(String(p || ''));
      return state.images.find((r) => r.absPath && path.resolve(r.absPath) === key) || null;
    },

    /** 这条记录现在磁盘上还有没有文件（收藏副本 / 回收站里的也算「有」）。 */
    imageFileAlive(rec) {
      if (!rec) return false;
      return fileAlive(rec.favoritedTo) || fileAlive(rec.absPath) || fileAlive(rec.recycledTo);
    },

    /** 给 <img> / 下载用的真实路径：优先收藏副本，其次原图，最后回收站里的那份。 */
    mediaPathOf(rec) {
      if (!rec) return '';
      for (const p of [rec.favoritedTo, rec.absPath, rec.recycledTo]) {
        if (p && fileAlive(p)) return p;
      }
      return '';
    },

    /** 「请求生成」替换旧图：取当前会话里所有还没进回收站的图片 id。 */
    sessionImageIds(sessionId) {
      const sid = String(sessionId || '');
      if (!sid) return [];
      return state.images
        .filter((r) => r && !r.deletedAt && String(r.sessionId || '') === sid)
        .map((r) => r.id);
    },

    /** 同一正文旧图：只替换正文文本完全相同的那些，不误伤同会话其它正文。 */
    bodyImageIds(sessionId, text) {
      const sid = String(sessionId || '');
      const body = cleanBodyText(text);
      if (!sid || !body) return [];
      return state.images
        .filter((r) => r && !r.deletedAt
          && String(r.sessionId || '') === sid
          // 旧记录里可能还带 @bubble 包装；两边都按正文规则归一后再比。
          && cleanBodyText(r.text || '') === body)
        .map((r) => r.id);
    },

    listImages({ page = 1, size = 24, sessionId = null, checkAlive = true } = {}) {
      // 只对当前页做文件存在检查：以前每次翻页都 stat 全库，图一多就卡。
      const visible = state.images.filter((r) => !r.deletedAt);
      const filtered = (sessionId ? visible.filter((r) => String(r.sessionId || '') === String(sessionId)) : visible).slice().reverse();
      const n = Math.max(1, Math.min(200, num(size, 24)));
      const p = Math.max(1, num(page, 1));
      const start = (p - 1) * n;
      const pageRows = filtered.slice(start, start + n);
      return {
        items: (checkAlive ? pageRows.filter((r) => api.imageFileAlive(r)) : pageRows).map(api.imageView),
        total: filtered.length,
        page: p,
        size: n,
        ghost: 0,
        dir: api.outputDir(),
      };
    },

    imageView(rec) {
      return {
        id: rec.id,
        // 原地替换（黑图补图 / 仅此图重新生成）会复用同一个图片 id；
        // 用 updatedAt 改 URL，避免浏览器 immutable 缓存继续显示旧图。
        url: `${ROUTE_PATH}/img/${rec.id}${rec.updatedAt ? `?v=${encodeURIComponent(rec.updatedAt)}` : ''}`,
        absPath: rec.absPath || '',
        fileName: rec.fileName || '',
        bytes: rec.bytes || 0,
        createdAt: rec.createdAt || '',
        updatedAt: rec.updatedAt || '',
        sessionId: rec.sessionId || '',
        sessionTitle: rec.sessionTitle || '',
        jobId: rec.jobId || '',
        title: rec.title || '',
        anchor: rec.anchor || '',
        turn: rec.turn ?? null,
        positive: rec.positive || '',
        negative: rec.negative || '',
        seed: rec.seed ?? null,
        setIndex: rec.setIndex ?? null,
        continuousShot: rec.continuousShot || null,
        favorited: !!rec.favoritedTo,
        recycled: !!rec.deletedAt,
        favoritedAt: rec.favoritedAt || '',
        deletedAt: rec.deletedAt || '',
      };
    },

    favoriteImage(id) {
      const rec = api.getImage(id);
      if (!rec) throw new HttpError(404, '图片记录不存在');
      if (rec.favoritedTo && fileAlive(rec.favoritedTo)) return { ok: true, already: true, rec };
      const src = api.mediaPathOf(rec);
      if (!src) throw new HttpError(404, '这张图的文件已经不在磁盘上了');
      const dst = uniquePath(api.favoriteDir(), path.basename(src));
      fs.copyFileSync(src, dst);
      rec.favoritedTo = dst;
      rec.favoritedAt = nowIso();
      save(files.images, state.images);
      clearAliveCache();
      return { ok: true, already: false, rec, to: dst };
    },

    unfavoriteImage(id) {
      const rec = api.getImage(id);
      if (!rec) throw new HttpError(404, '图片记录不存在');
      const copy = rec.favoritedTo;
      if (!copy) return { ok: true, already: true, rec };
      if (!isInside(api.favoriteDir(), copy)) throw new HttpError(400, '收藏副本不在收藏夹目录里，拒绝删除');
      try { fs.unlinkSync(copy); } catch { /* 已经没了也算成功 */ }
      rec.favoritedTo = '';
      rec.favoritedAt = '';
      save(files.images, state.images);
      clearAliveCache();
      return { ok: true, already: false, rec };
    },

    listFavorites({ page = 1, size = 60 } = {}) {
      // 同样只检查当前页，避免收藏多时每次翻页全量 stat。
      const favs = state.images.filter((r) => r.favoritedTo);
      const n = Math.max(1, Math.min(200, num(size, 60)));
      const p = Math.max(1, num(page, 1));
      const start = (p - 1) * n;
      const pageRows = favs.slice(start, start + n);
      return {
        items: pageRows.filter((r) => api.imageFileAlive(r)).map(api.imageView),
        total: favs.length,
        page: p,
        size: n,
        ghost: 0,
        dir: api.favoriteDir(),
      };
    },

    /**
     * 黑图补图 / 仅此图重新生成：把同一张图片记录原地换成新文件，不新增图片、
     * 不改 id / createdAt / 排序，所以图片框顺序和滚动切图锚点都不会乱。
     * 旧文件复制/移动到回收站，并单独留一条回收站记录。
     */
    replaceImageInPlace(id, patch = {}) {
      const rec = api.getImage(id);
      if (!rec) return null;
      let retired = null;
      const src = api.mediaPathOf(rec);
      if (src) {
        const chat = api.chatFolderName(rec.sessionId, rec.sessionTitle);
        const dst = uniquePath(path.join(api.recycleDir(), chat), path.basename(src));
        let moved = false;
        try {
          // 收藏副本要保留：从收藏副本复制到回收站，不把 _favorites 里的文件搬走。
          if (rec.favoritedTo && path.resolve(rec.favoritedTo) === path.resolve(src)) {
            fs.copyFileSync(src, dst);
          } else {
            moveFile(src, dst);
          }
          moved = true;
        } catch { /* 旧文件搬不动也不阻塞新图 */ }
        if (moved) {
          retired = {
            ...rec,
            id: uid('img_'),
            createdAt: nowIso(),
            updatedAt: nowIso(),
            absPath: '',
            recycledTo: dst,
            deletedAt: nowIso(),
            favoritedTo: '',
            favoritedAt: '',
          };
          state.images.push(retired);
          imageIndex.set(retired.id, retired);
        }
      }
      Object.assign(rec, patch || {});
      rec.deletedAt = '';
      rec.recycledTo = '';
      rec.updatedAt = nowIso();
      // 这张图如果收藏过，把收藏副本也换成新文件，避免收藏夹里仍是黑图。
      if (rec.favoritedTo && patch && patch.absPath) {
        try { fs.copyFileSync(patch.absPath, rec.favoritedTo); } catch { /* ignore */ }
      }
      save(files.images, state.images);
      clearAliveCache();
      return { rec, retired };
    },

    recycleImage(id, options = {}) {
      const rec = api.getImage(id);
      if (!rec) throw new HttpError(404, '图片记录不存在');
      if (rec.deletedAt) return { ok: true, already: true, rec };
      const preserveFavorite = options.preserveFavorite === true;
      let src = api.mediaPathOf(rec);
      if (!src) throw new HttpError(404, '这张图的文件已经不在磁盘上了');
      // 自动替换旧图时优先搬原图，收藏副本留在 _favorites 里；
      // 只有原图已经没了才复制收藏副本进回收站，绝不把收藏删掉。
      if (preserveFavorite && rec.favoritedTo) {
        if (rec.absPath && fileAlive(rec.absPath)) src = rec.absPath;
        else src = rec.favoritedTo;
      }
      const chat = api.chatFolderName(rec.sessionId, rec.sessionTitle);
      const dst = uniquePath(path.join(api.recycleDir(), chat), path.basename(src));
      if (preserveFavorite && rec.favoritedTo && path.resolve(rec.favoritedTo) === path.resolve(src)) {
        fs.copyFileSync(src, dst);
      } else {
        moveFile(src, dst);
      }
      rec.deletedAt = nowIso();
      rec.recycledTo = dst;
      if (rec.absPath && path.resolve(rec.absPath) === path.resolve(src)) rec.absPath = '';
      if (!preserveFavorite && rec.favoritedTo && path.resolve(rec.favoritedTo) === path.resolve(src)) rec.favoritedTo = '';
      save(files.images, state.images);
      clearAliveCache();
      return { ok: true, already: false, rec, from: src, to: dst };
    },

    restoreImage(id) {
      const rec = api.getImage(id);
      if (!rec) throw new HttpError(404, '图片记录不存在');
      if (!rec.deletedAt) return { ok: true, already: true, rec };
      const from = rec.recycledTo;
      if (!from || !fs.existsSync(from)) throw new HttpError(404, '回收站里那份文件已经不在了');
      const chat = api.chatFolderName(rec.sessionId, rec.sessionTitle);
      const dst = uniquePath(path.join(api.outputDir(), chat), path.basename(from));
      moveFile(from, dst);
      rec.absPath = dst;
      rec.deletedAt = '';
      rec.recycledTo = '';
      save(files.images, state.images);
      clearAliveCache();
      return { ok: true, rec, to: dst };
    },

    listRecycled() {
      const recs = state.images.filter((r) => r.deletedAt);
      return {
        total: recs.length,
        dir: api.recycleDir(),
        items: recs.map((r) => ({
          id: r.id, fileName: r.fileName, recycledTo: r.recycledTo || '', deletedAt: r.deletedAt,
          sessionId: r.sessionId || '', title: r.title || '',
        })),
      };
    },

    purgeRecycle() {
      const recs = state.images.filter((r) => r.deletedAt);
      let removed = 0;
      const failed = [];
      for (const rec of recs) {
        try {
          for (const p of [rec.recycledTo, rec.favoritedTo]) {
            if (!p) continue;
            if (!isInside(api.recycleDir(), p) && !isInside(api.favoriteDir(), p)) continue;
            try { fs.unlinkSync(p); } catch { /* 已不存在 */ }
          }
          const i = state.images.indexOf(rec);
          if (i >= 0) {
            state.images.splice(i, 1);
            imageIndex.delete(rec.id);
          }
          removed += 1;
        } catch (e) {
          failed.push({ id: rec.id, error: String(e?.message || e) });
        }
      }
      save(files.images, state.images);
      clearAliveCache();
      return { ok: failed.length === 0, removed, failed, total: recs.length };
    },

    /**
     * 列表和磁盘对一遍：只处理「有记录没文件」。
     * ★ 不动任何图片文件，只动 images.json / jobs.json。
     * favoritesOnly = 只检查收藏副本；副本丢了就清掉收藏标记，原图不动。
     */
    syncImagesWithDisk({ apply = false, favoritesOnly = false } = {}) {
      // 这是「和磁盘对一遍」，必须绕过缓存重新 stat
      clearAliveCache();
      if (favoritesOnly) {
        const marked = state.images.filter((r) => r.favoritedTo);
        const broken = marked.filter((r) => !fileAlive(r.favoritedTo));
        const ids = broken.map((r) => r.id);
        if (apply && ids.length) {
          for (const rec of broken) {
            rec.favoritedTo = '';
            rec.favoritedAt = '';
          }
          save(files.images, state.images);
        }
        return {
          apply,
          favorites: {
            checked: marked.length,
            before: marked.length,
            after: marked.length - (apply ? broken.length : 0),
            removed: broken.length,
            ids,
          },
          images: { before: state.images.length, after: state.images.length, removed: 0, ids: [] },
          jobs: { checked: 0, pruned: 0 },
        };
      }
      const dead = state.images.filter((r) => !r.deletedAt && !api.imageFileAlive(r));
      const deadIds = new Set(dead.map((r) => r.id));
      let pruned = 0;
      if (apply && deadIds.size) {
        state.images = state.images.filter((r) => !deadIds.has(r.id));
        imageIndex.clear();
        for (const r of state.images) imageIndex.set(r.id, r);
        for (const job of state.jobs) {
          if (!Array.isArray(job.images)) continue;
          const before = job.images.length;
          job.images = job.images.filter((im) => !deadIds.has(im.id));
          pruned += before - job.images.length;
        }
        save(files.images, state.images);
        save(files.jobs, state.jobs);
      }
      return {
        apply,
        images: {
          before: state.images.length + (apply ? deadIds.size : 0),
          after: state.images.length,
          removed: apply ? deadIds.size : dead.length,
          ids: [...deadIds],
        },
        jobs: { checked: state.jobs.length, pruned },
      };
    },

    /**
     * 清空某个会话的原文锚点，让跟图回退到「按当前会话区域比例分配」。
     * 只动这个会话自己的图片和任务，别的会话不受影响。
     */
    clearImageAnchors(sessionId = '') {
      const sid = String(sessionId || '').trim();
      if (!sid) return { images: 0, jobs: 0, sessionId: '' };
      let images = 0;
      let jobs = 0;
      const clearedJobIds = new Set();
      for (const rec of state.images) {
        if (!rec || String(rec.sessionId || '') !== sid) continue;
        // 任务 id 先收齐：图片之前已经清过、任务 sets 里还留着锚点时，
        // 也要把任务一起标记，避免重启后又被回填。
        if (rec.jobId) clearedJobIds.add(String(rec.jobId));
        if (rec.anchor) {
          rec.anchor = '';
          images += 1;
        }
      }
      for (const job of state.jobs) {
        const jobId = String(job.id || '');
        const mine = clearedJobIds.has(jobId) || String(job.ownerSessionId || '') === sid;
        if (!mine) continue;
        let changed = false;
        if (Array.isArray(job.sets)) {
          for (const set of job.sets) {
            if (set && set.anchor) { set.anchor = ''; changed = true; }
          }
        }
        if (Array.isArray(job.images)) {
          for (const im of job.images) {
            if (im && im.anchor) { im.anchor = ''; changed = true; }
          }
        }
        if (changed || clearedJobIds.has(jobId)) {
          // 重启时不要再用 replyText 把锚点回填回来。
          job.anchorCleared = true;
          jobs += 1;
        }
      }
      if (images) save(files.images, state.images);
      if (jobs) save(files.jobs, state.jobs);
      return { images, jobs, sessionId: sid };
    },

    deleteImage(id) {
      const i = state.images.findIndex((r) => r.id === String(id || ''));
      if (i < 0) return false;
      state.images.splice(i, 1);
      imageIndex.delete(String(id || ''));
      save(files.images, state.images);
      clearAliveCache();
      return true;
    },

    /* ------------------------------- 任务 ------------------------------- */

    addJob(job) {
      state.jobs.push(job);
      if (state.jobs.length > JOBS_LIMIT) state.jobs = state.jobs.slice(-JOBS_LIMIT);
      // 老任务的正文/回复只留预览，避免 jobs.json 越写越大（sets 保留，重新生成还要用）
      const keepFull = 40;
      for (let i = 0; i < Math.max(0, state.jobs.length - keepFull); i += 1) {
        const j = state.jobs[i];
        if (typeof j.text === 'string' && j.text.length > 400) j.text = j.text.slice(0, 400);
        if (typeof j.replyText === 'string' && j.replyText.length > 800) j.replyText = j.replyText.slice(0, 800);
      }
      api.saveJobs();
      return job;
    },

    saveJobs() { queueSave(files.jobs, state.jobs); return true; },

    /** 立即把挂起的 jobs/images 写盘（卸载 / 用户动作后调用）。 */
    flush() { flush(); },

    /** 手动清活文件缓存（测试用）。 */
    clearAliveCache() { clearAliveCache(); },

    getJob(id) {
      return state.jobs.find((j) => j.id === String(id || '')) || null;
    },

    listJobs(limit = 50) {
      const n = Math.max(1, Math.min(JOBS_LIMIT, num(limit, 50)));
      return state.jobs.slice(-n).reverse();
    },

    deleteJob(id) {
      const i = state.jobs.findIndex((j) => j.id === String(id || ''));
      if (i < 0) return false;
      state.jobs.splice(i, 1);
      api.saveJobs();
      return true;
    },

    clearJobs({ keepActive = true } = {}) {
      state.jobs = keepActive
        ? state.jobs.filter((j) => ['queued', 'delivering', 'parsing', 'running'].includes(j.status))
        : [];
      api.saveJobs();
      return state.jobs;
    },

    /* ----------------------------- LoRA 名字 ----------------------------- */

    getLoraNames() { return state.loraNames; },
    setLoraNames(names) {
      state.loraNames = names && typeof names === 'object' && !Array.isArray(names) ? names : {};
      save(files.loraNames, state.loraNames);
      return state.loraNames;
    },

    /* ------------------------------ 维护 ------------------------------ */

    /** 启动清扫：桥重启后，磁盘上所有非终态任务都已经是幽灵了。 */
    sweepOrphanJobs() {
      const live = ['queued', 'delivering', 'parsing', 'running'];
      let n = 0;
      for (const job of state.jobs) {
        if (!live.includes(job.status)) continue;
        job.status = 'error';
        job.error = '桥重启过（或进程被中断），这个任务没有跑完，已经作废。重新点一次即可。';
        job.failedStage = job.failedStage || 'capture';
        job.finishedAt = nowIso();
        job.updatedAt = nowIso();
        n += 1;
      }
      if (n) api.saveJobs();
      return n;
    },
  };

  return api;
}
