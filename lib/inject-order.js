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
      const next2 = moveTimeContextBeforeBridge(decision.messages);
      if (!next2) return decision;
      if (typeof log === 'function') {
        const where = payload && payload.turn !== undefined
          ? `turn ${payload.turn} step ${payload.step}`
          : '当前轮';
        log(`时间注入排在正文后面，已挪到正文前（${where}），避免模型以为只收到时间戳`);
      }
      return { ...decision, messages: next2 };
    } catch {
      return decision;
    }
  };
  let off = null;
  try { off = ctx.on('agent/pre-step', handler); } catch { return () => {}; }
  return () => {
    try {
      if (typeof off === 'function') off();
      else if (off && typeof off.dispose === 'function') off.dispose();
    } catch { /* ignore */ }
  };
}
