import fs from 'node:fs';
import path from 'node:path';
import {
  applyOverrides,
  fetchImage,
  interrupt,
  pruneNodes,
  pruneUnreachable,
  queuePrompt,
  saveImageToDisk,
  scanOutputNodes,
  seedsOfWorkflow,
  waitForResult,
} from './comfy.js';
import { loraKey, resolveLoraState, scanLoraStacks } from './lora.js';
import { parseByRule } from './rule.js';
import { askTarget, cancelLocalSession, lastAssistantText, resolveSessionController, textOfMessage } from './session.js';
import { HttpError, cleanBodyText, nowIso, num, sanitizeName, uid } from './util.js';

export const STATUS = {
  QUEUED: 'queued',
  DELIVERING: 'delivering',
  PARSING: 'parsing',
  PROMPT_READY: 'prompt_ready',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

const LIVE = [STATUS.QUEUED, STATUS.DELIVERING, STATUS.PARSING, STATUS.RUNNING];

// 旧版本把「窗口里没看到投递正文」当成确认失败；这个启发式在 Tavern 等宿主
// 上会误报。任务视图里把旧记录中的这条警告过滤掉，新任务也不再写入。
const LEGACY_OWN_PROMPT_WARNING = '⚠ 这轮回复没法确认是你这次投递引起的（窗口里没出现投出去的正文）。先核对提示词再决定要不要出图。';
export const isLive = (status) => LIVE.includes(status);
const TERMINAL = [STATUS.DONE, STATUS.ERROR, STATUS.CANCELLED];

/**
 * 连续图：在「本来要出的那批」后面，把**最后一套**提示词按强度档位再出 M 张，
 * 这 M 张只有一条 LoRA 的强度不同。参数在配置 generation.continuous 里。
 */
function parseContinuousLora(raw) {
  const s = String(raw || '');
  const i = s.indexOf('::');
  if (i <= 0) return null;
  const nodeId = s.slice(0, i).trim();
  const name = s.slice(i + 2).trim();
  if (!nodeId || !name) return null;
  return { nodeId, name, key: `${nodeId}::${loraKey(name)}` };
}

export function continuousTarget(wf, cfg) {
  const c = cfg.generation.continuous || {};
  const strengths = (Array.isArray(c.strengths) ? c.strengths : [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!strengths.length) return { skipped: '一档强度都没填' };
  const lora = parseContinuousLora(c.lora);
  if (!lora) return { skipped: '没有选 LoRA' };
  const { stacks } = scanLoraStacks(wf && wf.json);
  const st = stacks.find((s) => String(s.nodeId) === lora.nodeId);
  if (!st) return { skipped: `这个 LoRA 节点（#${lora.nodeId}）不在当前工作流里` };
  if (!st.entries.some((e) => loraKey(e.name) === loraKey(lora.name))) {
    return { skipped: `当前工作流里没有「${lora.name}」这条 LoRA` };
  }
  return { nodeId: lora.nodeId, name: lora.name, key: lora.key, count: strengths.length, strengths };
}

/** 连续图的这一张：在本来要用的那份 LoRA 开关上，只改选中那条的强度。
 *  支持 LoRA 堆、单 LoRA、Power / Stacker / Tag 节点；导出给离线自检。 */
export function withLoraStrength(wf, base, shot) {
  if (!shot || !shot.nodeId) return base;
  const key = loraKey(shot.name);
  const state = base && typeof base === 'object' && !Array.isArray(base)
    ? { stacks: { ...(base.stacks || {}) }, switches: { ...(base.switches || {}) } }
    : { stacks: {}, switches: {} };
  let rows = Array.isArray(state.stacks[shot.nodeId])
    ? state.stacks[shot.nodeId].map((r) => ({ ...r }))
    : null;
  if (!rows || !rows.length) {
    const { stacks } = scanLoraStacks(wf && wf.json);
    const st = stacks.find((s) => String(s.nodeId) === String(shot.nodeId));
    if (!st) return base;
    rows = st.entries.map((e) => ({
      name: e.name,
      on: e.active === true,
      strength: num(e.strength, 1),
      clip: num(e.clipStrength, num(e.strength, 1)),
    }));
  }
  const row = rows.find((r) => loraKey(r.name) === key);
  if (!row) return base;
  row.on = true; // 关着的 LoRA 换强度看不出区别
  row.strength = shot.strength;
  row.clip = shot.strength;
  state.stacks[shot.nodeId] = rows;
  return state;
}

/**
 * 任务引擎。依赖都从外面传进来，方便离线测试：
 *   { ctx, sc, store, hub, getConfig, version }
 */
export function createJobsEngine({ ctx, sc, store, hub, getConfig, getActiveSessionId }) {
  const controllers = new Map();
  const seen = new Map(); // `${sessionId}:${seq}` -> at
  let activeSessionProvider = typeof getActiveSessionId === 'function' ? getActiveSessionId : () => '';
  let activeSessionTitleProvider = () => '';
  const currentOwnerSession = () => {
    try { return String(activeSessionProvider() || ''); } catch { return ''; }
  };
  const currentOwnerTitle = () => {
    try { return String(activeSessionTitleProvider() || ''); } catch { return ''; }
  };
  const setActiveSessionProvider = (fn, titleFn) => {
    if (typeof fn === 'function') activeSessionProvider = fn;
    if (typeof titleFn === 'function') activeSessionTitleProvider = titleFn;
  };
  const debounce = new Map(); // sessionId -> { timer, entry }
  const CLIENT_ID = `airp_${Math.random().toString(36).slice(2)}`;

  const log = (level, message, extra = {}) => hub.pushLog(level, message, extra);
  const broadcast = (type, payload) => hub.broadcast(type, payload);

  /* 任务事件节流：一次出图会连续改状态 / 挂图，每次广播整份任务没必要。
   * 120ms 合并一次；终态强制立刻发（别让「完成」被节流吞掉）。 */
  const bcastAt = new Map();
  const bcastTimer = new Map();
  function broadcastJob(job, force = false) {
    const now = Date.now();
    const last = bcastAt.get(job.id) || 0;
    const fire = () => {
      bcastAt.set(job.id, Date.now());
      broadcast('job', api.jobView(job, { compact: true }));
    };
    if (force) {
      const t = bcastTimer.get(job.id);
      if (t) { clearTimeout(t); bcastTimer.delete(job.id); }
      fire();
      return;
    }
    if (now - last >= 120) { fire(); return; }
    if (bcastTimer.has(job.id)) return;
    const timer = setTimeout(() => {
      bcastTimer.delete(job.id);
      fire();
    }, 130);
    if (typeof timer.unref === 'function') timer.unref();
    bcastTimer.set(job.id, timer);
  }

  function controllerFor(job) {
    let c = controllers.get(job.id);
    if (!c) {
      c = new AbortController();
      controllers.set(job.id, c);
    }
    return c;
  }

  function release(job) {
    controllers.delete(job.id);
  }

  function touch(job, status, extra = {}) {
    job.status = status;
    job.updatedAt = nowIso();
    Object.assign(job, extra);
    broadcastJob(job, TERMINAL.includes(status));
    return job;
  }

  function addWarn(job, msg) {
    job.warn = job.warn ? `${job.warn}　${msg}` : msg;
    log('warn', `任务 ${job.id}：${msg}`, { jobId: job.id });
  }

  function fail(job, err, stage) {
    if (TERMINAL.includes(job.status)) return job;
    job.error = err?.message || String(err);
    job.failedStage = stage || job.failedStage || 'unknown';
    job.errorCode = (err && (err.status || err.code)) || null;
    job.finishedAt = nowIso();
    touch(job, STATUS.ERROR);
    release(job);
    store.saveJobs();
    log('error', `任务 ${job.id} 失败：${job.error}`, { jobId: job.id });
    return job;
  }

  function cancelled(job, reason = '已被手动终止') {
    if (TERMINAL.includes(job.status)) return job;
    job.error = reason;
    job.finishedAt = nowIso();
    touch(job, STATUS.CANCELLED);
    release(job);
    store.saveJobs();
    log('warn', `任务 ${job.id} ${reason}`, { jobId: job.id });
    return job;
  }

  function createJob(input = {}) {
    const cfg = getConfig();
    const job = {
      id: uid('job_'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      source: input.source || 'capture', // capture | manual | ball | regen
      // text 始终是正文原文（图片归档 / 替换旧图 / 面板预览都用它）；
      // outgoingText 才是真正投给桥会话的完整消息（基础消息 + 包裹后的正文 / 要求）。
      // @bubble 这类渲染指令不属于正文，统一在这里去掉包装。
      text: cleanBodyText(input.text ?? ''),
      outgoingText: '',
      bridgeInstruction: String(input.bridgeInstruction || ''),
      bridgeExtra: String(input.bridgeExtra || ''),
      regenIndex: input.regenIndex === null || input.regenIndex === undefined
        ? 0 : Math.max(0, Number(input.regenIndex) || 0),
      sourceSessionId: String(input.sourceSessionId || ''),
      sourceSessionTitle: String(input.sourceSessionTitle || ''),
      // 生成这一轮正文时 DSH 的 turn 号；用于把图片绑到会话轮次，旧任务为 null。
      sourceTurn: (input.sourceTurn === null || input.sourceTurn === undefined || input.sourceTurn === '')
        ? null
        : (Number.isFinite(Number(input.sourceTurn)) ? Number(input.sourceTurn) : null),
      // 图片归档到「生图时所在的聊天」，不看正文来源。
      ownerSessionId: String(input.ownerSessionId || currentOwnerSession() || input.sourceSessionId || ''),
      ownerSessionTitle: String(input.ownerSessionTitle || currentOwnerTitle() || input.sourceSessionTitle || cfg.target.title || ''),
      sourceSeq: input.sourceSeq ?? null,
      targetSessionId: String(input.targetSessionId || cfg.target.sessionId || ''),
      targetTitle: String(input.targetTitle || cfg.target.title || ''),
      targetMode: cfg.target.mode,
      status: STATUS.QUEUED,
      stage: '',
      error: null,
      failedStage: '',
      errorCode: null,
      warn: '',
      replyText: '',
      deliveryMs: null,
      sawOwnPrompt: null,
      interrupted: false,
      ruleId: '',
      issues: [],
      sets: [],
      positive: '',
      negative: '',
      imageCount: Math.max(1, Math.min(3, num(input.imageCount, cfg.generation.imageCount))),
      countMode: input.countMode || 'fixed',
      expectCount: null,
      continuous: input.continuous === true,
      continuousInfo: null,
      continuousOverride: input.continuousOverride && typeof input.continuousOverride === 'object'
        ? input.continuousOverride : null,
      workflowId: input.workflowId || cfg.workflowId,
      workflowName: '',
      images: [],
      comfyPromptId: null,
      comfyMs: null,
      totalMs: null,
      overrideReport: null,
      parseWarn: '',
      promptSource: '',
      autoGenerate: input.autoGenerate !== false,
      // 图片框的两种替换语义：
      //   replaceImageId = 重新生成当前这张，成功后只回收这一张；
      //   replaceOld = 请求生成 / 全部重生成，成功后回收「同一正文」的旧图。
      // replaceText 是正文原文：桥消息里会带基础消息 / 指令，不能拿它去匹配旧图。
      replaceImageId: String(input.replaceImageId || ''),
      replaceImageIds: Array.isArray(input.replaceImageIds)
        ? input.replaceImageIds.map((id) => String(id || '')).filter(Boolean)
        : [],
      replaceOld: input.replaceOld === true,
      replaceText: cleanBodyText(input.replaceText || ''),
      replaceOldIds: [],
      maxSets: input.maxSets === null || input.maxSets === undefined ? null : Number(input.maxSets),
      regenMode: String(input.regenMode || ''),
      reusedFrom: String(input.reusedFrom || ''),
      forceRandomSeed: false,
    };
    controllerFor(job);
    store.addJob(job);
    broadcastJob(job, true);
    log('info', `任务 ${job.id} 建立（${job.source}，正文 ${job.text.length} 字）`, { jobId: job.id });
    return job;
  }

  /* ----------------------------- 捕获去抖 ----------------------------- */

  /**
   * 一轮里模型可能被调用多次（工具调用），每次都落一条 assistant/message。
   * 只取「最后一条」：新消息来了就把旧的定时器顶掉，900ms 内没有更新才投递。
   */
  function handleCaptured(entry) {
    const cfg = getConfig();
    if (!cfg.capture.autoForward) return;
    const sid = String(entry.sessionId || '');
    const text = String(entry.text || '').trim();
    if (!sid || text.length < cfg.capture.minChars) return;
    if (cfg.capture.ignoreTargetSession
      && sid === String(cfg.target.sessionId || '')
      && cfg.target.mode === 'local') return;

    const key = `${sid}:${entry.seq}`;
    if (seen.has(key)) return;
    seen.set(key, Date.now());
    while (seen.size > 800) seen.delete(seen.keys().next().value);

    const prev = debounce.get(sid);
    if (prev?.timer) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      debounce.delete(sid);
      const latest = prev?.entry && prev.entry.seq >= entry.seq ? prev.entry : entry;
      const job = createJob({
        source: 'capture',
        text: latest.text,
        sourceSessionId: sid,
        sourceSeq: latest.seq,
        sourceTurn: latest.turn,
        sourceSessionTitle: latest.title || '',
        autoGenerate: getConfig().capture.autoGenerate,
      });
      runJob(job).catch((e) => fail(job, e, 'capture'));
    }, 900);
    if (typeof timer.unref === 'function') timer.unref();
    debounce.set(sid, { timer, entry: { ...entry, text } });
    log('info', `捕获到助手回复（seq=${entry.seq}，${text.length} 字），900ms 后投递`, { sessionId: sid });
  }

  function flushCapture(sessionId) {
    const p = debounce.get(String(sessionId || ''));
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    debounce.delete(String(sessionId || ''));
    const latest = p.entry;
    const job = createJob({
      source: 'capture',
      text: latest.text,
      sourceSessionId: latest.sessionId,
      sourceSeq: latest.seq,
      sourceTurn: latest.turn,
      sourceSessionTitle: latest.title || '',
      autoGenerate: getConfig().capture.autoGenerate,
    });
    runJob(job).catch((e) => fail(job, e, 'capture'));
    return true;
  }

  /* ----------------------------- 投递 + 解析 ----------------------------- */

  async function runJob(job, { sets = null } = {}) {
    const cfg = getConfig();
    if (TERMINAL.includes(job.status)) return job;
    const ac = controllerFor(job);
    const t0 = Date.now();

    // 源会话和桥会话是同一个 → 会自己投自己，只在「真的要投递」时拦住。
    // 工作台手动生图（sets 已经给好）不往会话里投任何东西，只是用同一会话里
    // 提取的提示词直接出图：同一个会话既是提示词来源又是正文来源也不冲突。
    const willDeliver = !sets || !sets.length;
    if (willDeliver
      && cfg.capture.ignoreTargetSession
      && cfg.target.mode === 'local'
      && job.sourceSessionId
      && job.sourceSessionId === String(cfg.target.sessionId || '')) {
      return fail(job, new HttpError(400, '源会话和桥会话是同一个会话：投进去的正文会被自己再抓一遍，形成回环。请在设置里换一个。', 'loop'), 'deliver');
    }

    // 1) 投递
    if (!sets || !sets.length) {
      if (!String(job.text || '').trim()) return fail(job, new HttpError(400, '正文是空的，没有东西可以投递'), 'deliver');
      touch(job, STATUS.DELIVERING);
      const outgoingText = composeBridgeMessage(job, cfg.capture);
      job.outgoingText = outgoingText;
      log('info', `桥消息已组装：基础消息 + ${job.bridgeInstruction ? '包裹要求 + ' : ''}正文${String(cfg.capture.extraMessage || '').trim() ? ' + 侧边栏附加消息' : ''}（${outgoingText.length} 字）`, { jobId: job.id });
      try {
        const r = await askTarget({
          mode: cfg.target.mode,
          ctx,
          sc,
          baseUrl: cfg.target.baseUrl,
          routePath: cfg.target.routePath,
          token: cfg.target.token,
          sessionId: cfg.target.sessionId,
          text: outgoingText,
          timeoutMs: cfg.capture.timeoutMs,
          signal: ac.signal,
        });
        job.replyText = r.text;
        job.deliveryMs = r.ms;
        job.sawOwnPrompt = r.sawOwnPrompt;
        job.deliveryMode = r.deliveryMode || '';
        if (r.deliveryMode === 'steer') {
          // 目标会话当时不空闲（例如宿主在做自动续写），正文改成 steer 塞进当前这一轮；
          // 不用 queue 的话正文会排到下一轮，这一轮模型只看到时间上下文。
          log('warn', `目标会话忙，正文改用 steer 投递（等待空闲 ${r.idleWaited || 0}ms）`, { jobId: job.id });
        }
        job.interrupted = r.interrupted;
        job.targetSessionId = r.sessionId || job.targetSessionId;
        job.promptSource = r.mode;
        // 投递成功后按设置清空附加消息；失败 / 只解析不出图都不动它。
        if (cfg.capture.clearAfterSend !== false && String(cfg.capture.extraMessage || '').trim()) {
          cfg.capture.extraMessage = '';
          store.saveConfig();
          broadcast('state', { reason: 'extra-cleared' });
          log('info', '投递成功，附加消息已自动留空', { jobId: job.id });
        }
        if (r.sawOwnPrompt === false) {
          // 不当作失败：Tavern 等宿主会把程序化投递改写成另一条用户消息，
          // 这个启发式对不上不代表回复不是这一轮的。只留在任务字段里供排查。
          log('info', '事件窗口里没看到投递正文（宿主可能改写了用户消息）；按本轮 turn/end 继续', { jobId: job.id });
        }
        if (r.interrupted) addWarn(job, '⚠ 桥会话这一轮被中断过，取到的可能是半截回复。');
        log('info', `桥会话回复（${r.ms}ms，${r.text.length} 字）`, { jobId: job.id });
      } catch (e) {
        if (ac.signal.aborted) return cancelled(job);
        return fail(job, e, 'deliver');
      }
    } else {
      // 手动出图：调用方已经把提示词给过来了，不用再投递
      job.replyText = '';
      job.promptSource = 'manual';
    }

    // 2) 解析
    if (!sets || !sets.length) {
      touch(job, STATUS.PARSING);
      const ruleId = cfg.capture.matchRule;
      const parsed = parseByRule(ruleId, job.replyText, { customTags: cfg.capture.customTags });
      job.ruleId = parsed.ruleId || ruleId;
      job.issues = parsed.issues || [];
      job.parseWarn = job.issues.join('　');
      if (parsed.nonDelivery) {
        const head = String(job.replyText || '').replace(/\s+/g, ' ').slice(0, 160);
        const what = ruleId === 'all_text'
          ? '回复是空的，没有可当作正面提示词的内容。'
          : ruleId === 'custom_tags'
            ? '没有找到自定义的标题标签 / 字段名，无法按顺序切分。'
            : '整条回复里没有以圈码 ①–⑳ 开头的标题行，也没有 ```text 代码块。';
        const hint = ruleId === 'custom_tags'
          ? `\n处理办法：检查「提示词格式 → 匹配方式：自定义」里的标题闭合标签；或让桥会话按这套标签输出。`
          : ruleId === 'all_text'
            ? '\n处理办法：换一条有正文的回复，或换回「内置 / 自定义」匹配。'
            : '\n处理办法：确认桥会话是在按契约输出提示词；或换个桥会话。';
        return fail(job, new HttpError(502,
          `这不是一条可用的提示词回复：${what}`
          + `\n回复开头：${head}`
          + hint, 'non-delivery'), 'parse');
      }
      if (!parsed.sets || !parsed.sets.length) {
        return fail(job, new HttpError(502,
          `回复里没有取出可用的提示词（${job.issues[0] || '没有标题行 / 围栏'}）。`
          + `\n回复长度 ${String(job.replyText || '').length} 字符。`, 'no-sets'), 'parse');
      }
      const maxSets = Math.max(1, Math.min(3, job.maxSets !== null && job.maxSets !== undefined && Number.isFinite(Number(job.maxSets))
        ? Number(job.maxSets)
        : cfg.capture.maxSets));
      let picked = parsed.sets.slice(0, maxSets);
      if (parsed.sets.length > maxSets) {
        addWarn(job, `桥会话给了 ${parsed.sets.length} 套，按「最多匹配 ${maxSets} 套提示词」只取前 ${maxSets} 套；第 ${maxSets} 套就是连续图的最后一套。`);
      }
      if (parsed.issues.length) log('warn', `匹配：${picked.length} 套，${parsed.issues.length} 条偏差`, { jobId: job.id });
      job.sets = picked.map((s) => ({
        title: s.title || '',
        // ★ 自动流程也必须保留 anchor；少了这一行，图片记录永远是空锚点，
        //   工作台 / 滚动切图都只能退回百分比，表现就是“经常不换图”。
        anchor: s.anchor || '',
        size: s.size || null,
        tok: s.tok || null,
        seed: s.seed ?? null,
        tags: s.tags || '',
        nl: s.nl || '',
        positive: s.positive,
        negative: s.negative || '',
        issues: s.issues || [],
      }));
      job.expectCount = job.sets.length;
      job.positive = job.sets[0]?.positive || '';
      job.negative = job.sets[0]?.negative || '';
      job.imageCount = job.sets.length;
    } else {
      // 手动给的 sets：洗干净、限 3 套
      const clean = sets
        .map((s) => ({
          title: String(s?.title || '').trim(),
          anchor: String(s?.anchor || '').trim(),
          size: s?.size && Number(s.size.w) > 0 && Number(s.size.h) > 0
            ? { w: Number(s.size.w), h: Number(s.size.h) } : null,
          positive: String(s?.positive || '').trim(),
          negative: String(s?.negative || '').trim(),
          tags: String(s?.tags || ''),
          nl: String(s?.nl || ''),
          issues: [],
          continuousShot: s?.continuousShot || null,
        }))
        .filter((s) => s.positive)
        .slice(0, 3);
      if (!clean.length) return fail(job, new HttpError(400, '没有正面提示词，无法出图'), 'parse');
      job.sets = clean;
      job.expectCount = clean.length;
      job.positive = clean[0].positive;
      job.negative = clean[0].negative;
      job.imageCount = clean.length;
      job.ruleId = 'manual';
    }

    // 3) 要不要直接出图
    if (job.autoGenerate === false) {
      touch(job, STATUS.PROMPT_READY);
      store.saveJobs();
      log('info', `提示词已就绪（${job.sets.length} 套），等手动出图`, { jobId: job.id });
      return job;
    }
    return runComfy(job, { rerollSeeds: false, t0 });
  }

  /* ------------------------------- 出图 ------------------------------- */

  /**
   * 通过桥发出去的消息统一在这里组装，保证：
   *   · 永远有一条「基础消息」说明这次要生成 / 重新生成几套；
   *   · 正文和自动附带的要求（重新生成要求 / 额外要求）用【】简单包裹；
   *   · 侧边栏的「附加消息」是用户自己写的，按原样放在最上面 / 最下面，不包裹。
   */
  function wrapBridgeField(name, value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return `【${name}】\n${text}\n【/${name}】`;
  }

  function bridgeSetCount(job, captureCfg = {}) {
    const raw = job.maxSets !== null && job.maxSets !== undefined && Number.isFinite(Number(job.maxSets))
      ? Number(job.maxSets)
      : Number(captureCfg.maxSets);
    return Math.max(1, Math.min(3, Number.isFinite(raw) && raw > 0 ? raw : 1));
  }

  function bridgeBaseMessage(job, captureCfg = {}) {
    const count = bridgeSetCount(job, captureCfg);
    let task = `根据下面的正文，生成 ${count} 套提示词`;
    if (job.regenMode === 'single') {
      task = `根据下面的正文，重新生成第 ${job.regenIndex || 1} 张图的提示词（1 套）`;
    } else if (job.regenMode === 'all') {
      task = `根据下面的正文，重新生成本轮全部 ${count} 张图的提示词（${count} 套）`;
    }
    return `【基础消息】请按提示词输出格式要求，${task}。只输出提示词，不要解释。`;
  }

  function composeBridgeMessage(job, captureCfg = {}) {
    const body = String(job.text ?? '').trim();
    const instruction = String(job.bridgeInstruction || '').trim();
    const extra = String(job.bridgeExtra || '').trim();
    const sidebarExtra = String(captureCfg.extraMessage || '').trim();
    const extraAtBottom = captureCfg.extraPosition === 'bottom';
    const parts = [bridgeBaseMessage(job, captureCfg)];
    // 侧边栏附加消息：用户自己控制格式，保持原样，不套【】。
    if (sidebarExtra && !extraAtBottom) parts.push(sidebarExtra);
    parts.push(wrapBridgeField('正文', body));
    if (instruction) parts.push(wrapBridgeField('重新生成要求', instruction));
    if (extra) parts.push(wrapBridgeField('额外要求', extra));
    if (sidebarExtra && extraAtBottom) parts.push(sidebarExtra);
    return parts.filter(Boolean).join('\n\n');
  }

  function resolveSize(wf, set) {
    const auto = set?.size && Number(set.size.w) > 0 && Number(set.size.h) > 0
      ? { w: Number(set.size.w), h: Number(set.size.h) } : null;
    const manual = wf.size && Number(wf.size.w) > 0 && Number(wf.size.h) > 0
      ? { w: Number(wf.size.w), h: Number(wf.size.h) } : null;
    if (wf.sizeMode === 'dsh') {
      if (auto) return { size: auto, source: 'dsh' };
      if (manual) return { size: manual, source: 'manual' };
      return { size: null, source: '' };
    }
    if (manual) return { size: manual, source: 'manual' };
    if (auto) return { size: auto, source: 'set' };
    return { size: null, source: '' };
  }

  function prepare(wf, set, job = null) {
    const { size, source } = resolveSize(wf, set);
    const { workflow, report } = applyOverrides(wf.json, {
      positive: set.positive,
      negative: String(set.negative || ''),
      mapping: wf.mapping || {},
      tokenEmpty: 'blank',
      randomSeed: job?.forceRandomSeed === true || wf.randomSeed !== false,
      seed: wf.seed === null || wf.seed === undefined ? null : Number(wf.seed),
      loraState: set.continuousShot
        ? withLoraStrength(wf, resolveLoraState(wf), set.continuousShot)
        : resolveLoraState(wf),
      size,
      sizeSource: source,
    });
    if (report.size && report.size.leftover.length) {
      const where = [...new Set(report.size.leftover.map((l) =>
        `#${l.nodeId}${l.field !== '(本身)' ? `.${l.field}` : ''}（${l.token}）`))].slice(0, 6);
      throw new HttpError(400,
        `工作流里的分辨率占位符没被替换：${where.join('、')}。这次没拿到分辨率 —— ${
          wf.sizeMode === 'dsh'
            ? '「听从 DSH 会话」开着，但这一组没有 size 行，工作流页的宽高也是空的。'
            : '工作流页的宽高是空的。'
        }`, 'size-missing');
    }

    // 输出节点：保留勾选的，能删就删，删不掉退化为过滤
    const keep = Array.isArray(wf.outputNodes) ? wf.outputNodes.filter(Boolean) : [];
    const filter = { keep, onlyFirst: true, prune: wf.pruneOutputs !== false };
    let built = workflow;
    if (keep.length) {
      const drop = scanOutputNodes(workflow).map((n) => n.id).filter((id) => !keep.includes(id));
      filter.drop = drop;
      if (drop.length && wf.pruneOutputs !== false) {
        const pruned = pruneNodes(workflow, drop);
        built = pruned.workflow;
        filter.pruned = pruned.removed;
        filter.blocked = pruned.blocked;
      }
      if (wf.pruneOutputs !== false) {
        // 导出工作流里常有孤立节点（例如没接线的 KSampler）；ComfyUI 会校验所有
        // 节点，这类节点会让整单被拒。只保留从勾选输出能走到的依赖。
        const reachable = pruneUnreachable(built, keep);
        built = reachable.workflow;
        if (reachable.removed.length) filter.dead = reachable.removed;
      }
    }
    report.outputFilter = filter;
    return { workflow: built, report };
  }

  async function runComfy(job, { rerollSeeds = false, t0 = Date.now() } = {}) {
    const cfg = getConfig();
    const wf = store.getWorkflow(job.workflowId || cfg.workflowId);
    if (!wf) return fail(job, new HttpError(400, '没有选中 ComfyUI 工作流，请先到「工作流」页导入并启用一个。'), 'comfy');
    job.workflowId = wf.id;
    job.workflowName = wf.name || '';

    const ac = controllerFor(job);
    let runSets = Array.isArray(job.sets) ? job.sets.filter((s) => s && s.positive) : [];
    if (!runSets.length) return fail(job, new HttpError(400, '正面提示词为空，无法出图'), 'comfy');

    /* 「不设置张数」：手动出图时把第一套重复 N 次（不同种子） */
    if (job.countMode === 'auto' && runSets.length === 1) {
      const n = Math.max(1, Math.min(cfg.capture.maxImages || 3, num(job.imageCount, 1)));
      const first = runSets[0];
      runSets = Array.from({ length: n }, () => ({ ...first, repeated: true }));
      job.sets = runSets;
      job.expectCount = n;
    }

    /* 连续图：最后一套换成 M 张（只换一条 LoRA 的强度）。
       job.sets 已在解析阶段按 maxSets 截断，所以这里最后一套就是「最多匹配几套」的第 N 套。 */
    if (job.continuous === true) {
      const plan = continuousTarget(wf, cfg);
      if (plan.skipped) {
        addWarn(job, `「连续图」这次没生效：${plan.skipped}，按普通出图`);
      } else {
        const baseIdx = runSets.length - 1;
        const base = runSets[baseIdx];
        const shots = Array.from({ length: plan.count }, (_, i) => ({
          ...base,
          continuousShot: {
            nodeId: plan.nodeId,
            name: plan.name,
            strength: plan.strengths[i],
            index: i + 1,
            total: plan.count,
          },
        }));
        runSets = [...runSets.slice(0, baseIdx), ...shots];
        job.expectCount = baseIdx + plan.count;
        job.continuousInfo = {
          lora: plan.key, loraName: plan.name, nodeId: plan.nodeId,
          count: plan.count, strengths: plan.strengths,
          baseSets: baseIdx, expect: baseIdx + plan.count, mode: 'append',
        };
        log('info', `连续图：前 ${baseIdx} 套照旧，最后一套再按档位出 ${plan.count} 张（${plan.strengths.join(' / ')}）`, { jobId: job.id });
      }
    }
    // 连续图整组重生成：桥会话只回一套新提示词，按原组张数 / 强度展开成 N 张。
    if (job.continuousOverride) {
      const co = job.continuousOverride;
      const count = Math.max(0, Math.min(20, Number(co.count) || 0));
      const strengths = Array.isArray(co.strengths) ? co.strengths : [];
      if (count > 1 && runSets.length) {
        const base = runSets[runSets.length - 1];
        runSets = Array.from({ length: count }, (_, i) => ({
          ...base,
          continuousShot: {
            nodeId: co.nodeId || '',
            name: co.name || '',
            strength: strengths[i] === undefined || strengths[i] === null ? 1 : Number(strengths[i]),
            index: i + 1,
            total: count,
          },
        }));
        job.expectCount = count;
        job.continuousInfo = {
          mode: 'replace', nodeId: co.nodeId || '', loraName: co.name || '',
          count, strengths, baseSets: 0, expect: count,
        };
        log('info', `连续图整组重生成：按原 ${count} 档强度展开`, { jobId: job.id });
      }
    }
    job.sets = runSets;
    job.positive = runSets[0].positive;
    job.negative = runSets[0].negative || '';

    touch(job, STATUS.RUNNING, { comfyMs: null });

    const ownerSessionId = job.ownerSessionId || job.sourceSessionId || job.targetSessionId || 'console';
    const ownerSessionTitle = job.ownerSessionTitle || job.sourceSessionTitle || job.targetTitle || '';
    // 在写入新图之前记下旧图，生成结束后再回收；这样「请求生成」和
    // 「重新生成当前图」都不会把刚生成的新图误回收。
    if (job.replaceOld) {
      const body = job.replaceText || job.text;
      job.replaceOldIds = body
        ? store.bodyImageIds(ownerSessionId, body)
        : store.sessionImageIds(ownerSessionId);
    } else if (Array.isArray(job.replaceImageIds) && job.replaceImageIds.length) {
      // 连续图整组替换：先记下这一组，生成完只替换这些位置；多出来的旧图按「只会少」回收。
      job.replaceOldIds = job.replaceImageIds.slice();
    } else if (job.replaceImageId) {
      job.replaceOldIds = [job.replaceImageId];
    }
    const chat = store.chatFolderName(ownerSessionId, ownerSessionTitle);
    const chatDir = store.outputSubdir(chat);
    store.stampChatFolder(chatDir, ownerSessionId, ownerSessionTitle);
    const dir = chatDir;
    fs.mkdirSync(dir, { recursive: true });

    const prefix = sanitizeName('art', 'art');
    const saved = [];
    // 仅此图 / 黑图补图：原地替换同一张图片记录，不新增图片 / 新 id / 新排序。
    // 「本轮全部」仍然生成一组新图，只有按单张替换才保留原位置。
    const manualInPlace = job.regenMode === 'single' || job.regenMode === 'reuse' || job.regenMode === 'continuous';
    const replaceInPlaceIds = Array.isArray(job.replaceImageIds)
      ? job.replaceImageIds.map((id) => String(id || '')).filter(Boolean)
      : [];
    const singleInPlaceId = job.replaceImageId
      && (job.regenMode === 'auto' || manualInPlace)
      ? String(job.replaceImageId)
      : '';
    let inPlaceOldJobId = '';
    const comfyT0 = Date.now();

    const runOne = async (set, index) => {
      const inPlaceId = replaceInPlaceIds[index] || singleInPlaceId;
      inPlaceOldJobId = '';
      const prepared = prepare(wf, set, job);
      const wfN = prepared.workflow;
      if (index === 0) job.overrideReport = prepared.report;
      const usedSeeds = seedsOfWorkflow(wfN);
      // 把这一轮实际用的种子记到工作流上：工作流页「固定种子」那一栏在自动模式下
      // 显示的就是它，用户看到满意的一张可以直接取消自动、把这颗种子固定下来。
      if (index === 0 && wf.id && usedSeeds.length) {
        try { store.patchWorkflow(wf.id, { lastSeed: usedSeeds[0].value }); } catch { /* 记录失败不影响出图 */ }
      }
      if (runSets.length > 1) log('info', `第 ${index + 1}/${runSets.length} 套：排队提交`, { jobId: job.id });
      const { promptId } = await queuePrompt(cfg.comfy.baseUrl, wfN, CLIENT_ID);
      job.comfyPromptId = promptId;
      broadcastJob(job);
      log('info', `已提交 ComfyUI${runSets.length > 1 ? `（第 ${index + 1} 套）` : ''}：${promptId}`, { jobId: job.id });

      const { images: rawImages } = await waitForResult(cfg.comfy.baseUrl, promptId, {
        timeoutMs: num(cfg.comfy.timeoutMs, 300000),
        pollIntervalMs: num(cfg.comfy.pollIntervalMs, 1200),
        signal: ac.signal,
      });
      if (ac.signal.aborted) throw new Error('已终止');

      const keep = Array.isArray(wf.outputNodes) ? wf.outputNodes.filter(Boolean) : [];
      let images = [...rawImages].sort((a, b) =>
        (a.type === 'temp' ? 1 : 0) - (b.type === 'temp' ? 1 : 0)
        || String(a.nodeId).localeCompare(String(b.nodeId), 'en', { numeric: true }));
      if (keep.length) {
        const filtered = images.filter((i) => keep.includes(i.nodeId));
        if (filtered.length) images = filtered;
        else log('warn', `按输出节点过滤后没有图片（保留的是 ${keep.join(', ')}），改为全部保留`, { jobId: job.id });
      }
      // 「兜底只返回第一张」已固定开启（原开关删除）：一套提示词只保留第一张。
      if (images.length > 1) images = images.slice(0, 1);

      for (const img of images) {
        const { buffer } = await fetchImage(cfg.comfy.baseUrl, img);
        const full = saveImageToDisk({ buffer, dir, fileName: img.filename, prefix });
        // 只有正文来源 == 图片归属会话时，turn 才是这个会话里的轮次；
        // 从别的会话提取提示词时 turn 会指错会话，宁可不写。
        const sameSource = !job.sourceSessionId || String(job.sourceSessionId) === String(ownerSessionId);
        const imageTitle = set.continuousShot
          ? [set.title, `连续 ${set.continuousShot.index}/${set.continuousShot.total} · 强度 ${set.continuousShot.strength}`]
            .filter(Boolean).join(' · ')
          : (set.title || '');
        const imageSeed = usedSeeds.length ? usedSeeds[0].value : null;
        const imageSeeds = usedSeeds.map((s) => ({ nodeId: s.nodeId, inputKey: s.inputKey, value: s.value }));
        let rec = null;
        let retired = null;
        if (inPlaceId) {
          const old = store.getImage(inPlaceId);
          if (old) {
            inPlaceOldJobId = old.jobId || '';
            const patch = {
              fileName: path.basename(full),
              absPath: full,
              bytes: buffer.length,
              nodeId: img.nodeId,
              comfyFilename: img.filename,
              subfolder: img.subfolder || '',
              comfyType: img.type || 'output',
              positive: set.positive,
              negative: set.negative || '',
              seed: imageSeed,
              seeds: imageSeeds,
              title: imageTitle || old.title,
              text: job.replaceText || job.text || old.text || '',
              anchor: set.anchor || (manualInPlace ? '' : (old.anchor || '')),
              turn: sameSource ? job.sourceTurn : (manualInPlace ? null : (old.turn ?? null)),
              continuousShot: set.continuousShot || (manualInPlace ? null : (old.continuousShot || null)),
            };
            // 手动「仅此图」换的是新提示词 / 新正文，记录要指向新任务；
            // createdAt 保持不变，所以图片顺序和滚动位置不跳。
            if (manualInPlace) {
              patch.jobId = job.id;
              // 新任务只有这一套；setIndex 归 0 才能继续「仅此图」重生成。
              // 图片框顺序靠 createdAt，不受 setIndex 影响。
              patch.setIndex = index;
            }
            const out = store.replaceImageInPlace(inPlaceId, patch);
            rec = out && out.rec;
            retired = out && out.retired;
          }
        }
        if (!rec) {
          rec = store.addImage({
            jobId: job.id,
            sessionId: ownerSessionId,
            sessionTitle: ownerSessionTitle,
            seq: job.sourceSeq,
            turn: sameSource ? job.sourceTurn : null,
            anchor: set.anchor || '',
            fileName: path.basename(full),
            absPath: full,
            bytes: buffer.length,
            nodeId: img.nodeId,
            comfyFilename: img.filename,
            subfolder: img.subfolder || '',
            comfyType: img.type || 'output',
            positive: set.positive,
            negative: set.negative || '',
            // 图片归属的正文原文（regenerate 的 job.text 带「重新生成…」指令，不能存成正文）
            text: job.replaceText || job.text,
            setIndex: index,
            title: imageTitle,
            seed: imageSeed,
            seeds: imageSeeds,
            continuousShot: set.continuousShot || null,
          });
        }
        saved.push({
          id: rec.id,
          jobId: job.id,
          path: full,
          fileName: rec.fileName,
          url: store.imageView(rec).url,
          bytes: buffer.length,
          title: rec.title || '',
          anchor: rec.anchor || '',
          turn: rec.turn ?? null,
          setIndex: rec.setIndex !== null && rec.setIndex !== undefined ? rec.setIndex : index,
          seed: rec.seed ?? null,
          continuousShot: rec.continuousShot || null,
        });
        job.images = saved.slice();
        if (retired) broadcast('image', store.imageView(retired));
        // 原地替换后，原任务 / 新任务的 images 条目都要指向新文件，
        // 任务详情、重新生成和图库才拿得到新图。
        if (inPlaceId && rec) {
          const jobIds = [];
          [inPlaceOldJobId, rec.jobId].forEach((id) => {
            if (id && !jobIds.includes(id)) jobIds.push(id);
          });
          for (const id of jobIds) {
            const orig = store.getJob(id);
            if (!orig || !Array.isArray(orig.images)) continue;
            const entry = orig.images.find((x) => x && String(x.id) === String(rec.id));
            if (!entry) continue;
            entry.path = full;
            entry.fileName = rec.fileName;
            entry.url = store.imageView(rec).url;
            entry.bytes = rec.bytes || buffer.length;
            entry.seed = rec.seed ?? null;
            entry.title = rec.title || '';
            entry.anchor = rec.anchor || '';
            entry.turn = rec.turn ?? null;
            if (rec.setIndex !== null && rec.setIndex !== undefined) entry.setIndex = rec.setIndex;
          }
          store.saveJobs();
          log('info', `${manualInPlace ? '仅此图原地替换' : '黑图原地替换'}：${rec.fileName}${retired ? '（旧文件已进回收站）' : ''}`, { jobId: job.id });
        }
        broadcast('image', store.imageView(rec));
        broadcastJob(job);
        log('info', `${runSets.length > 1 ? `第 ${index + 1} 套` : ''}出图：${rec.fileName}${rec.title ? ` · ${rec.title}` : ''}`, { jobId: job.id });
      }
    };

    try {
      for (let i = 0; i < runSets.length; i += 1) {
        if (ac.signal.aborted || job.status === STATUS.CANCELLED) return cancelled(job);
        await runOne(runSets[i], i);
      }
      job.comfyMs = Date.now() - comfyT0;
      job.totalMs = Date.now() - t0;
      job.images = saved;
      // 旧图回收放在新图全部落盘之后；即使某张旧图已经被别处删掉，
      // 也只记一条 warn，不影响这次新图。
      const newIds = new Set(saved.map((im) => String(im.id)));
      let replaced = 0;
      for (const oldId of (saved.length ? (job.replaceOldIds || []) : [])) {
        if (!oldId || newIds.has(String(oldId))) continue;
        try {
          const r = store.recycleImage(String(oldId), { preserveFavorite: true });
          if (!r.already) {
            replaced += 1;
            broadcast('image', store.imageView(r.rec));
          }
        } catch (e) {
          addWarn(job, `旧图 ${String(oldId).slice(-10)} 没能放进回收站：${e.message || e}`);
        }
      }
      if (replaced) log('info', `已用新图替换并回收 ${replaced} 张旧图`, { jobId: job.id });
      job.finishedAt = nowIso();
      const want = Number(job.expectCount) > 0 ? Math.round(Number(job.expectCount)) : runSets.length;
      if (saved.length !== want) job.warn = `要 ${want} 张，实际出 ${saved.length} 张`;
      touch(job, STATUS.DONE);
      release(job);
      store.saveJobs();
      log('info', `出图完成（${saved.length} 张）`, { jobId: job.id });
      return job;
    } catch (e) {
      if (ac.signal.aborted || job.status === STATUS.CANCELLED) return cancelled(job);
      return fail(job, e, 'comfy');
    }
  }

  /* ------------------------------ 手动入口 ------------------------------ */

  async function forwardText({
    text,
    sourceSessionId = '',
    sourceSessionTitle = '',
    sourceSeq = null,
    sourceTurn = null,
    autoGenerate = true,
    continuous = false,
    ownerSessionId = '',
    ownerSessionTitle = '',
    workflowId = '',
    replaceOld = false,
    replaceImageId = '',
    replaceImageIds = [],
    replaceText = '',
    maxSets = null,
    source = 'manual',
    regenMode = '',
    regenIndex = 0,
    bridgeInstruction = '',
    bridgeExtra = '',
    reusedFrom = '',
    forceRandomSeed = false,
    continuousOverride = null,
  }) {
    const job = createJob({
      source,
      text,
      bridgeInstruction,
      bridgeExtra,
      regenIndex,
      sourceSessionId,
      sourceSessionTitle,
      ownerSessionId,
      ownerSessionTitle,
      workflowId,
      sourceSeq,
      sourceTurn,
      autoGenerate,
      continuous,
      replaceOld,
      replaceImageId,
      replaceImageIds,
      replaceText,
      maxSets,
      regenMode,
      reusedFrom,
      continuousOverride,
    });
    job.forceRandomSeed = forceRandomSeed === true;
    // ★ 不 await：HTTP 立刻返回 job，面板用 SSE / 轮询看进度。
    //   投递 + 出图可能要几十秒，挂着一个请求等它跑完，调用方一超时就什么都拿不到。
    runJob(job).catch((e) => fail(job, e, 'deliver'));
    return job;
  }

  async function generateSets({ sets, text = '', workflowId = '', positive = '', negative = '', continuous = false, imageCount = null, ownerSessionId = '', ownerSessionTitle = '', sourceSessionId = '', sourceSessionTitle = '', sourceTurn = null }) {
    const cfg = getConfig();
    const job = createJob({
      source: 'manual',
      text: String(text || ''),
      autoGenerate: true,
      sourceSessionId,
      sourceSessionTitle,
      sourceTurn,
      ownerSessionId,
      ownerSessionTitle,
      workflowId,
      imageCount: imageCount ?? cfg.generation.imageCount,
      countMode: cfg.generation.countNotSet ? 'auto' : 'fixed',
      continuous: continuous === true || cfg.generation.continuous.on === true,
    });
    job.replyText = '';
    job.sets = [];
    runJob(job, { sets: sets || (positive ? [{ positive, negative }] : []) })
      .catch((e) => fail(job, e, 'comfy'));
    return job;
  }

  /**
   * 找到「这张图所在的连续图组」：同一套提示词按不同 LoRA 强度出的 N 张。
   * 返回组内图片 id / 对应 sets / 原 setIndex；不是连续图就返回 null。
   */
  function continuousGroupFor(targetImage, src) {
    if (!targetImage || !src || !Array.isArray(src.sets)) return null;
    const onlyIndex = Number(targetImage.setIndex);
    if (!Number.isInteger(onlyIndex) || onlyIndex < 0 || onlyIndex >= src.sets.length) return null;
    const shot = src.sets[onlyIndex] && src.sets[onlyIndex].continuousShot;
    if (!shot || Number(shot.total) <= 1) return null;
    const total = Math.max(1, Math.min(20, Number(shot.total)));
    const shotIndex = Math.max(1, Math.min(total, Number(shot.index) || 1));
    const base = onlyIndex - (shotIndex - 1);
    if (base < 0) return null;
    const rows = (Array.isArray(src.images) ? src.images : [])
      .filter((im) => {
        const si = Number(im && im.setIndex);
        if (!Number.isInteger(si) || si < base || si >= base + total) return false;
        const rec = store.getImage(im.id);
        return !!(rec && !rec.deletedAt);
      })
      .sort((a, b) => Number(a.setIndex) - Number(b.setIndex));
    if (rows.length < 2) return null;
    const sets = [];
    for (const row of rows) {
      const set = src.sets[Number(row.setIndex)];
      if (!set) return null;
      sets.push({ ...set });
    }
    return {
      ids: rows.map((row) => String(row.id)),
      sets,
      rows,
    };
  }

  async function regenerate({
    jobId = '',
    imageId = '',
    setIndex = null,
    workflowId = '',
    imageCount = null,
    continuous = false,
    ownerSessionId = '',
    ownerSessionTitle = '',
    mode = 'single',
    extra = '',
    latestText = '',
    latestSessionId = '',
    latestSessionTitle = '',
    latestTurn = null,
  }) {
    const targetImage = imageId ? store.getImage(imageId) : null;
    let src = targetImage && targetImage.jobId
      ? store.getJob(targetImage.jobId)
      : (jobId ? store.getJob(jobId) : null);
    if (!src) {
      src = store.listJobs(100).find((j) => j.status === STATUS.DONE && Array.isArray(j.sets) && j.sets.length);
    }
    if (!src || !Array.isArray(src.sets) || !src.sets.length) {
      throw new HttpError(400, '还没有出过图，没有可以复用的提示词。先自动/手动出一次，再用「重新生成」。');
    }
    const rawSet = targetImage ? targetImage.setIndex : setIndex;
    const onlyIndex = rawSet !== null && rawSet !== undefined && rawSet !== '' && Number.isInteger(Number(rawSet))
      ? Number(rawSet) : -1;
    const single = onlyIndex >= 0 && onlyIndex < src.sets.length;
    const normalizedMode = mode === 'all' ? 'all' : (mode === 'auto' ? 'auto' : 'single');
    // 手动重新生成必须先有可投递的提示词来源；没有就明确报错，
    // 绝不退回“拿旧提示词直接出图”。
    if (normalizedMode !== 'auto' && !String(getConfig().target.sessionId || '').trim()) {
      throw new HttpError(400, '提示词来源会话是空的，先在设置里选一个会话再重新生成', 'no-target');
    }
    // 黑图补图必须复用原提示词；手动「仅此图 / 本轮全部」强制用正文来源的最新正文。
    const forceLatest = normalizedMode !== 'auto' && String(latestText || '').trim().length > 0;
    const body = forceLatest ? String(latestText) : String(src.replaceText || src.text || '');
    const bodySessionId = forceLatest ? String(latestSessionId || src.sourceSessionId || '') : String(src.sourceSessionId || '');
    const bodySessionTitle = forceLatest ? String(latestSessionTitle || src.sourceSessionTitle || '') : String(src.sourceSessionTitle || '');
    const bodyTurn = forceLatest
      ? (latestTurn === null || latestTurn === undefined ? src.sourceTurn : Number(latestTurn))
      : src.sourceTurn;
    const owner = ownerSessionId || (targetImage && targetImage.sessionId) || '';
    const ownerTitle = ownerSessionTitle || (targetImage && targetImage.sessionTitle) || '';

    // 连续图：点其中一张「仅此图」时，重做这一整组 N 张（同一提示词、各档强度），
    // 只替换原来的 N 个位置，不新增图片；少生成了就按「只会少」回收剩下的旧图。
    const group = normalizedMode === 'single' && targetImage
      ? continuousGroupFor(targetImage, src)
      : null;
    const extraText = String(extra || '').trim();
    if (group) {
      const sets = group.sets;
      // 连续图也走一次桥会话：让会话重写「这一组」的提示词，
      // 回来只取一套，再按原来的 N 档强度展开成 N 张。
      // 原任务没留正文时退回最新正文；再没有就明确报错，不能悄悄出旧图。
      const groupBody = String(src.replaceText || src.text || body || '');
      if (!groupBody.trim()) {
        throw new HttpError(400, '这一组连续图没有可投递的正文，无法发送给提示词来源重写', 'no-text');
      }
      const strengths = sets.map((s) => (s.continuousShot ? s.continuousShot.strength : null));
      const firstShot = sets[0] && sets[0].continuousShot ? sets[0].continuousShot : {};
      const job = await forwardText({
        source: 'regen',
        text: groupBody,
        bridgeInstruction: '重新生成这一组连续图的提示词',
        bridgeExtra: extraText,
        sourceSessionId: src.sourceSessionId,
        sourceSessionTitle: src.sourceSessionTitle,
        sourceSeq: src.sourceSeq,
        sourceTurn: src.sourceTurn,
        ownerSessionId: owner,
        ownerSessionTitle: ownerTitle,
        workflowId: workflowId || src.workflowId,
        autoGenerate: true,
        continuous: false,
        replaceText: groupBody,
        replaceImageIds: group.ids,
        maxSets: 1,
        regenMode: 'continuous',
        reusedFrom: src.id,
        forceRandomSeed: true,
        continuousOverride: {
          count: sets.length,
          nodeId: firstShot.nodeId || '',
          name: firstShot.name || '',
          strengths,
        },
      });
      return job;
    }

    // 黑图自动重生成：不经过会话，直接复用原来那一套提示词换种子，只替换黑图那张。
    if (normalizedMode === 'auto') {
      if (!targetImage || !single) throw new HttpError(400, '这张图没有可复用的提示词，无法仅重生成这一张');
      const sets = [{ ...src.sets[onlyIndex] }];
      const job = createJob({
        source: 'regen',
        text: body,
        replaceText: body,
        sourceSessionId: src.sourceSessionId,
        sourceSeq: src.sourceSeq,
        sourceTurn: src.sourceTurn,
        ownerSessionId: owner,
        ownerSessionTitle: ownerTitle,
        workflowId: workflowId || src.workflowId,
        imageCount: 1,
        countMode: 'fixed',
        continuous: false,
        autoGenerate: true,
        replaceImageId: targetImage.id,
        maxSets: 1,
        regenMode: 'auto',
        reusedFrom: src.id,
        forceRandomSeed: true,
      });
      job.sets = sets;
      job.expectCount = 1;
      job.positive = sets[0].positive;
      job.negative = sets[0].negative || '';
      runComfy(job, { t0: Date.now() }).catch((e) => fail(job, e, 'comfy'));
      return job;
    }

    if (!body) {
      throw new HttpError(400, '这条图片记录没有保留正文，不能直接用旧提示词重生成；请检查正文来源 / 提示词来源', 'no-text');
    }
    const x = onlyIndex >= 0 ? onlyIndex + 1 : 1;
    const instruction = normalizedMode === 'all'
      ? '重新生成本轮全部图片的提示词'
      : `重新生成第${x}张图的提示词`;
    // 黑图自动补图后的 job 只有一套；做「全部」时回到它复用的原轮次取张数。
    // 手动重新生成强制最新正文时，张数改看「最新正文现在有几张图」，没有就按设置上限。
    const roundSrc = src.reusedFrom
      ? (store.getJob(src.reusedFrom) || src)
      : src;
    const latestExisting = forceLatest ? store.bodyImageIds(owner, body).length : 0;
    const roundCount = forceLatest
      ? Math.max(1, Math.min(3, latestExisting || Number(getConfig().capture.maxSets) || 1))
      : Math.max(1, (roundSrc.sets || src.sets || []).length || 1);
    const job = await forwardText({
      source: 'regen',
      // text 只放正文；「重新生成第 x 张」和额外要求分开传，投递时统一包裹。
      text: body,
      bridgeInstruction: instruction,
      bridgeExtra: extraText,
      regenIndex: x,
      sourceSessionId: bodySessionId,
      sourceSessionTitle: bodySessionTitle,
      sourceSeq: src.sourceSeq,
      sourceTurn: bodyTurn,
      autoGenerate: true,
      continuous: false,
      ownerSessionId: owner,
      ownerSessionTitle: ownerTitle,
      workflowId: workflowId || src.workflowId,
      replaceImageId: normalizedMode === 'single' && targetImage ? targetImage.id : '',
      replaceOld: normalizedMode === 'all',
      replaceText: body,
      maxSets: normalizedMode === 'single' ? 1 : Math.max(1, Math.min(3, roundCount)),
      regenMode: normalizedMode,
      reusedFrom: src.id,
      forceRandomSeed: true,
    });
    return job;
  }

  function abortJob(id) {
    const job = store.getJob(id);
    if (!job) throw new HttpError(404, '任务不存在');
    const c = controllers.get(id);
    if (c) c.abort();
    // 投递阶段：只在这个会话真的有我们的在飞请求时才通知宿主取消那一轮
    if ((job.status === STATUS.DELIVERING || job.status === STATUS.QUEUED)
      && getConfig().target.mode === 'local'
      && getConfig().target.sessionId) {
      cancelLocalSession(resolveSessionController(ctx, sc), getConfig().target.sessionId);
    }
    if (job.status === STATUS.RUNNING && job.comfyPromptId && getConfig().comfy.interruptOnAbort) {
      interrupt(getConfig().comfy.baseUrl).catch(() => {});
    }
    if (TERMINAL.includes(job.status)) return job;
    return cancelled(job);
  }

  /** 取某个会话最新一条助手文本（悬浮球 / 手动投递用）。 */
  async function latestSessionText(sessionId) {
    const controller = resolveSessionController(ctx, sc);
    if (!controller) throw new HttpError(503, '宿主没有 sessionController 服务');
    const sid = String(sessionId || '').trim();
    if (!sid) throw new HttpError(400, '没有当前会话 id');
    const snap = await controller.inspect(sid);
    const events = Array.isArray(snap?.events) ? snap.events : [];
    const got = lastAssistantText(events);
    if (!got.text) throw new HttpError(404, '这个会话还没有助手回复，没有正文可以投递');
    const text = cleanBodyText(got.text);
    if (!text) throw new HttpError(404, '最新回复只有 @bubble 指令，清理后没有正文', 'empty-after-clean');
    return { text, turn: got.turn, interrupted: got.interrupted, events: events.length };
  }

  function jobView(job, opts = {}) {
    if (!job) return null;
    const compact = opts.compact === true;
    const imgs = (Array.isArray(job.images) ? job.images : [])
      .filter((im) => {
        const rec = store.getImage(im.id);
        return rec ? store.imageFileAlive(rec) : !!im.path && fs.existsSync(im.path);
      })
      .map((im) => {
        const rec = store.getImage(im.id);
        return {
          ...im,
          url: store.imageView(rec || im).url,
          favorited: !!rec?.favoritedTo,
          recycled: !!rec?.deletedAt,
        };
      });
    return {
      id: job.id,
      source: job.source,
      // 黑图补图只是内部替换任务，不当作新一轮“本次出图”展示。
      internal: job.regenMode === 'auto',
      status: job.status,
      text: compact ? undefined : job.text,
      textPreview: String(job.text || '').slice(0, 160),
      outgoingText: compact ? undefined : (job.outgoingText || ''),
      bridgeInstruction: compact ? undefined : (job.bridgeInstruction || ''),
      bridgeExtra: compact ? undefined : (job.bridgeExtra || ''),
      sourceSessionId: job.sourceSessionId,
      sourceSessionTitle: job.sourceSessionTitle,
      sourceTurn: job.sourceTurn ?? null,
      ownerSessionId: job.ownerSessionId || '',
      ownerSessionTitle: job.ownerSessionTitle || '',
      sourceSeq: job.sourceSeq,
      targetSessionId: job.targetSessionId,
      targetMode: job.targetMode,
      replyText: compact ? '' : job.replyText,
      replyPreview: String(job.replyText || '').slice(0, 400),
      replyChars: String(job.replyText || '').length,
      deliveryMs: job.deliveryMs,
      sawOwnPrompt: job.sawOwnPrompt,
      deliveryMode: job.deliveryMode || '',
      promptSource: job.promptSource || '',
      interrupted: job.interrupted,
      ruleId: job.ruleId,
      issues: job.issues || [],
      parseWarn: job.parseWarn || '',
      sets: (job.sets || []).map((s) => ({
        title: s.title || '', anchor: s.anchor || '', size: s.size || null, positive: s.positive, negative: s.negative || '',
        tags: s.tags || '', nl: s.nl || '', issues: s.issues || [],
        continuousShot: s.continuousShot || null,
      })),
      positive: job.positive,
      negative: job.negative,
      imageCount: job.imageCount,
      expectCount: job.expectCount,
      warn: String(job.warn || '').split('　')
        .filter((item) => item && item !== LEGACY_OWN_PROMPT_WARNING)
        .join('　'),
      continuous: job.continuous === true,
      continuousInfo: job.continuousInfo || null,
      workflowId: job.workflowId,
      workflowName: job.workflowName,
      images: imgs,
      comfyPromptId: job.comfyPromptId,
      comfyMs: job.comfyMs,
      totalMs: job.totalMs,
      overrideReport: compact ? null : job.overrideReport,
      error: job.error,
      failedStage: job.failedStage,
      errorCode: job.errorCode,
      autoGenerate: job.autoGenerate !== false,
      cancellable: isLive(job.status),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      reusedFrom: job.reusedFrom || '',
      regenMode: job.regenMode || '',
    };
  }

  const api = {
    STATUS,
    createJob,
    runJob,
    runComfy,
    forwardText,
    generateSets,
    regenerate,
    abortJob,
    handleCaptured,
    flushCapture,
    latestSessionText,
    jobView,
    isLive,
    setActiveSessionProvider,
    dispose() {
      for (const c of controllers.values()) {
        try { c.abort(); } catch { /* ignore */ }
      }
      controllers.clear();
      for (const p of debounce.values()) {
        if (p.timer) clearTimeout(p.timer);
      }
      debounce.clear();
    },
  };
  return api;
}
