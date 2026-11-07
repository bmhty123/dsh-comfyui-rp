/**
 * 会话层：本进程（local）和另一个 DSH 进程（remote）的统一出入口。
 *
 * local  —— 直接用宿主注入的 sessionController / session/event 服务：
 *           · 捕获：订阅 session/event，过滤指定会话的 assistant/message；
 *           · 投递：resolveAgent → 记窗口起点 → prompt(mode:'queue') → 等 turn/end → 取最后一条非空助手文本。
 * remote —— 走对方 DSH 里装的同一个插件：
 *           · 投递：POST <base><route>/api/ask（旧 relay 插件的 /__dsh_prompt 也兼容）；
 *           · 捕获：GET  <base><route>/api/stream?sessionId=...（SSE）。
 *
 * 为什么不用 DSH 的 /api/*：那套是 BrowserAuth（cookie 由每进程随机 launchToken 换），
 * 外部进程拿不到也关不掉；插件自己注册的路由才是通的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, cleanBodyText, joinUrl, sleep } from './util.js';

const DEFAULT_TIMEOUT_MS = 300000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 1800000;
const POLL_MS = 120;
const IDLE_GRACE_MS = 1500;

/**
 * 本进程里正在等回复的会话。
 * ★ 只有这张表里有它时，/api/jobs/:id/abort 才敢去 sc.cancel ——
 *   会话是共用资源，用户可能正在同一个会话里跑自己的活，不能因为一个空取消把它掐掉。
 */
const inflightLocal = new Set();

export function cancelLocalSession(sc, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid || !inflightLocal.has(sid)) return false;
  try {
    sc?.cancel({ sessionId: sid });
    return true;
  } catch {
    return false;
  }
}

function clampTimeout(ms, dflt = DEFAULT_TIMEOUT_MS) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(n)));
}

export function sessionIdOf(sessionLike) {
  const s = sessionLike || {};
  return String(s.id || s.sessionId || s.header?.sessionId || s.header?.id || '');
}

/**
 * 解析 sessionController。
 * ★ 不能在 apply() 时缓存：Cordis 的服务可能是 apply 之后才 provide 的
 *   （本插件 apply 得早，直接 get 会拿到 undefined）。每次用之前再取一次。
 */
export function resolveSessionController(ctx, sc) {
  if (sc) return sc;
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') || null : null;
  } catch {
    return null;
  }
}

/**
 * ★ SessionEvent 的负载在 event.data 下，不在事件顶层。
 *   早先转发插件直接读 e.message，结果永远是 undefined（empty-reply 的根因）。
 */
export function payloadOf(event) {
  if (event && typeof event === 'object' && event.data && typeof event.data === 'object') return event.data;
  return event && typeof event === 'object' ? event : {};
}

export function textOfMessage(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((b) => b && b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
    .trim();
}

/**
 * 事件里的「消息对象」。
 * ★ 助手消息在 payload.message 下；user/message 的 payload 本身就是消息
 *   （content / source / role / id）。以前两处都只读 payload.message，
 *   用户消息永远读成空串，于是「这一轮有没有看到我投递的正文」一直是 false。
 */
export function messageOf(event) {
  const p = payloadOf(event);
  const message = p && p.message;
  return message && typeof message === 'object' ? message : p;
}

/**
 * 这个会话是不是「只有人物卡开场、还没有正文」。
 *
 * 判据：整个日志里只有一条非空助手消息，并且它前面没有真人用户消息。
 * Tavern 这类宿主会把人物卡开场种成第一条助手消息（前面只有插件注入的消息），
 * 所以选错会话 / 刚开的会话就会把开场白当成正文投出去。
 */
export function openingOnly(events) {
  const list = Array.isArray(events) ? events : [];
  let firstAt = -1;
  let lastAt = -1;
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!e || e.type !== 'assistant/message') continue;
    if (!textOfMessage(messageOf(e))) continue;
    if (firstAt < 0) firstAt = i;
    lastAt = i;
  }
  if (firstAt < 0 || firstAt !== lastAt) return false;
  for (let i = 0; i < firstAt; i += 1) {
    const e = list[i];
    if (!e || e.type !== 'user/message') continue;
    const source = messageOf(e)?.source;
    if (source && source.kind === 'user') return false;
  }
  return true;
}

