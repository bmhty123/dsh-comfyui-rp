/**
 * 真机端到端：插件真路由 + 真 ComfyUI + 假 DSH 会话。
 *   node tools/test-live.mjs
 *
 * 会真的提交一次 ComfyUI（默认拿导入的旧工作流 DSH-5.5，约 25s/张），
 * 用来验证「投递→解析→覆盖→提交→下载→落盘→图库直链」整条链。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { ROUTE_PATH } from '../lib/meta.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, '..', '_dev-airp-comfy', 'scratch', 'live-data');
const COMFY = process.env.COMFY_BASE || 'http://127.0.0.1:8188';
const FENCE = '```';

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) pass += 1; else fails.push(label);
  console.log(`${cond ? '  ✔' : '  ✘'} ${label}${!cond && extra ? `  ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_REPLY = [
  '①冒烟·窗边',
  'size: 832x1216',
  `${FENCE}text`,
  '1girl, solo, white dress, standing, window, looking outside, soft light',
  '',
  'A girl in a white dress stands by the window. The afternoon light falls across her face. She looks outside quietly.',
  FENCE,
  '',
].join('\n');

function createFakeCtx() {
  const listeners = new Set();
  const sessions = new Map([['s-target', { id: 's-target', title: '桥会话', seq: 0, events: [], running: false }]]);
  const emit = (sid, type, data) => {
    const s = sessions.get(sid);
    s.seq += 1;
    const ev = { type, seq: s.seq, time: Date.now(), data };
    s.events.push(ev);
    for (const fn of [...listeners]) {
      try { fn({ id: sid, sessionId: sid }, ev); } catch { /* ignore */ }
    }
  };
  const sc = {
    async list() {
      return { items: [...sessions.values()].map((s) => ({ sessionId: s.id, updatedAt: Date.now(), projections: { values: { title: s.title } }, agentAvailable: true })) };
    },
    async projections({ sessionId }) { return { values: { title: sessions.get(sessionId)?.title || '' } }; },
    async resolveAgent(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return { error: { code: 'not-found' } };
      return { agent: { get status() { return s.running ? 'running' : 'idle'; }, session: { get seq() { return s.seq; }, snapshotEvents: () => s.events.slice() } } };
    },
    async prompt(request) {
      const s = sessions.get(request.sessionId);
      s.running = true;
      emit(s.id, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: request.content?.[0]?.text || '' }] } });
      setTimeout(() => {
        emit(s.id, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: TARGET_REPLY }] } });
        setTimeout(() => { emit(s.id, 'turn/end', { turn: 1, reason: 'stop' }); s.running = false; }, 20);
      }, 20);
      return { ok: true };
    },
    async cancel() { return { ok: true }; },
    async inspect(sessionId) { return { events: sessions.get(sessionId)?.events.slice() || [] }; },
  };
  const webServer = { port: 0, route: null, register(r) { this.route = r; return () => {}; } };
  const ctx = {
    get(name) { return name === 'webServer' ? webServer : name === 'sessionController' ? sc : null; },
    on(name, fn) { if (name === 'session/event') listeners.add(fn); return () => listeners.delete(fn); },
    effect() {},
  };
  return { ctx, webServer, sessions, emit };
}

async function main() {
  console.log('\n== ComfyRP · 真机端到端 ==');
  console.log(`ComfyUI: ${COMFY}`);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const { ctx, webServer } = createFakeCtx();
  const dispose = apply(ctx, { dataDir: DATA });
  const server = http.createServer((req, res) => webServer.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PATH}`;
  webServer.port = server.address().port;

  async function j(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  const health = await j('GET', '/api/health');
  ok(health.status === 200, '插件路由存活');

  const wf = await j('GET', '/api/workflows');
  const active = (wf.data.workflows || []).find((w) => w.active);
  ok(!!active, `已有启用工作流：${active?.name || ''}`);
  ok(active && active.nodeCount > 10, '工作流 JSON 有节点');

  const cfg = await j('PUT', '/api/config', {
    target: { mode: 'local', sessionId: 's-target', title: '桥会话' },
    comfy: { baseUrl: COMFY, timeoutMs: 600000, pollIntervalMs: 1500 },
    capture: { autoForward: false, autoGenerate: true, timeoutMs: 30000 },
  });
  ok(cfg.status === 200, '配置写入');

  const fwd = await j('POST', '/api/forward', { text: '她站在窗边，午后的光落在她脸上。' });
  ok(fwd.status === 200, '投递返回 job');
  const id = fwd.data?.job?.id;
  ok(!!id, '拿到 jobId');

  let job = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(1000);
    const r = await j('GET', `/api/jobs/${id}`);
    job = r.data?.job || null;
    if (job && ['done', 'error', 'cancelled'].includes(job.status)) break;
  }
  ok(job && job.status === 'done', `任务完成（${job?.status}）`, job?.error || '');
  ok(job && job.sets && job.sets.length === 1, '切出 1 套提示词');
  ok(job && job.images && job.images.length === 1, '出 1 张图');
  const img = job?.images?.[0];
  ok(img && fs.existsSync(img.path), '图片文件在磁盘上');
  ok(img && fs.statSync(img.path).size > 50 * 1024, `图片不是空文件（${img ? Math.round(fs.statSync(img.path).size / 1024) : 0}KB）`);
  ok(job?.overrideReport?.positiveApplied === true, '正面提示词已注入');
  ok(job?.overrideReport?.size?.applied === true, '分辨率已写');
  ok(job?.images?.[0]?.seed !== null, '种子记录');
  const raw = await fetch(`${base}/img/${img.id}`);
  const buf = Buffer.from(await raw.arrayBuffer());
  ok(raw.status === 200 && buf[0] === 0x89, '直链返回 PNG');

  console.log(`\n出图：${img.path}`);
  console.log(`用时：${job.totalMs ? (job.totalMs / 1000).toFixed(1) + 's' : '?'}（ComfyUI ${job.comfyMs ? (job.comfyMs / 1000).toFixed(1) + 's' : '?'}）`);
  console.log(`按 ${job.sets[0].size?.w}×${job.sets[0].size?.h} 出图`);

  await fetch(`${base}/api/recycle/purge`, { method: 'POST' }).catch(() => {});
  dispose();
  server.close();
  console.log(`\n== ${pass} ✔ / ${fails.length} ✘ ==`);
  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error('\n[test-live] 崩溃：', e);
  process.exit(1);
});
