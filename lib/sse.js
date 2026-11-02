/**
 * 极简 SSE 广播 + 运行日志。
 * 面板和悬浮球都通过 GET <route>/api/events 订阅；浏览器断开就自动清理。
 */
const MAX_LOGS = 500;
const HEARTBEAT_MS = 25000;

export function createHub() {
  const clients = new Set();
  const logs = [];
  let heartbeat = null;

  function write(res, type, data) {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* 客户端已断开，close 事件会清理 */
    }
  }

  function addClient(res) {
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
    }
    clients.add(res);
    write(res, 'hello', { ok: true, at: new Date().toISOString() });
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const c of clients) write(c, 'ping', { at: Date.now() });
      }, HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    }
    const drop = () => {
      clients.delete(res);
      if (!clients.size && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    res.on('close', drop);
    res.on('error', drop);
    return drop;
  }

  function broadcast(type, payload) {
    for (const c of clients) write(c, type, payload);
  }

  function pushLog(level, message, extra = {}) {
    const entry = { at: new Date().toISOString(), level, message: String(message), ...extra };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    broadcast('log', entry);
    return entry;
  }

  function closeAll() {
    for (const c of clients) {
      try { c.end(); } catch { /* ignore */ }
    }
    clients.clear();
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  return {
    addClient,
    broadcast,
    pushLog,
    closeAll,
    get clientCount() { return clients.size; },
    get logs() { return logs; },
  };
}