/**
 * 回复看起来是不是「模型把宿主的时间注入当成了本轮输入」。
 * 那种回复都很短，会引用 Time sampled / Browser time zone，并说没收到正文。
 */
export function looksLikeTimestampOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 700) return false;
  if (!/Time sampled while preparing|Browser time zone for this request/.test(t)) return false;
  return /(只有|只收到|只带了|没收到|没有收到|收不到|没跟过来|没跟着来|没带来|时间戳)/.test(t);
}

/** 取窗口内最后一条非空助手文本（一轮里可能有多次模型调用，前面几条是过渡话术）。 */
export function lastAssistantText(events) {
  let text = '';
  let turn = null;
  let interrupted = false;
  let seen = 0;
  for (const e of events) {
    if (!e || e.type !== 'assistant/message') continue;
    seen += 1;
    const p = payloadOf(e);
    if (p.interrupted) interrupted = true;
    const t = textOfMessage(messageOf(e));
    if (t) {
      text = t;
      turn = p.turn ?? turn;
    }
  }
  return { text, turn, interrupted, seen };
}

export function countTurnEnds(events) {
  let n = 0;
  for (const e of events) if (e && e.type === 'turn/end') n += 1;
  return n;
}

/**
 * DSH 把「归档」存在 workspace.json 的 global.archivedSessionIds；
 * sessionController.list() 返回的对象本身不带 archived 字段，所以这里必须读那份索引。
 */
function readArchivedSessionIds() {
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'storages', 'workspace.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = doc?.global?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
}

/** 本地会话列表（标题从 projection 读；没有就退回 id / cwd）。 */
export async function listLocalSessions(sc, { limit = 80, withTitle = true, signal, ctx, fresh = false } = {}) {
  const controller = resolveSessionController(ctx, sc);
  if (!controller) throw new HttpError(503, '宿主没有 sessionController 服务，无法列出本进程的会话', 'no-controller');
  const raw = await controller.list({}, signal);
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  const archived = readArchivedSessionIds();
  const rows = items
    .filter((s) => {
      const sid = sessionIdOf(s);
      return s && sid
        && !archived.has(sid)
        && s.archived !== true && !s.archivedAt
        && s.state !== 'archived' && s.meta?.archived !== true;
    })
    .slice()
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 80)));

  // 手动刷新时必须重新问 projection：list 里的标题可能是旧的，新会话甚至还没带上。
  // 分批并发，避免 100 个会话串行等一圈。
  const BATCH = 8;
  // Tavern 把人物卡名当目录：同一个角色的每个会话标题都一样（例如「沐白形象管理」）。
  // 只给「标题重复」的会话补一条区分信息：首条用户消息 + 消息条数；
  // 标题唯一的普通会话完全不加开销。
  const titleOf = (s) => String(s.title || s.projections?.values?.title || '').trim();
  const titleCount = new Map();
  for (const s of rows) {
    const t = titleOf(s);
    if (t) titleCount.set(t, (titleCount.get(t) || 0) + 1);
  }
  const shapeOf = (values) => {
    const ti = values && values.titleInput;
    const first = ti && ti.first && typeof ti.first.text === 'string' ? ti.first.text : '';
    const n = ti ? Number(ti.count) : NaN;
    return {
      firstText: String(first).replace(/\s+/g, ' ').trim().slice(0, 80),
      userCount: Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
    };
  };
  const readRow = async (s, sid) => {
    let title = titleOf(s);
    let shape = shapeOf(s.projections && s.projections.values);
    if (!withTitle) return { title, ...shape };
    const dup = !!title && (titleCount.get(title) || 0) > 1;
    // 标题从 list 的投影里已经读到、不是强制刷新、也不是同名会话 → 不再多问一次。
    if (!fresh && title && (shape.firstText || !dup)) return { title, ...shape };
    try {
      const proj = await controller.projections({ sessionId: sid }, signal);
      const t = String(proj?.values?.title || '').trim();
      if (t) title = t;
      const next = shapeOf(proj?.values);
      if (next.firstText || !shape.firstText) shape = next;
    } catch { /* 拿不到标题 / 首条消息不影响列表 */ }
    return { title, ...shape };
  };
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const infos = await Promise.all(batch.map((s) => readRow(s, sessionIdOf(s))));
    batch.forEach((s, j) => {
      const sid = sessionIdOf(s);
      const info = infos[j] || { title: '', firstText: '', userCount: 0 };
      const title = info.title;
      const cwd = String(s.cwd || '');
      out.push({
        sessionId: sid,
        title,
        displayTitle: title || (cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '') || sid.slice(0, 12),
        // 同名会话靠这两个字段区分：首条用户消息一句话 + 条数（刚开的会话条数很少）。
        firstText: info.firstText || '',
        userCount: info.userCount || 0,
        cwd,
        updatedAt: Number(s.updatedAt) || 0,
        running: !!s.running,
        live: !!s.agentAvailable,
        blank: !!s.blank,
      });
    });
  }
  return { sessions: out, total: out.length };
}

