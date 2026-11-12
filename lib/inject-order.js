/**
 * 宿主的时间注入和桥消息的先后顺序。
 *
 * 背景（真实的坑）：
 *   DSH 装了 @deepseek-ai/dsh-time-context 后，几乎每 10 分钟会在「模型请求前」再补一条
 *   只有三行的用户消息：
 *       Time sampled while preparing turn N, step 1: ...
 *       Browser time zone for this request: ...
 *       Elapsed since the preceding model-visible message: ...
 *   它注册的是 `agent/pre-step` 瀑布，并且排在所有消息**之后**。于是我们投递的正文
 *   一到这轮，会话里就变成 [正文, 时间戳] —— 模型看到「最新一条用户消息是时间戳」，
 *   就以为这一轮只收到了时间戳，回一句「正文没跟着来」，正好对应用户看到的
 *   「只收到时间戳」。
 *
 * 处理：只针对**我们自己的投递轮**（消息 source.rpcId 以 `airp-` 开头），
 *   把这一轮里的时间注入挪到正文前面，让模型看到的最后一条用户消息始终是正文。
 *   别的会话、别的插件注册的时间消息一概不碰。
 */

/** 桥投递用的 requestId 前缀（见 session.js 的 askLocal / api.js 的 /api/ask）。 */
export const BRIDGE_RPC_PREFIX = 'airp-';

const TIME_CONTEXT_KIND = 'time-context';

/** 折进正文时加的说明行：告诉模型「后面这些不是用户写的内容」。 */
const TIME_FOLD_HEADER = '\n\n[宿主自动时间标记，不是用户输入]\n';

function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('');
}

function isBridgeMessage(message) {
  const src = message && message.source;
  return !!(src && typeof src === 'object'
    && src.kind === 'user'
    && typeof src.rpcId === 'string'
    && src.rpcId.indexOf(BRIDGE_RPC_PREFIX) === 0);
}

function isTimeContextMessage(message) {
  const src = message && message.source;
  return !!(src && typeof src === 'object' && src.kind === TIME_CONTEXT_KIND);
}

/**
 * 把同一批消息里的时间注入挪到桥消息前面。
 *
 * @param {Array} messages `agent/pre-step` 决策里的消息列表。
 * @returns {Array|null} 调整后的新数组；不需要动时返回 null（调用方原样返回原决策）。
 */
export function moveTimeContextBeforeBridge(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  let bridgeAt = -1;
  let timeCount = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (isTimeContextMessage(messages[i])) timeCount += 1;
    else if (bridgeAt < 0 && isBridgeMessage(messages[i])) bridgeAt = i;
  }
  if (!timeCount || bridgeAt < 0) return null;
  // 时间注入本来就在正文前面（或正文前面没有时间注入）→ 不用动。
  let timesBefore = 0;
  for (let i = 0; i < bridgeAt; i += 1) if (isTimeContextMessage(messages[i])) timesBefore += 1;
  if (timesBefore === timeCount) return null;

  const times = [];
  const rest = [];
  for (const message of messages) {
    if (isTimeContextMessage(message)) times.push(message);
    else rest.push(message);
  }
  const at = rest.indexOf(messages[bridgeAt]);
  if (at < 0) return null;
  return [...rest.slice(0, at), ...times, ...rest.slice(at)];
}

/**
 * 把这一步的时间注入**折进正文**，只留一条 user 消息。
 *
 * 0.2.7 的兜底排序只在本次请求里改了顺序，会话里两条消息的先后没变：模型到
 * 下一个 step 回头看历史，最后一条 user 消息仍然是时间戳，于是又回一句
 * 「这一轮只收到了时间信息，没有收到正文」——这正是 2026-11-12 复发的那个现象。
 *
 * 折进正文之后，时间行随正文一起提交，历史里不再单独躺着一条时间戳；正文在前、
 * 时间在最后，还带一行说明，模型既拿得到时间，也不会把它当成用户输入。
 *
 * @param {Array} messages 这一步声明、还没提交的消息
 * @returns {Array|null} 折叠后的新数组；没有可折叠的返回 null
 */
export function foldTimeContextIntoBridge(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const bridge = messages.find(isBridgeMessage);
  if (!bridge) return null;
  const times = messages.filter(isTimeContextMessage);
  if (!times.length) return null;
  const timeText = times.map(messageText).filter((t) => t.trim()).join('\n\n');
  if (!timeText) return null;
  const body = messageText(bridge);
  const folded = {
    ...bridge,
    content: [
      { type: 'text', text: `${body}${TIME_FOLD_HEADER}${timeText}` },
      ...(Array.isArray(bridge.content)
        ? bridge.content.filter((part) => part && part.type !== 'text')
        : []),
    ],
  };
  const out = [];
  for (const message of messages) {
    if (isTimeContextMessage(message)) continue;
    out.push(message === bridge ? folded : message);
  }
  return out;
}

/**
 * 在 Host 上注册 `agent/pre-step` 兜底排序。
 *
 * 只在「这一轮同时有桥消息和宿主时间注入」时才重建数组；其它情况原样返回，
 * 所以对用户自己在 DSH 里的对话没有任何影响。
 *
 * @param {object} ctx Cordis 插件上下文。
 * @param {(text: string) => void} [log] 只在真的调整过时打一行日志。
 * @returns {() => void} 取消注册。
 */
export function installInjectOrder(ctx, log) {
  if (!ctx || typeof ctx.on !== 'function') return () => {};
  const handler = async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind === 'reject') return decision;
      const where = payload && payload.turn !== undefined
        ? `turn ${payload.turn} step ${payload.step}`
        : '当前轮';
      // 1) 首选：把时间注入折进正文，只留一条 user 消息（历史里也不会多出时间戳）。
      const folded = foldTimeContextIntoBridge(decision.messages);
      if (folded) {
        if (typeof log === 'function') {
          log(`时间注入已折进正文（${where}）：不再单独成为一条 user 消息，避免模型以为只收到时间戳`);
        }
        return { ...decision, messages: folded };
      }
      // 2) 兜底：这一步只有时间注入、拿不到正文可折时，至少把它挪到正文前面。
      const next2 = moveTimeContextBeforeBridge(decision.messages);
      if (!next2) return decision;
      if (typeof log === 'function') {
        log(`时间注入排在正文后面，已挪到正文前（${where}），避免模型以为只收到时间戳`);
      }
      return { ...decision, messages: next2 };
    } catch {
      return decision;
    }
  };
  let off = null;
  try {
    // prepend：cordis 的 waterfall 是「外层先执行、回来最后收尾」。
    // 时间注入自己也是 prepend 注册的，只有排在它**更外层**才能看到它加完之后的列表。
    off = ctx.on('agent/pre-step', handler, { prepend: true });
  } catch { return () => {}; }
  return () => {
    try {
      if (typeof off === 'function') off();
      else if (off && typeof off.dispose === 'function') off.dispose();
    } catch { /* ignore */ }
  };
}