/** 远程会话列表：GET <base><route>/api/sessions。 */
export async function listRemoteSessions({ baseUrl, routePath = '/__airp_comfy', token = '', limit = 80, signal } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new HttpError(400, '远程 DSH 地址是空的');
  const route = String(routePath || '/__airp_comfy').replace(/\/+$/, '');
  const url = `${base}${route}/api/sessions?limit=${encodeURIComponent(String(limit))}&title=1`;
  const headers = { Accept: 'application/json' };
  if (token) headers['x-prompt-relay-token'] = String(token);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([ac.signal, signal]) : ac.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 下面按错误处理 */ }
    if (!res.ok || !data || data.ok === false) {
      throw new HttpError(res.status >= 400 ? res.status : 502,
        `远程会话列表失败：${data?.error || text.slice(0, 240) || `HTTP ${res.status}`}`, 'remote-list');
    }
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      total: Number(data.total) || 0,
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `连不上远程 DSH ${base}：${e?.message || e}\n（确认对方在跑、且装了 ${route} 这个插件）`, 'remote-down');
  } finally {
    clearTimeout(timer);
  }
}

/** 远程读取某个会话最新一条助手正文：GET <base><route>/api/session-text。 */
export async function latestRemoteSessionText({ baseUrl, routePath = '/__airp_comfy', token = '', sessionId, timeoutMs = 20000 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new HttpError(400, '远程 DSH 地址是空的');
  const sid = String(sessionId || '').trim();
  if (!sid) throw new HttpError(400, '还没选提示词来源会话');
  const route = String(routePath || '/__airp_comfy').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  if (token) headers['x-prompt-relay-token'] = String(token);
  try {
    const res = await fetch(
      `${base}${route}/api/session-text?sessionId=${encodeURIComponent(sid)}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 下面按错误处理 */ }
    if (!res.ok || !data || data.ok === false) {
      throw new HttpError(res.status >= 400 ? res.status : 502,
        `远程读取会话正文失败：${data?.error || text.slice(0, 240) || `HTTP ${res.status}`}`, 'remote-text');
    }
    return { text: String(data.text || ''), opening: data.opening === true };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `连不上远程 DSH ${base}：${e?.message || e}`, 'remote-down');
  }
}

export async function healthRemote({ baseUrl, routePath = '/__airp_comfy', token = '', timeoutMs = 8000 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new HttpError(400, '远程 DSH 地址是空的');
  const route = String(routePath || '/__airp_comfy').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  if (token) headers['x-prompt-relay-token'] = String(token);
  try {
    const res = await fetch(`${base}${route}/api/health`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }
    if (!res.ok) throw new HttpError(res.status, `${route}/api/health → HTTP ${res.status}`, 'remote-health');
    return data || { ok: true, raw: text.slice(0, 200) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `连不上 ${base}${route}/api/health：${e?.message || e}`, 'remote-down');
  }
}

/* ------------------------------- 投递 ------------------------------- */

/**
 * 本进程投递：把正文投给指定会话，等这一轮跑完，取回复。
 *
 * 关键点（每一条都是踩过的坑）：
 *  · 窗口起点 = 投递前的 session.seq；拿不到就报错，**绝不猜 0**（会把上一轮回复当答案）。
 *  · busyBefore 必须在 prompt() **之前**采样（投递本身会把 agent 从 idle 拉起来）。
 *  · 用 mode:'queue'：会话正在跑时排队，不打断用户。
 *  · 超时/断开都要 cancel 那一轮，别让它继续占着会话。
 */
export async function askLocal(ctx, sc, { sessionId, text, timeoutMs, signal } = {}) {
  const controller = resolveSessionController(ctx, sc);
  if (!controller) throw new HttpError(503, '宿主没有 sessionController 服务，无法投递到本进程会话', 'no-controller');
  const sid = String(sessionId || '').trim();
  const body = String(text ?? '');
  if (!sid) throw new HttpError(400, '还没选桥会话（目标会话）');
  if (!body.trim()) throw new HttpError(400, '正文是空的，没有东西可以投给桥会话');

  const budget = clampTimeout(timeoutMs);
  const resolved = await controller.resolveAgent(sid);
  if (resolved && resolved.error) {
    const e = resolved.error;
    throw new HttpError(404, `解析会话失败：${e.code || 'unknown'}${e.message ? ` · ${e.message}` : ''}`, e.code || 'resolve-failed');
  }
  const agent = resolved && resolved.agent;
  if (!agent) throw new HttpError(500, '解析会话失败：没有返回 agent', 'resolve-failed');

  const session = agent.session;
  const fromSeq = Number(session.seq);
  if (!Number.isFinite(fromSeq) || fromSeq < 0) {
    throw new HttpError(500,
      `读不到会话的日志位置（session.seq = ${String(session?.seq)}）。为避免把上一轮回复当成本次答案，这次不猜。`,
      'bad-session-state');
  }
  // 先等目标会话空闲再投递。有些宿主（Tavern 这种带自动续写的）会让会话一直有事在跑，
  // 这时 `queue` 的正文会排到下一轮，而当前这轮模型只看到时间上下文注入的那条
  // ——表现就是「只收到时间戳，正文没跟着来」。
  // 等不到空闲就用 `steer` 把正文塞进正在跑的这一轮，至少模型能看到内容。
  const IDLE_WAIT_MS = 15000;
  const waitBegan = Date.now();
  while (agent.status !== 'idle' && Date.now() - waitBegan < IDLE_WAIT_MS) {
    if (signal && signal.aborted) break;
    await sleep(200);
  }
  const idleWaited = Date.now() - waitBegan;
  const busyBefore = agent.status !== 'idle';
  const deliveryMode = busyBefore ? 'steer' : 'queue';
  const expectEnds = busyBefore ? 2 : 1;
  const started = Date.now();

  const ac = new AbortController();
  const onAbort = () => { try { ac.abort(); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const events = [];
  let ends = 0;
  const listener = (sessionObj, event) => {
    if (sessionIdOf(sessionObj) !== sid) return;
    if (!event || Number(event.seq) <= fromSeq) return;
    events.push(event);
    if (event.type === 'turn/end') ends += 1;
  };
  const off = ctx.on('session/event', listener);
  const dispose = typeof off === 'function' ? off : () => { try { off?.dispose?.(); } catch { /* ignore */ } };

  const requestId = `airp-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  let cancelled = false;
  inflightLocal.add(sid);
  try {
    await controller.prompt(
      { requestId, sessionId: sid, mode: deliveryMode, content: [{ type: 'text', text: body }] },
      ac.signal,
    );

    const deadline = started + budget;
    let idleSince = 0;
    for (;;) {
      if (ac.signal.aborted) {
        cancelled = true;
        break;
      }
      if (ends >= expectEnds) break;
      if (ends >= 1 && agent.status === 'idle') {
        const now = Date.now();
        if (!idleSince) idleSince = now;
        else if (now - idleSince >= IDLE_GRACE_MS) break;
      } else {
        idleSince = 0;
      }
      if (Date.now() > deadline) {
        try { controller.cancel({ sessionId: sid }); } catch { /* ignore */ }
        throw new HttpError(504, `等桥会话回复超时（${budget}ms）。可以在设置里调大等待上限，或去那个会话看一眼。`, 'timeout');
      }
      await sleep(POLL_MS);
    }

    if (cancelled) {
      try { controller.cancel({ sessionId: sid }); } catch { /* ignore */ }
      throw new HttpError(499, signal?.aborted ? '调用方已断开，已取消那一轮' : '已被取消', 'cancelled');
    }

    const got = lastAssistantText(events);
    // 窗口里有没有出现我们投出去的正文（启发式：前面 24 个字符出现过）。
    // 有些宿主（例如 Tavern 的程序化投递）不会把 prompt() 发成 user/message；
    // 这时没有用户消息可核对，返回 null（未知），不要误报「不是这次投递」。
    const bodyText = body.trim();
    const probe = bodyText.slice(0, 24);
    const userEvents = events.filter((e) => e && e.type === 'user/message');
    let sawOwnPrompt = null;
    if (userEvents.length) {
      sawOwnPrompt = userEvents.some((e) => {
        const t = textOfMessage(messageOf(e));
        return t && (!probe || t.includes(probe));
      });
    }
    if (!got.text) {
      throw new HttpError(502,
        `会话跑完了但没有可用的文本回复（窗口内 ${events.length} 个事件、助手消息 ${got.seen} 条、全部是空文本）。`, 'empty-reply');
    }
    return {
      mode: 'local',
      sessionId: sid,
      requestId,
      text: got.text,
      turn: got.turn,
      ms: Date.now() - started,
      busyBefore,
      deliveryMode,
      idleWaited,
      sawOwnPrompt,
      interrupted: got.interrupted,
    };
  } finally {
    inflightLocal.delete(sid);
    if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
    try { dispose(); } catch { /* ignore */ }
  }
}

/** 远程投递：POST <base><route>/api/ask，对方插件负责等回复。 */
export async function askRemote({ baseUrl, routePath = '/__airp_comfy', token = '', sessionId, text, timeoutMs, signal } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new HttpError(400, '远程 DSH 地址是空的');
  const route = String(routePath || '/__airp_comfy').replace(/\/+$/, '');
  const budget = clampTimeout(timeoutMs);
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (token) headers['x-prompt-relay-token'] = String(token);
  const timer = AbortSignal.timeout(budget + 20000);
  const combined = signal ? AbortSignal.any([timer, signal]) : timer;
  let res;
  try {
    res = await fetch(`${base}${route}/api/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, text, timeoutMs: budget }),
      signal: combined,
    });
  } catch (e) {
    if (signal?.aborted) throw new HttpError(499, '调用方已断开', 'cancelled');
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new HttpError(504, `等远程 DSH 回复超时（${budget}ms）`, 'timeout');
    }
    throw new HttpError(502, `连不上远程 DSH ${base}${route}：${e?.message || e}\n（确认对方在跑、且装了该插件）`, 'remote-down');
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* ignore */ }
  if (!res.ok || !data || data.ok === false) {
    const code = data?.code || 'remote-ask';
    const detail = data?.error || raw.slice(0, 400) || `HTTP ${res.status}`;
    const hints = {
      busy: '那个会话上已经有一个转发请求在跑，等它结束再试。',
      timeout: '对方那一轮超过了等待上限，已经被取消；可以调大等待上限。',
      'not-found': '那个会话在对方 DSH 里找不到了，重新刷新会话再选。',
      'empty-reply': '对方会话跑完了但没有文本回复（可能没按契约回）。',
      'bad-session-state': '对方插件读不到会话日志位置，为避免错答拒绝继续；重启对方 DSH 再试。',
    };
    throw new HttpError(res.status >= 400 ? res.status : 502,
      `远程投递失败（${code}）：${detail}${hints[code] ? `\n${hints[code]}` : ''}`, code);
  }
  return {
    mode: 'remote',
    sessionId: data.sessionId || sessionId,
    requestId: data.requestId || '',
    text: String(data.text ?? ''),
    turn: data.turn ?? null,
    ms: Number(data.ms) || 0,
    busyBefore: !!data.busyBefore,
    // 对方插件的 askLocal 会带这两个字段：任务记录 / 日志才能看出这一轮是排队还是 steer。
    deliveryMode: typeof data.deliveryMode === 'string' ? data.deliveryMode : '',
    idleWaited: Number(data.idleWaited) || 0,
    sawOwnPrompt: data.sawOwnPrompt === true ? true : data.sawOwnPrompt === false ? false : null,
    interrupted: !!data.interrupted,
  };
}

/** 统一投递入口。 */
export async function askTarget({ mode, ctx, sc, baseUrl, routePath, token, sessionId, text, timeoutMs, signal }) {
  if (mode === 'remote') {
    return askRemote({ baseUrl, routePath, token, sessionId, text, timeoutMs, signal });
  }
  return askLocal(ctx, sc, { sessionId, text, timeoutMs, signal });
}

/* ------------------------------- 捕获 ------------------------------- */

/**
 * 本进程捕获：订阅 session/event，把指定会话的助手回复交出去。
 * 返回 dispose。
 */
export function captureLocal(ctx, sessionId, onEvent) {
  const sid = String(sessionId || '').trim();
  if (!sid) return () => {};
  const listener = (sessionObj, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return;
      if (sessionIdOf(sessionObj) !== sid) return;
      const p = payloadOf(event);
      // 只有「正文」要清 @bubble；提示词会话的回复不能在这里动。
      const text = cleanBodyText(textOfMessage(p.message));
      if (!text) return;
      onEvent({
        sessionId: sid,
        seq: Number(event.seq) || 0,
        time: Number(event.time) || Date.now(),
        turn: p.turn ?? null,
        text,
        interrupted: p.interrupted === true,
      });
    } catch { /* 单个事件失败不能拖垮监听 */ }
  };
  const off = ctx.on('session/event', listener);
  return typeof off === 'function' ? off : () => { try { off?.dispose?.(); } catch { /* ignore */ } };
}

/**
 * 远程捕获：连对方插件的 SSE `/api/stream?sessionId=`。
 * 断线自动重连；返回 { close }。
 */
export function captureRemote({ baseUrl, routePath = '/__airp_comfy', token = '', sessionId, onEvent, onError, onStatus }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const route = String(routePath || '/__airp_comfy').replace(/\/+$/, '');
  const sid = String(sessionId || '').trim();
  let closed = false;
  let ac = new AbortController();
  let retryTimer = null;

  const url = `${base}${route}/api/stream?sessionId=${encodeURIComponent(sid)}`;

  async function connect() {
    if (closed) return;
    ac = new AbortController();
    onStatus?.({ connected: false, url });
    try {
      const headers = { Accept: 'text/event-stream' };
      if (token) headers['x-prompt-relay-token'] = String(token);
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onStatus?.({ connected: true, url });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
          const lines = block.split(/\r?\n/);
          let evName = 'message';
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('event:')) evName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          const raw = dataLines.join('\n');
          if (raw === '[DONE]') continue;
          let data = null;
          try { data = JSON.parse(raw); } catch { continue; }
          if (evName === 'message' || evName === 'assistant') onEvent?.(data);
        }
      }
    } catch (e) {
      if (!closed) onError?.(e);
    }
    if (!closed) {
      onStatus?.({ connected: false, url });
      retryTimer = setTimeout(connect, 2500);
      if (typeof retryTimer.unref === 'function') retryTimer.unref();
    }
  }

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { ac.abort(); } catch { /* ignore */ }
    },
  };
}

/** 远程探活 + 会话列表；给「测试连接」用。 */
export async function remoteProbe({ baseUrl, routePath, token } = {}) {
  const health = await healthRemote({ baseUrl, routePath, token });
  const sessions = await listRemoteSessions({ baseUrl, routePath, token, limit: 80 });
  return { health, ...sessions };
}

export { joinUrl };
