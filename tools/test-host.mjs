/**
 * Host 半区离线端到端自检：node tools/test-host.mjs
 *
 * 不启动 DSH、不碰真 ComfyUI：
 *   · 假 webServer / sessionController / session/event
 *   · 假 ComfyUI（/prompt /history /view /system_stats /object_info）
 *   · 真 HTTP 服务器跑插件的真路由
 *
 * 覆盖：健康检查 / 配置 / 工作流保存与启用 / 投递→解析→出图 / 图片落盘与直链 /
 *       收藏·回收·还原 / 捕获去抖 / 规则预览 / 工作流扫描与干跑 / LoRA 面板。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { pruneUnreachable } from '../lib/comfy.js';
import { continuousTarget, withLoraStrength } from '../lib/jobs.js';
import { applyLoraState } from '../lib/lora.js';
import { createStore } from '../lib/store.js';
import { ROUTE_PATH } from '../lib/meta.js';
import { cleanBodyText } from '../lib/util.js';

let pass = 0;
const fails = [];
function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fails.push(label); console.log(`  ✘ ${label}${extra ? `  ${extra}` : ''}`); }
}
function eq(got, want, label) {
  ok(Object.is(got, want), label, Object.is(got, want) ? '' : `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=',
  'base64',
);
const FENCE = '```';
const TARGET_REPLY = [
  '①测试场景·一',
  'anchor: 她站在窗边，回头看了一眼。',
  'size: 832x1216',
  `${FENCE}text`,
  '1girl, solo, white dress, standing, window',
  '',
  'A girl stands by the window. The light is soft. She looks outside.',
  FENCE,
  '',
  '②测试场景·二',
  'anchor: 她坐到椅子上，把双手交叠放在膝上。',
  'size: 832x1216',
  `${FENCE}text`,
  '1girl, solo, black dress, sitting, chair',
  '',
  'A girl sits on a chair. The room is quiet. She folds her hands.',
  FENCE,
  '',
].join('\n');

/* ------------------------------ 假 ComfyUI ------------------------------ */
function startFakeComfy() {
  let seq = 0;
  const promptIds = [];
  const history = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const send = (status, data) => {
      const body = Buffer.from(JSON.stringify(data));
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seq += 1;
        const id = `p${seq}`;
        promptIds.push({ id, body: JSON.parse(raw || '{}') });
        history.set(id, { filename: `ComfyUI_${String(seq).padStart(5, '0')}_.png` });
        send(200, { prompt_id: id, number: seq, node_errors: {} });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      const hit = history.get(id);
      if (!hit) return send(404, {});
      return send(200, {
        [id]: {
          status: { completed: true, status_str: 'success' },
          outputs: { 9: { images: [{ filename: hit.filename, subfolder: '', type: 'output' }] } },
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      res.end(PNG);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/system_stats') {
      return send(200, { system: { os: 'nt', comfyui_version: 'test' }, devices: [] });
    }
    if (req.method === 'POST' && url.pathname === '/interrupt') return send(200, {});
    if (req.method === 'GET' && url.pathname === '/api/lm/loras/list') return send(404, { error: 'no lora manager' });
    if (req.method === 'GET' && url.pathname === '/object_info/LoraLoader') {
      return send(200, { LoraLoader: { input: { required: { lora_name: [['test.safetensors']] } } } });
    }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      promptIds,
      history,
    }));
  });
}

/* --------------------------- 假 DSH 会话控制器 --------------------------- */
function createFakeCtx() {
  const listeners = new Set();
  const sessions = new Map();
  const cancelled = [];
  let replyText = TARGET_REPLY;
  let emitUserMessage = true;
  function ensure(sid, title) {
    if (!sessions.has(sid)) {
      sessions.set(sid, { id: sid, title: title || sid, seq: 0, events: [], running: false });
    }
    return sessions.get(sid);
  }
  ensure('s-source', '正文会话');
  ensure('s-target', '桥会话');
  ensure('s-archived', '已归档会话');

  function emit(sid, type, data) {
    const s = ensure(sid);
    s.seq += 1;
    const ev = { type, seq: s.seq, time: Date.now(), data };
    s.events.push(ev);
    for (const fn of [...listeners]) {
      try { fn({ id: sid, sessionId: sid }, ev); } catch { /* ignore */ }
    }
    return ev;
  }

  const sc = {
    async list() {
      return {
        items: [...sessions.values()].map((s) => ({
          sessionId: s.id,
          updatedAt: Date.now(),
          projections: { values: { title: s.title } },
          running: s.running,
          agentAvailable: true,
        })),
      };
    },
    async projections({ sessionId }) {
      const s = sessions.get(sessionId);
      return s ? { values: { title: s.title } } : null;
    },
    async resolveAgent(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return { error: { code: 'not-found' } };
      return {
        agent: {
          get status() { return s.running ? 'running' : 'idle'; },
          session: {
            get seq() { return s.seq; },
            snapshotEvents: () => s.events.slice(),
          },
        },
      };
    },
    async prompt(request) {
      const s = ensure(request.sessionId);
      s.running = true;
      const text = request.content?.map((c) => c.text || '').join('') || '';
      if (emitUserMessage) emit(s.id, 'user/message', { message: { role: 'user', content: [{ type: 'text', text }] } });
      setTimeout(() => {
        emit(s.id, 'assistant/message', {
          turn: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
        });
        setTimeout(() => {
          emit(s.id, 'turn/end', { turn: 1, reason: 'stop' });
          s.running = false;
        }, 20);
      }, 30);
      return { ok: true };
    },
    async cancel({ sessionId }) {
      cancelled.push(sessionId);
      const s = sessions.get(sessionId);
      if (s) s.running = false;
      return { ok: true };
    },
    async inspect(sessionId) {
      const s = sessions.get(sessionId);
      return s ? { events: s.events.slice() } : null;
    },
  };

  const webServer = {
    port: 0,
    register(route) {
      webServer.route = route;
      return () => { webServer.route = null; };
    },
    route: null,
  };

  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'sessionController') return sc;
      return null;
    },
    on(name, fn) {
      if (name === 'session/event') listeners.add(fn);
      return () => listeners.delete(fn);
    },
    effect() {},
  };

  return {
    ctx, webServer, sessions, emit, sc, cancelled,
    setReplyText: (text) => { replyText = String(text); },
    setEmitUserMessage: (on) => { emitUserMessage = !!on; },
  };
}

const WORKFLOW = {
  3: {
    class_type: 'KSampler',
    inputs: {
      seed: 123456789, steps: 4, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
    _meta: { title: '采样器' },
  },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' }, _meta: { title: '加载模型' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 }, _meta: { title: '空白潜空间' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] }, _meta: { title: '正面提示词' } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] }, _meta: { title: '负面提示词' } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] }, _meta: { title: '解码' } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'test', images: ['8', 0] }, _meta: { title: '保存图片' } },
};

async function main() {
  console.log('\n== ComfyRP · Host 端到端自检 ==');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airp-comfy-test-'));
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'airp-dsh-home-'));
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: ['s-archived'] },
  }));
  const prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const comfy = await startFakeComfy();
  const { ctx, webServer, sessions, emit, cancelled, setReplyText, setEmitUserMessage } = createFakeCtx();

  // 预置一条旧版图片记录：没有 anchor / turn，只有 jobId 和 setIndex。
  // store 启动时应从 jobs.json 的 job.sets 回填，省得用户为了切图重生成旧图。
  fs.writeFileSync(path.join(dataDir, 'images.json'), JSON.stringify([{
    id: 'img_legacy_anchor', jobId: 'job_legacy_anchor', sessionId: 's-source',
    setIndex: 0, absPath: '', fileName: 'legacy.png', createdAt: '2026-01-01T00:00:00.000Z',
    anchor: '', turn: null, title: '',
  }, {
    id: 'img_legacy_reparse', jobId: 'job_legacy_reparse', sessionId: 's-source',
    setIndex: 0, absPath: '', fileName: 'legacy2.png', createdAt: '2026-01-01T00:00:00.000Z',
    anchor: '', turn: null, title: '',
  }]));
  const legacyReply = [
    '①旧回复场景', 'anchor: 旧回复里的锚点句子。', 'size: 832x1216',
    '```text', '1girl, solo', '', 'She stands by the door.', '```',
  ].join('\n');
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: 'job_legacy_anchor', sourceSessionId: 's-source', sourceTurn: 5,
    sets: [{ title: '旧任务标题', anchor: '她推开门，雨声一下子涌进来。', positive: 'legacy', negative: '' }],
    images: [{ id: 'img_legacy_anchor' }], createdAt: '2026-01-01T00:00:00.000Z',
  }, {
    id: 'job_legacy_reparse', sourceSessionId: 's-source', sourceTurn: 6,
    ruleId: 'contract_v2', replyText: legacyReply,
    sets: [{ title: '旧回复场景', anchor: '', positive: 'legacy', negative: '' }],
    images: [{ id: 'img_legacy_reparse' }], createdAt: '2026-01-01T00:00:00.000Z',
  }]));

  const dispose = apply(ctx, { dataDir });
  ok(typeof dispose === 'function', 'apply 返回 disposer');
  ok(!!webServer.route, 'webServer 路由已注册');
  eq(webServer.route.path, ROUTE_PATH, '路由前缀正确');

  // 模拟旧版：会话目录里有一份 _chat.json；第一次取目录索引时应迁到 output 根。
  const legacyDir = path.join(dataDir, 'output', '旧会话');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, '_chat.json'), JSON.stringify({
    sessionId: 's-legacy', sessionTitle: '旧会话', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', count: 2,
  }));

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
  async function waitJob(id, ms = 15000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      const r = await j('GET', `/api/jobs/${id}`);
      last = r.data?.job || null;
      if (last && ['done', 'error', 'cancelled'].includes(last.status)) return last;
      await sleep(120);
    }
    throw new Error(`任务 ${id} 等超时，最后状态 ${last?.status} ${last?.error || ''}`);
  }

  section('健康检查与状态');
  {
    const r = await j('GET', '/api/health');
    eq(r.status, 200, 'GET /api/health → 200');
    eq(r.data.version, '0.2.1', '版本号');
    const s = await j('GET', '/api/state');
    eq(s.status, 200, 'GET /api/state → 200');
    ok(Array.isArray(s.data.workflows), 'state 带工作流列表');
    ok(Array.isArray(s.data.rules) && s.data.rules.length === 3, 'state 带内置 / 全部 / 自定义三套匹配规则');
    ok(!!s.data.runtime.dataDir, 'state 带数据目录');
    ok(!!s.data.runtime.outputDir, 'state 带输出目录');
    ok(!!s.data.runtime.recycleDir && s.data.runtime.recycleDir.includes('_recycle'), 'state 带回收站目录');
  }

  section('旧图回填 anchor / turn');
  {
    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'images.json'), 'utf8'));
    const legacy = rows.find((r) => r.id === 'img_legacy_anchor');
    eq(legacy?.anchor, '她推开门，雨声一下子涌进来。', '旧图从 job.sets 回填 anchor');
    eq(legacy?.turn, 5, '旧图从 job.sourceTurn 回填 turn');
    eq(legacy?.title, '旧任务标题', '旧图同时补回标题');
    const reparsed = rows.find((r) => r.id === 'img_legacy_reparse');
    eq(reparsed?.anchor, '旧回复里的锚点句子。', '旧自动任务从 replyText 重解析后回到图片记录');
    eq(reparsed?.turn, 6, '重解析的旧图也回填 turn');
    const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8'));
    eq(jobs.find((x) => x.id === 'job_legacy_reparse')?.sets?.[0]?.anchor, '旧回复里的锚点句子。', '旧任务的 job.sets 也补回 anchor');
  }

  section('正文气泡指令清理');
  {
    const raw = '她推开门。@bubble:lin_xiaoman|林小满||[不许关门说。要签可以，当着我签。] 她走了进去。';
    eq(cleanBodyText(raw), '她推开门。|林小满||[不许关门说。要签可以，当着我签。] 她走了进去。', '去掉 @bubble:id，保留 |名字||[台词]');
    eq(cleanBodyText('A@bubble:a|甲||[第一句]B@bubble:b|乙||[第二句]C'), 'A|甲||[第一句]B|乙||[第二句]C', '一行多个气泡只去掉 @bubble:id');
    eq(cleanBodyText('没有指令的正文。'), '没有指令的正文。', '普通正文原样返回');
    eq(cleanBodyText('前面 @bubble:坏 后面'), '前面 后面', '没带竖线的写坏指令也删除');
    eq(cleanBodyText('@bubble:a|甲||[]'), '|甲||[]', '空台词也保留名字和括号');
    eq(cleanBodyText('前文。\n@bubble:a|甲||[台词。]\n后文。'), '前文。\n|甲||[台词。]\n后文。', '独占一行的气泡保留名字 / 台词行');
    eq(cleanBodyText('A@bubble：a|甲||【台词】B'), 'A|甲||【台词】B', '全角冒号 / 方括号也保留名字 / 台词');

    const onlyPreview = await j('POST', '/api/capture', {
      sessionId: 's-source', preview: true, text: '@bubble:坏',
    });
    eq(onlyPreview.data.text, '', '写坏的空气泡预览为空');
    eq(onlyPreview.data.emptied, true, '清理后为空的预览会明确标记');
    const onlyForward = await j('POST', '/api/forward', { text: '@bubble:坏' });
    eq(onlyForward.status, 400, '写坏的空气泡投递被拒绝');
    ok(String(onlyForward.data.error || '').includes('@bubble'), '明确提示是 @bubble 清理后为空');
  }

  section('配置');
  {
    const active = await j('POST', '/api/active-session', { sessionId: 's-source', title: '' });
    eq(active.data.title, '正文会话', 'active-session 空标题会补查会话名');
    const activeState = await j('GET', '/api/state');
    eq(activeState.data.activeSessionTitle, '正文会话', 'state 里的当前会话名已补齐');
    eq(activeState.data.capture.source.title, '正文会话', '正文来源跟着当前会话显示会话名');
    const c0 = await j('GET', '/api/config');
    eq(c0.data.config.source.followActive, true, '正文来源默认勾选「本会话」');
    eq(c0.data.config.capture.clearAfterSend, true, '投递后自动留空默认开');
    eq(c0.data.config.capture.autoGenerate, false, '首次安装自动出图默认关');
    const r = await j('PUT', '/api/config', {
      source: { followActive: false, mode: 'local', sessionId: 's-source', title: '正文会话' },
      target: { mode: 'local', sessionId: 's-target', title: '桥会话' },
      comfy: { baseUrl: comfy.baseUrl, timeoutMs: 20000, pollIntervalMs: 100 },
      capture: { autoForward: false, autoGenerate: true, timeoutMs: 10000 },
    });
    eq(r.status, 200, 'PUT /api/config → 200');
    eq(r.data.config.source.followActive, false, '取消勾选「本会话」写进去了');
    eq(r.data.config.target.sessionId, 's-target', '桥会话写进去了');
    eq(r.data.config.comfy.baseUrl, comfy.baseUrl, 'ComfyUI 地址写进去了');
    eq(r.data.config.capture.autoForward, false, '自动投递先关掉（后面单独测）');
    eq(r.data.config.capture.customTags.title, '</标题>', '带默认自定义闭合标签');
    const blankTarget = await j('PUT', '/api/config', { target: { mode: 'local', sessionId: '', title: '' } });
    eq(blankTarget.data.config.target.sessionId, 's-target', '刷新时 blank sessionId 不会抹掉已保存的提示词来源');
    const onlySrc = await j('POST', '/api/forward-source', { text: '@bubble:坏' });
    eq(onlySrc.status, 400, '正文来源手写是写坏气泡时投递被拒绝');
  }

  section('接口安全');
  {
    // 跨站页面发 no-cors POST 也会带自己的 Origin：必须拒绝。
    const evil = await fetch(base + '/api/active-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ sessionId: 's-evil' }),
    });
    eq(evil.status, 403, '跨站 Origin 的写请求被拒绝');
    const evil2 = await fetch(base + '/api/active-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ sessionId: 's-evil' }),
    });
    eq(evil2.status, 403, 'Sec-Fetch-Site: cross-site 的写请求被拒绝');
    const same = await fetch(base + '/api/active-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
      body: JSON.stringify({ sessionId: 's-source' }),
    });
    eq(same.status, 200, '同源写请求正常');

    emit('s-source', 'assistant/message', {
      turn: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: '安全测试正文。' }] },
    });
    await j('PUT', '/api/config', { source: { token: 'token-abc' } });
    const noToken = await j('GET', '/api/session-text?sessionId=s-source');
    eq(noToken.status, 401, '配了口令后远程读正文不带口令被拒绝');
    const withToken = await fetch(base + '/api/session-text?sessionId=s-source', {
      headers: { 'x-prompt-relay-token': 'token-abc' },
    });
    const withTokenText = await withToken.text();
    eq(withToken.status, 200, '带对共享口令可以读正文 ' + withTokenText.slice(0, 160));
    const noAsk = await fetch(base + '/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-source', text: 'x' }),
    });
    eq(noAsk.status, 401, '配了口令后远程投递不带口令被拒绝');
    await noAsk.text();
    const noStream = await fetch(base + '/api/stream?sessionId=s-source');
    eq(noStream.status, 401, '配了口令后远程 SSE 不带口令被拒绝');
    await noStream.text();

    const health = await j('GET', '/api/health');
    ok(!JSON.stringify(health.data).includes('token-abc'), 'health 不泄露共享口令');
    await j('PUT', '/api/config', { source: { token: '' } });
  }

  section('会话列表');
  {
    const r = await j('GET', '/api/sessions?mode=local');
    eq(r.status, 200, 'GET /api/sessions → 200');
    ok(r.data.sessions.some((s) => s.sessionId === 's-target'), '列到了桥会话');
    ok(r.data.sessions.some((s) => s.displayTitle === '桥会话'), '标题带出来了');
    ok(!r.data.sessions.some((s) => s.sessionId === 's-archived'), 'workspace.json 里的归档会话被排除');
  }

  section('检测：刷新会话列表与名称');
  {
    // 模拟刚开、controller.list() 还没来得及带标题的新会话。
    sessions.set('s-fresh', { id: 's-fresh', title: '新开的对话', seq: 0, events: [], running: false, cwd: '' });
    const r = await j('POST', '/api/sessions/refresh', { sessionId: 's-fresh' });
    eq(r.status, 200, 'POST /api/sessions/refresh → 200');
    eq(r.data.active.title, '新开的对话', '检测读到新会话名称');
    ok(r.data.sessions.some((s) => s.sessionId === 's-fresh' && s.displayTitle === '新开的对话'), '新会话进入可用列表');
    const st = await j('GET', '/api/state');
    eq(st.data.activeSessionTitle, '新开的对话', 'state 里的当前会话名已更新');
    // 恢复原来的当前会话，后面的用例仍按 s-source 走。
    const back = await j('POST', '/api/sessions/refresh', { sessionId: 's-source' });
    eq(back.data.active.title, '正文会话', '切回正文会话也能读到名称');
    ok(!r.data.sessions.some((s) => s.sessionId === 's-archived'), '刷新排除归档会话');

    // 改名后立即刷新：必须重新读 projection，而不是拿 list 里的旧标题。
    sessions.get('s-target').title = '桥会话改名';
    const renamed = await j('POST', '/api/sessions/refresh', {});
    eq((renamed.data.sessions.find((s) => s.sessionId === 's-target') || {}).displayTitle, '桥会话改名', '刷新真正重读未归档会话名称');
    const cfgRenamed = await j('GET', '/api/config');
    eq(cfgRenamed.data.config.target.title, '桥会话改名', '刷新把提示词来源名称也更新了');
    sessions.get('s-target').title = '桥会话';
    await j('POST', '/api/sessions/refresh', {});
  }

  section('工作流保存 / 启用 / 扫描');
  let wfId = '';
  {
    const r = await j('POST', '/api/workflows', { name: '测试工作流', json: WORKFLOW });
    eq(r.status, 200, 'POST /api/workflows → 200');
    wfId = r.data.workflow.id;
    ok(!!wfId, '拿到工作流 id');
    eq(r.data.workflow.outputNodes.length, 1, '保存时默认勾选识别到的输出节点');
    eq(String(r.data.workflow.outputNodes[0]), '9', '默认勾选的是 SaveImage #9');
    eq(r.data.workflow.tokenEmpty, 'blank', '占位符为空时固定替换成空字符串');
    const p = await j('PUT', `/api/workflows/${wfId}`, {
      size: { w: 832, h: 1216 }, sizeMode: 'dsh', outputNodes: ['9'], tokenEmpty: 'keep',
    });
    eq(p.status, 200, 'PUT 工作流（分辨率 / 输出节点）→ 200');
    eq(p.data.workflow.tokenEmpty, 'blank', '旧 tokenEmpty=keep 被忽略，仍替换成空字符串');
    const lp = await j('PUT', `/api/workflows/${wfId}`, { loraState: { stacks: {}, switches: {} } });
    eq(lp.status, 200, 'PUT 工作流（只保存 LoRA 覆盖）→ 200');
    eq(lp.data.workflow.outputNodes.length, 1, '只保存 LoRA 覆盖不会重置输出节点');
    eq(String(lp.data.workflow.outputNodes[0]), '9', '输出节点仍是原来的 SaveImage #9');
    eq(!!lp.data.workflow.loraState, true, 'LoRA 覆盖写进了工作流记录');
    const a = await j('POST', `/api/workflows/${wfId}/activate`);
    eq(a.status, 200, '启用工作流 → 200');
    const scan = await j('POST', '/api/workflows/scan', { workflowId: wfId });
    eq(scan.status, 200, '扫描 → 200');
    ok(scan.data.nodes.length >= 3, '扫到正/负面/分辨率节点');
    eq(scan.data.tokens.positive, 1, '识别到 1 个 %prompt%');
    eq(scan.data.tokens.width, 1, '识别到 1 个 %width%');
    eq(scan.data.outputs.length, 1, '识别到 1 个输出节点');
    eq(scan.data.defaultOutputIds.length, 1, '默认输出节点只给一个');
    eq(String(scan.data.defaultOutputIds[0]), '9', '默认输出节点是 SaveImage #9');
    const multiJson = {
      ...WORKFLOW,
      10: { class_type: 'PreviewImage', inputs: { images: ['8', 0] }, _meta: { title: '预览' } },
    };
    const multiScan = await j('POST', '/api/workflows/scan', { json: multiJson });
    eq(multiScan.data.outputs.length, 2, '多输出工作流识别到两个输出节点');
    eq(multiScan.data.defaultOutputIds.length, 1, '多输出时默认仍只给一个');
    eq(String(multiScan.data.defaultOutputIds[0]), '9', '多输出时优先标准 SaveImage');
    const multiSave = await j('POST', '/api/workflows', { name: '多输出测试', json: multiJson });
    eq(multiSave.data.workflow.outputNodes.length, 1, '保存多输出工作流时默认只勾一个');
    eq(String(multiSave.data.workflow.outputNodes[0]), '9', '保存时默认勾标准 SaveImage');
    await j('DELETE', `/api/workflows/${multiSave.data.workflow.id}`);
    const kindScan = await j('POST', '/api/workflows/scan', {
      json: {
        ...WORKFLOW,
        20: { class_type: 'LoraLoader', inputs: { lora_name: 'a.safetensors' } },
        21: { class_type: 'LoraManager', inputs: { loras: [{ name: 'b.safetensors', active: true }] } },
        22: { class_type: 'StringNode', inputs: { value: 'hello' } },
        23: { class_type: 'CLIPTextEncode', _meta: { title: '负面提示词' }, inputs: { text: 'bad hands' } },
      },
    });
    const byId = Object.fromEntries(kindScan.data.nodes.map((n) => [String(n.id), n]));
    eq(byId['6']?.kind, 'token', '提示词占位符节点分类为 token');
    eq(byId['6']?.label, '占位符%prompt%', '占位符气泡名');
    eq(byId['6']?.hint, '建议映射为正面提示词', '占位符气泡提示');
    eq(byId['7']?.label, '占位符%negative_prompt%', '负面占位符气泡名');
    eq(byId['23']?.kind, 'negative', '负面提示词节点分类');
    eq(byId['23']?.hint, '若想保留原工作流的负面提示词，选择保留原内容', '负面提示词气泡提示');
    eq(byId['5']?.kind, 'size', '分辨率节点分类');
    eq(byId['5']?.hint, '建议映射为分辨率', '分辨率节点提示');
    eq(byId['20']?.kind, 'lora', '单 LoraLoader 分类为 lora');
    eq(byId['21']?.kind, 'loraStack', 'inputs.loras 分类为 lora堆');
    eq(byId['21']?.label, 'lora堆', 'lora堆气泡名');
    eq(byId['21']?.hint, '建议保留原内容', 'lora堆提示保留原内容');
    eq(byId['22']?.kind, 'unknown', '无法识别的文本节点归未知');
    ok(byId['22']?.hint.includes('映射会将整段原有内容替换'), '未知节点提示会整段替换');
    ok(!byId['3'], '不列出 KSampler 这类无关节点');
    // 抄 dsh-tavern-image 的作业：从采样器 positive / negative 连线反推真正写字的节点。
    const graphScan = await j('POST', '/api/workflows/scan', {
      json: {
        ...WORKFLOW,
        26: { class_type: 'KSampler', inputs: { positive: ['24', 0], negative: ['27', 0] } },
        24: { class_type: 'CLIPTextEncode', inputs: { text: ['25', 0] } },
        25: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a girl, solo' } },
        27: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['28', 0] } },
        28: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'bad stuff' } },
      },
    });
    const graphById = Object.fromEntries(graphScan.data.nodes.map((n) => [String(n.id), n]));
    eq(graphById['25']?.kind, 'positive', '没有标题线索时，顺着采样器 positive 连线认出上游文本节点');
    eq(graphById['25']?.suggestRole, 'positive', '上游文本节点自动建议映射为正面');
    ok(graphById['28']?.kind !== 'negative', 'ConditioningZeroOut 后面的文本不会被误认成负面');
    const dualDry = await j('POST', '/api/workflows/dry-run', {
      json: {
        ...WORKFLOW,
        40: { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'old g', text_l: 'old l' } },
      },
      positive: 'new prompt', includeJson: true, mapping: { 40: 'positive' },
    });
    eq(dualDry.data.json['40'].inputs.text_g, 'new prompt', 'SDXL 双文本节点 text_g 被映射写入');
    eq(dualDry.data.json['40'].inputs.text_l, 'new prompt', 'SDXL 双文本节点 text_l 也一起写入');
    const orphan = pruneUnreachable({
      ...WORKFLOW,
      99: { class_type: 'KSampler', inputs: { seed: 1 } },
    }, ['9']);
    ok(orphan.removed.includes('99'), '提交前裁掉和输出不连通的孤立节点');
    ok(!orphan.workflow['99'], '孤立节点不再进入 /prompt');
    ok(!!orphan.workflow['3'] && !!orphan.workflow['9'], '输出依赖链上的节点都保留');
    const dry = await j('POST', '/api/workflows/dry-run', {
      workflowId: wfId, positive: 'a girl', negative: 'bad', size: { w: 832, h: 1216 },
    });
    eq(dry.status, 200, '干跑 → 200');
    eq(dry.data.report.positiveApplied, true, '干跑：正面已注入');
    ok(dry.data.report.size.applied, '干跑：分辨率已写');
    const loraJson = {
      ...WORKFLOW,
      12: { class_type: 'LoraLoader', inputs: { loras: { __value__: [{ name: 'a.safetensors', active: true, strength: 0.8 }] } } },
      13: { class_type: 'LoraLoader', inputs: { loras: { __value__: [{ name: 'b.safetensors', active: true, strength: 1 }] } } },
      14: { class_type: 'LoraLoader', inputs: { loras: { __value__: [{ name: 'c.safetensors', active: false, strength: 1 }] } } },
    };
    const loraDry = await j('POST', '/api/workflows/dry-run', {
      workflowId: wfId, json: loraJson, positive: 'a girl', size: { w: 832, h: 1216 },
    });
    eq(loraDry.status, 200, '带 LoRA 的干跑 → 200');
    eq(loraDry.data.loraDetected.stacks, 3, '干跑如实报检测到 3 个 LoRA 堆（没有两堆上限）');
    eq(loraDry.data.loraDetected.entries, 3, '干跑如实报 3 个 LoRA 条目');
  }

  section('投递 → 解析 → 出图');
  let jobId = '';
  let job1 = null;
  {
    const r = await j('POST', '/api/forward', { text: '她站在窗边，回头看了一眼。', sourceTurn: 3 });
    eq(r.status, 200, 'POST /api/forward → 200');
    jobId = r.data.job.id;
    job1 = await waitJob(jobId);
    eq(job1.status, 'done', `任务完成（${job1.status}）`, job1.error || '');
    eq(job1.sets.length, 2, '契约切出 2 套');
    eq(job1.sets[0].anchor, '她站在窗边，回头看了一眼。', '自动投递的 job.sets 保留原文锚点');
    eq(job1.images.length, 2, '出了 2 张图');
    eq(job1.images[0].anchor, '她站在窗边，回头看了一眼。', '生成的图片记录带原文锚点');
    eq(job1.images[0].turn, 3, '生成的图片记录带来源 turn');
    ok(job1.images.every((im) => fs.existsSync(im.path)), '图片文件都在磁盘上');
    ok(job1.images.every((im) => im.seed !== null), '种子记录下来了');
    ok(job1.images[0].title.includes('测试场景'), '标题跟图一起存');
    eq(job1.sawOwnPrompt, true, '确认是自己的投递');
    eq(comfy.promptIds.length, 2, 'ComfyUI 收到 2 次提交');
    const promptText = JSON.stringify(comfy.promptIds[0].body);
    ok(promptText.includes('white dress'), '第一套提示词进了工作流');
    const w = comfy.promptIds[0].body.prompt['6'].inputs.text;
    ok(w.includes('A girl stands'), '正面 = tag + NL');
    eq(comfy.promptIds[0].body.prompt['5'].inputs.width, 832, 'width 写成数字 832');
    eq(comfy.promptIds[0].body.prompt['5'].inputs.height, 1216, 'height 写成数字 1216');
  }

  section('正文 @bubble 指令不会投给提示词会话');
  {
    const raw = '她推开门。@bubble:lin_xiaoman|林小满||[不许关门说。要签可以，当着我签。] 她走了进去。';
    const r = await j('POST', '/api/forward', {
      text: raw, ownerSessionId: 's-bubble', ownerSessionTitle: '气泡测试',
    });
    eq(r.status, 200, '气泡正文投递 → 200');
    const done = await waitJob(r.data.job.id);
    eq(done.status, 'done', '气泡正文任务完成', done.error || '');
    eq(done.text, '她推开门。|林小满||[不许关门说。要签可以，当着我签。] 她走了进去。', 'job.text 只去掉 @bubble:id，保留名字 / 台词');
    ok(!String(done.outgoingText).includes('@bubble'), '投给提示词会话的正文没有 @bubble');
    ok(String(done.outgoingText).includes('林小满') && String(done.outgoingText).includes('不许关门说'), '名字和台词仍会投给提示词会话');
    eq(done.images.length, 2, '气泡正文照常出图');

    emit('s-source', 'assistant/message', {
      turn: 5,
      message: { role: 'assistant', content: [{ type: 'text', text: '正文。@bubble:a|甲||[台词。] 结束。' }] },
    });
    const p = await j('POST', '/api/capture', { sessionId: 's-source', preview: true });
    eq(p.data.text, '正文。|甲||[台词。] 结束。', '捕获 / 预览正文也保留气泡名字 / 台词');
  }

  section('宿主不上报用户消息时不误报');
  {
    setEmitUserMessage(false);
    const r = await j('POST', '/api/forward', { text: '程序化投递，宿主没有用户消息事件，但回复是这一轮的。' });
    const job = await waitJob(r.data.job.id);
    eq(job.status, 'done', '没有 user/message 也能完成', job.error || '');
    eq(job.sawOwnPrompt, null, '没有用户消息时确认状态是未知，不是 false');
    ok(!String(job.warn || '').includes('没法确认'), '不再弹「没法确认是这次投递」');
    setEmitUserMessage(true);
  }

  section('提示词来源正文');
  {
    const r = await j('POST', '/api/prompt-source/text');
    eq(r.status, 200, 'POST /api/prompt-source/text → 200');
    ok(String(r.data.text || '').includes('①测试场景'), '提示词来源返回最新助手正文');
    eq(r.data.mode, 'local', '提示词来源标成本进程');
    const direct = await j('GET', '/api/session-text?sessionId=s-target');
    eq(direct.status, 200, 'GET /api/session-text → 200');
    ok(String(direct.data.text || '').includes('①测试场景'), '会话正文接口按 id 读取');
    const origin = new URL(base).origin;
    await j('PUT', '/api/config', {
      target: { mode: 'remote', baseUrl: origin, routePath: ROUTE_PATH, sessionId: 's-target', title: '桥会话' },
    });
    const remote = await j('POST', '/api/prompt-source/text');
    eq(remote.status, 200, '远程提示词来源正文 → 200');
    eq(remote.data.mode, 'remote', '远程提示词来源标记正确');
    ok(String(remote.data.text || '').includes('①测试场景'), '远程会话正文接口能读到最新助手回复');
    await j('PUT', '/api/config', { target: { mode: 'local', baseUrl: '', sessionId: 's-target', title: '桥会话' } });
  }

  section('附加消息（最上面 / 最下面 / 空不启用）');
  {
    const target = sessions.get('s-target');
    const userTexts = () => target.events
      .filter((e) => e.type === 'user/message')
      .map((e) => (e.data?.message?.content || []).map((x) => x.text || '').join(''));
    const topMarker = '（附加消息·最上面）';
    await j('PUT', '/api/config', { capture: { extraMessage: topMarker, extraPosition: 'top' } });
    const r = await j('POST', '/api/forward', { text: '附加消息最上面正文' });
    const done = await waitJob(r.data.job.id);
    eq(done.status, 'done', '附加消息置顶任务完成', done.error || '');
    const sentTop = userTexts().at(-1) || '';
    ok(sentTop.startsWith('【基础消息】'), '基础消息永远在第一条');
    ok(sentTop.indexOf(topMarker) < sentTop.indexOf('【正文】'), '侧边栏附加消息原样放在正文前面');
    ok(sentTop.includes('【正文】') && sentTop.includes('附加消息最上面正文') && sentTop.includes('【/正文】'), '正文被【正文】简单包裹');
    ok(sentTop.includes('【基础消息】') && sentTop.includes('生成 3 套提示词'), '每次投递都有基础消息，并写明生成几套');

    const bottomMarker = '（附加消息·最下面）';
    await j('PUT', '/api/config', { capture: { extraMessage: bottomMarker, extraPosition: 'bottom' } });
    const r2 = await j('POST', '/api/forward', { text: '附加消息最下面正文' });
    const done2 = await waitJob(r2.data.job.id);
    eq(done2.status, 'done', '附加消息置底任务完成', done2.error || '');
    const sentBottom = userTexts().at(-1) || '';
    ok(sentBottom.endsWith('\n\n' + bottomMarker), '侧边栏附加消息原样放在最下面');
    ok(sentBottom.includes('【正文】') && sentBottom.includes('附加消息最下面正文') && sentBottom.includes('【/正文】'), '置底时正文仍被【正文】包裹');
    ok(sentBottom.indexOf('【/正文】') < sentBottom.indexOf(bottomMarker), '置底时附加消息在正文包裹之后');

    const before = userTexts().length;
    await j('PUT', '/api/config', { capture: { extraMessage: '   ', extraPosition: 'top' } });
    const r3 = await j('POST', '/api/forward', { text: '空附加消息正文' });
    const done3 = await waitJob(r3.data.job.id);
    eq(done3.status, 'done', '空附加消息任务完成', done3.error || '');
    ok(userTexts().length > before, '空附加消息仍然正常投递');
    const sentEmpty = userTexts().at(-1) || '';
    ok(sentEmpty.includes('【基础消息】'), '没有附加消息时基础消息仍存在');
    ok(sentEmpty.includes('【正文】') && sentEmpty.includes('空附加消息正文') && sentEmpty.includes('【/正文】'), '空白附加消息不启用，正文仍被包裹');
    await j('PUT', '/api/config', { capture: { extraMessage: '', extraPosition: 'top' } });
  }

  section('图片列表 / 直链');
  let imgId = '';
  {
    const r = await j('GET', '/api/images?page=1&size=24');
    eq(r.status, 200, 'GET /api/images → 200');
    ok(r.data.total >= 2, '列表里有图');
    imgId = r.data.items[0].id;
    const raw = await fetch(`${base}/img/${imgId}`);
    eq(raw.status, 200, 'GET /img/<id> → 200');
    const buf = Buffer.from(await raw.arrayBuffer());
    ok(buf[0] === 0x89 && buf[1] === 0x50, '返回的是真 PNG');
    eq(raw.headers.get('cache-control'), 'private, max-age=604800, immutable', '图片有 immutable 浏览器缓存');
    ok(!!raw.headers.get('last-modified'), '图片返回 Last-Modified');
    const etag = raw.headers.get('etag');
    const notMod = await fetch(`${base}/img/${imgId}`, { headers: { 'If-None-Match': etag } });
    eq(notMod.status, 304, 'ETag 命中返回 304');
    const rec = await j('GET', `/api/images/${imgId}`);
    ok(rec.data.image.positive.includes('white dress') || rec.data.image.positive.includes('black dress'), '单张记录带提示词');
  }

  section('收藏 / 取消收藏');
  {
    const f = await j('POST', `/api/images/${imgId}/favorite`);
    eq(f.status, 200, '收藏 → 200');
    const favRoot = path.join(dataDir, 'output', '_favorites');
    eq(path.dirname(f.data.to), favRoot, '收藏副本直接放在 _favorites 根目录，不再按会话分文件夹');
    const list = await j('GET', '/api/favorites');
    ok(list.data.total >= 1, '收藏夹里有 1 张');
    // 收藏副本被外部删掉：收藏夹同步应清掉失效收藏记录，原图不动。
    fs.unlinkSync(f.data.to);
    const sync = await j('POST', '/api/images/sync', { apply: true, favorites: true });
    eq(sync.status, 200, '收藏夹同步 → 200');
    eq(sync.data.favorites.removed, 1, '收藏夹同步清掉 1 条失效收藏');
    const listAfterSync = await j('GET', '/api/favorites');
    eq(listAfterSync.data.total, 0, '同步后收藏夹不再有黑图记录');
    const u = await j('POST', `/api/images/${imgId}/unfavorite`);
    eq(u.status, 200, '取消收藏 → 200');
    const list2 = await j('GET', '/api/favorites');
    eq(list2.data.total, 0, '收藏夹清空');
  }

  section('回收站 / 还原');
  {
    const r = await j('POST', `/api/images/${imgId}/recycle`);
    eq(r.status, 200, '回收 → 200');
    ok(r.data.to.includes('_recycle'), '搬进 _recycle');
    const again = await j('POST', `/api/images/${imgId}/recycle`);
    eq(again.status, 200, '重复回收仍返回 200');
    eq(again.data.already, true, '重复回收被识别为 already');
    const bin = await j('GET', '/api/recycle');
    ok(bin.data.total >= 1, '回收站里有 1 张');
    const list = await j('GET', '/api/images?page=1&size=24');
    ok(!list.data.items.some((i) => i.id === imgId), '列表里不再显示');
    const back = await j('POST', `/api/images/${imgId}/restore`);
    eq(back.status, 200, '还原 → 200');
    const list2 = await j('GET', '/api/images?page=1&size=24');
    ok(list2.data.items.some((i) => i.id === imgId), '列表里又出现了');
  }

  section('规则预览');
  {
    const r = await j('GET', '/api/rules');
    eq(r.data.rules.length, 3, '三套规则');
    const p = await j('POST', '/api/rule/preview', { text: TARGET_REPLY });
    eq(p.data.sets.length, 2, '预览切出 2 套');
    eq(p.data.sets[0].title, '测试场景·一', '标题正确');
    eq(p.data.sets[0].size.w, 832, 'size 正确');
    const anchored = [
      '①锚点场景', 'anchor: 她推开门，雨声一下子涌进来。', 'size: 832x1216',
      `${FENCE}text`, '1girl, solo, standing, doorway', '', 'She opens the door. Rain pours in.', FENCE,
    ].join('\n');
    const pa = await j('POST', '/api/rule/preview', { text: anchored });
    eq(pa.data.sets.length, 1, '带 anchor 的预览切出 1 套');
    eq(pa.data.sets[0].anchor, '她推开门，雨声一下子涌进来。', '规则预览接口把 anchor 返回给工作台');
    eq(pa.data.sets[0].title, '锚点场景', '带 anchor 的预览仍保留标题');
    const chat = await j('POST', '/api/rule/preview', { text: '这是一段闲聊，没有标题也没有围栏。' });
    eq(chat.data.nonDelivery, true, '闲聊判为非交付');

    const all = await j('POST', '/api/rule/preview', { ruleId: 'all_text', text: 'one girl\n\nstanding by the window.' });
    eq(all.data.sets.length, 1, '全部匹配只出 1 套');
    ok(all.data.sets[0].positive.includes('standing by the window'), '全部匹配保留整条正文');

    const tags = { title: '[[/T]]', size: '[[/S]]', positive: '[[/P]]', negative: '[[/N]]' };
    const customText = [
      '[[T]]一[[/T]]', '[[S]]832x1216[[/S]]', '[[P]]a, b[[/P]]', '[[N]]blur[[/N]]',
      '[[T]]二[[/T]]', '[[S]]1024x1024[[/S]]', '[[P]]c, d[[/P]]', '[[N]][[/N]]',
    ].join('\n');
    const custom = await j('POST', '/api/rule/preview', { ruleId: 'custom_tags', text: customText, customTags: tags });
    eq(custom.data.sets.length, 2, '自定义预览切出 2 套');
    eq(custom.data.sets[1].title, '二', '自定义标题正确');
    eq(custom.data.sets[0].negative, 'blur', '自定义负面正确');

    await j('PUT', '/api/config', { capture: { matchRule: 'custom_tags', customTags: tags } });
    const viaCfg = await j('POST', '/api/rule/preview', { text: customText });
    eq(viaCfg.data.sets.length, 2, '配置里的自定义标签会被预览使用');
    await j('PUT', '/api/config', { capture: { matchRule: 'contract_v2' } });
  }

  section('捕获（自动投递）');
  {
    await j('PUT', '/api/config', { capture: { autoForward: true, autoGenerate: true, timeoutMs: 10000 } });
    await sleep(300); // 等 capture 重建
    const text = '第二段正文：她坐到椅子上，把双手交叠放在膝上，房间很安静。';
    emit('s-source', 'assistant/message', {
      turn: 9,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    // 去抖 900ms + 投递 + 出图
    let found = null;
    for (let i = 0; i < 60 && !found; i += 1) {
      await sleep(250);
      const list = await j('GET', '/api/jobs?limit=8');
      found = (list.data.jobs || []).find((x) => x.source === 'capture' && x.sourceSessionId === 's-source');
    }
    ok(!!found, '捕获产生了一条任务');
    const done = found ? await waitJob(found.id) : null;
    eq(done?.status, 'done', '捕获任务出图完成', done?.error || '');
    eq(done?.images.length, 2, '捕获任务也是 2 张');

    // 自动投递和手动投递是同一套组装：侧边栏附加消息也必须带上。
    const capTarget = sessions.get('s-target');
    const capUserTexts = () => capTarget.events
      .filter((e) => e.type === 'user/message')
      .map((e) => (e.data?.message?.content || []).map((x) => x.text || '').join(''));
    const capMarker = '（自动投递附加消息）';
    await j('PUT', '/api/config', { capture: { extraMessage: capMarker, extraPosition: 'top', clearAfterSend: false } });
    const capBody = '自动投递要带附加消息的正文。';
    emit('s-source', 'assistant/message', {
      turn: 11,
      message: { role: 'assistant', content: [{ type: 'text', text: capBody }] },
    });
    let capJob = null;
    for (let i = 0; i < 60 && !capJob; i += 1) {
      await sleep(250);
      const list = await j('GET', '/api/jobs?limit=8');
      capJob = (list.data.jobs || []).find((x) => x.source === 'capture' && x.sourceSessionId === 's-source'
        && Number(x.sourceTurn) === 11);
    }
    ok(!!capJob, '自动投递产生了第二条任务');
    const capDone = capJob ? await waitJob(capJob.id) : null;
    eq(capDone?.status, 'done', '自动投递任务完成', capDone?.error || '');
    const capSent = capUserTexts().at(-1) || '';
    ok(capSent.includes(capMarker), '自动投递也带上侧边栏附加消息', capSent);
    ok(capSent.includes('【正文】') && capSent.includes(capBody), '自动投递正文仍在【正文】里');
    await j('PUT', '/api/config', { capture: { extraMessage: '', extraPosition: 'top', clearAfterSend: true } });
  }

  section('悬浮球手动抓当前会话');
  {
    emit('s-source', 'assistant/message', {
      turn: 10,
      message: { role: 'assistant', content: [{ type: 'text', text: '第三段正文：她推开门，外面的雨声涌了进来。' }] },
    });
    const p = await j('POST', '/api/capture', { sessionId: 's-source', forward: false });
    eq(p.status, 200, '预览当前会话正文 → 200');
    ok(p.data.text.includes('第三段正文'), '抓到的是最后一条助手回复');
  }

  section('手动投递按正文来源（不是当前会话）');
  {
    await j('PUT', '/api/config', {
      source: { followActive: false, mode: 'local', sessionId: 's-source', title: '正文会话' },
      target: { mode: 'local', sessionId: 's-target', title: '桥会话' },
    });
    await j('POST', '/api/active-session', { sessionId: 's-target', title: '桥会话' });
    const target = sessions.get('s-target');
    const usersBefore = target.events.filter((e) => e.type === 'user/message').length;
    const r = await j('POST', '/api/forward-source', { autoGenerate: true });
    eq(r.status, 200, 'POST /api/forward-source → 200');
    const done = await waitJob(r.data.job.id);
    eq(done.status, 'done', '正文来源手动投递任务完成', done.error || '');
    eq(done.sourceSessionId, 's-source', '手动投递的来源是正文来源会话');
    eq(done.ownerSessionId, 's-target', '图片归属仍是当前会话');
    const users = target.events.filter((e) => e.type === 'user/message');
    ok(users.length > usersBefore, '桥会话收到了一次手动投递');
    const sent = (users.at(-1)?.data?.message?.content || []).map((x) => x.text || '').join('');
    ok(sent.includes('第三段正文'), '手动抓的是正文来源的最后一条助手回复');
  }

  section('概览正文框：预览与手写正文');
  {
    const target = sessions.get('s-target');
    const jobsBefore = (await j('GET', '/api/jobs?limit=80')).data.jobs.length;
    const usersBeforePreview = target.events.filter((e) => e.type === 'user/message').length;
    const p = await j('POST', '/api/body-source/preview');
    eq(p.status, 200, '预览正文来源最新回复 → 200');
    ok(String(p.data.text || '').includes('第三段正文'), '正文框能读到正文来源最新回复');
    eq(p.data.sessionId, 's-source', '预览带上正文来源会话');
    eq(p.data.turn, 10, '预览带上正文来源轮次');
    eq((await j('GET', '/api/jobs?limit=80')).data.jobs.length, jobsBefore, '预览只读，不创建投递任务');
    eq(target.events.filter((e) => e.type === 'user/message').length, usersBeforePreview, '预览只读，不往桥会话发消息');

    const custom = '手写正文：她把窗推开，雨声一下子涌进来。';
    const before = target.events.filter((e) => e.type === 'user/message').length;
    const r = await j('POST', '/api/forward-source', { autoGenerate: true, text: custom, sourceTurn: 10 });
    eq(r.status, 200, '手写正文投递 → 200');
    eq(r.data.text, custom, '投递结果回显手写正文');
    const done = await waitJob(r.data.job.id);
    eq(done.status, 'done', '手写正文任务完成', done.error || '');
    eq(done.sourceSessionId, 's-source', '手写正文仍记录正文来源会话');
    eq(done.sourceTurn, 10, '手写正文保留来源轮次');
    const users = target.events.filter((e) => e.type === 'user/message');
    ok(users.length > before, '桥会话收到手写正文');
    const sent = (users.at(-1)?.data?.message?.content || []).map((x) => x.text || '').join('');
    ok(sent.includes(custom), '手写正文原样投递');
    ok(!sent.includes('第三段正文'), '手写正文时不再塞入最新回复');
  }

  section('正文来源跟随本会话');
  {
    await j('PUT', '/api/config', {
      source: { followActive: true, mode: 'local', sessionId: 's-target', title: '桥会话' },
      target: { mode: 'local', sessionId: 's-target', title: '桥会话' },
    });
    await j('POST', '/api/active-session', { sessionId: 's-source', title: '正文会话' });
    const st = await j('GET', '/api/state');
    eq(st.data.capture.source.sessionId, 's-source', 'state 里的正文来源已换成当前会话');
    await sleep(300);
    const unique = '跟随本会话自动捕获：她关上门，靠在门板上听外面的雨。';
    emit('s-source', 'assistant/message', {
      turn: 21,
      message: { role: 'assistant', content: [{ type: 'text', text: unique }] },
    });
    let captured = null;
    for (let i = 0; i < 60 && !captured; i += 1) {
      await sleep(250);
      const list = await j('GET', '/api/jobs?limit=10');
      captured = (list.data.jobs || []).find((x) => x.source === 'capture'
        && x.sourceSessionId === 's-source' && String(x.textPreview || '').includes('跟随本会话自动捕获'));
    }
    ok(!!captured, '勾选本会话后自动捕获当前会话');
    const capturedDone = captured ? await waitJob(captured.id) : null;
    eq(capturedDone?.status, 'done', '跟随本会话的自动捕获任务完成', capturedDone?.error || '');
    const r = await j('POST', '/api/forward-source', { autoGenerate: true });
    eq(r.status, 200, '跟随本会话投递 → 200');
    const done = await waitJob(r.data.job.id);
    eq(done.status, 'done', '跟随本会话投递完成', done.error || '');
    eq(done.sourceSessionId, 's-source', '跟随本会话时抓的是当前会话');
    eq(done.ownerSessionId, 's-source', '跟随本会话时归属当前会话');
    await j('PUT', '/api/config', {
      source: { followActive: false, mode: 'local', sessionId: 's-source', title: '正文会话' },
    });
  }

  section('中止（投递中）');
  {
    // 让会话永远不结束：临时把 prompt 换成不落 turn/end
    const origPrompt = ctx.get('sessionController').prompt;
    ctx.get('sessionController').prompt = async (request) => {
      const s = sessions.get(request.sessionId);
      s.running = true;
      return { ok: true };
    };
    const r = await j('POST', '/api/forward', { text: '这一条会卡住' });
    const id = r.data.job.id;
    await sleep(200);
    const a = await j('POST', `/api/jobs/${id}/abort`);
    eq(a.status, 200, '中止 → 200');
    eq(a.data.job.status, 'cancelled', '任务变成 cancelled');
    ok(cancelled.includes('s-target'), '通知宿主取消了那一轮');
    ctx.get('sessionController').prompt = origPrompt;
  }

  section('自定义匹配 → 正常注入工作流');
  {
    const tags = { title: '[[/T]]', size: '[[/S]]', positive: '[[/P]]', negative: '[[/N]]' };
    setReplyText([
      '[[T]]自定义一[[/T]]',
      '[[S]]1024x768[[/S]]',
      '[[P]]1girl, solo, custom one[[/P]]',
      '[[N]]bad hands[[/N]]',
      '',
      '[[T]]自定义二[[/T]]',
      '[[S]]832x1216[[/S]]',
      '[[P]]1boy, solo, custom two[[/P]]',
      '[[N]][[/N]]',
    ].join('\n'));
    await j('PUT', '/api/config', { capture: { matchRule: 'custom_tags', customTags: tags, timeoutMs: 10000 } });
    const r = await j('POST', '/api/forward', { text: '自定义标签测试正文' });
    eq(r.status, 200, '自定义匹配投递 → 200');
    const done = await waitJob(r.data.job.id);
    eq(done.status, 'done', '自定义匹配任务完成', done.error || '');
    eq(done.sets.length, 2, '自定义标签切出 2 套');
    eq(done.sets[0].title, '自定义一', '自定义标题进入任务');
    eq(done.sets[0].positive, '1girl, solo, custom one', '自定义正面进入工作流');
    eq(done.images.length, 2, '自定义两套都出了图');
    const sent = JSON.stringify(comfy.promptIds[comfy.promptIds.length - 2].body);
    ok(sent.includes('custom one'), '自定义正面注入 ComfyUI');
    await j('PUT', '/api/config', { capture: { matchRule: 'contract_v2' } });
    setReplyText(TARGET_REPLY);
  }

  section('最多匹配几套 / 无标题无 size / 图片归当前聊天');
  {
    await j('PUT', '/api/config', { capture: { matchRule: 'contract_v2', maxSets: 1 } });
    setReplyText(TARGET_REPLY);
    const capped = await j('POST', '/api/forward', { text: '最多匹配测试正文' });
    const cappedJob = await waitJob(capped.data.job.id);
    eq(cappedJob.status, 'done', '最多匹配 1 套任务完成', cappedJob.error || '');
    eq(cappedJob.sets.length, 1, 'maxSets=1 时只取第一套');
    ok((cappedJob.warn || '').includes('最多匹配 1 套提示词'), '超过上限时提示按最多匹配套数截断');

    await j('PUT', '/api/config', { capture: { maxSets: 3 } });
    await j('POST', '/api/active-session', { sessionId: 's-source', title: '正文会话' });
    const r = await j('POST', '/api/generate', {
      sessionId: 's-source', sourceSessionId: 's-source', sourceTurn: 7,
      sets: [{ title: '', anchor: '手动工作台里粘的最后一句。', size: null, positive: '1girl, solo, no title, no size', negative: '' }],
    });
    const job = await waitJob(r.data.job.id);
    eq(job.status, 'done', '无标题无 size 的手动 sets 能出图', job.error || '');
    eq(job.sets[0].title, '', '标题可以为空');
    eq(job.sets[0].size, null, 'size 可以为空');
    eq(job.sets[0].anchor, '手动工作台里粘的最后一句。', '手动 sets 保留 anchor');
    eq(job.images[0].anchor, '手动工作台里粘的最后一句。', '手动出图也把 anchor 写进图片记录');
    eq(job.images[0].turn, 7, '手动出图也把 sourceTurn 写进图片记录');
    eq(job.ownerSessionId, 's-source', '任务记录当前聊天会话');
    eq(job.ownerSessionTitle, '正文会话', '任务记录当前聊天标题');
    eq(job.images.length, 1, '无标题无 size 也出了 1 张');
    const img = await j('GET', `/api/images/${job.images[0].id}`);
    eq(img.data.image.sessionId, 's-source', '图片归当前聊天，而不是正文来源');
    ok(img.data.image.absPath.includes('正文会话'), '图片目录使用会话名');
    ok(!/[\\/]\d{4}-\d{2}-\d{2}[\\/]/.test(img.data.image.absPath), '图片目录不再按日期细分');
    const folder = await j('POST', '/api/open-folder', { scope: 'session', sessionId: 's-source', sessionTitle: '正文会话', dry: true });
    eq(folder.status, 200, '打开会话位置（预演）→ 200');
    ok(folder.data.path.includes('正文会话'), '当前会话位置指向会话名目录');
    eq(folder.data.path, path.dirname(img.data.image.absPath), '打开位置使用图片实际所在目录，不靠可能缺失的标题');
    eq(folder.data.noImages, false, '有图时会话位置可打开');
    const unnamed = await j('POST', '/api/open-folder', { scope: 'session', sessionId: 's-noimages', sessionTitle: '', dry: true });
    ok(!unnamed.data.path.includes('s-noimages'), '没有标题时也不用 sessionId 当文件夹名');
    eq(unnamed.data.noImages, true, '没图时只报告 noImages，不创建文件夹');
    const noOpen = await j('POST', '/api/open-folder', { scope: 'session', sessionId: 's-noimages', sessionTitle: '' });
    eq(noOpen.data.noImages, true, '没图时实际点击也只返回提示，不打开空目录');
    ok(!fs.existsSync(path.join(dataDir, 'output', '未命名会话')), '没图时没有创建空会话文件夹');
    const chatIndexFile = path.join(dataDir, 'output', '_chat.json');
    ok(fs.existsSync(chatIndexFile), '会话索引写在 output 根目录');
    const chatIndex = JSON.parse(fs.readFileSync(chatIndexFile, 'utf8'));
    eq(chatIndex.folders['正文会话']?.sessionId, 's-source', '根索引记录会话 id');
    eq(chatIndex.folders['旧会话']?.sessionId, 's-legacy', '旧版每目录 _chat.json 已迁到根索引');
    ok(!fs.existsSync(path.join(legacyDir, '_chat.json')), '迁移后旧版目录内 _chat.json 已删除');
    ok(!fs.existsSync(path.join(path.dirname(img.data.image.absPath), '_chat.json')), '会话图片目录里不再写 _chat.json');
    const favFolder = await j('POST', '/api/open-folder', { scope: 'favorites', dry: true });
    eq(favFolder.data.path, path.join(dataDir, 'output', '_favorites'), '收藏夹打开位置就是 _favorites 根目录');
    ok(!fs.existsSync(path.join(dataDir, 'output', '_chat-folders.json')), '不再生成 _chat-folders.json 兼容映射');
    const allFolder = await j('POST', '/api/open-folder', { scope: 'all', dry: true });
    eq(allFolder.status, 200, '打开全部位置（预演）→ 200');
    ok(allFolder.data.path === dataDir || allFolder.data.path.endsWith('output'), '全部位置指向图片根目录');
    const recycleFolder = await j('POST', '/api/open-folder', { scope: 'recycle', dry: true });
    eq(recycleFolder.status, 200, '打开回收站位置（预演）→ 200');
    ok(recycleFolder.data.path.includes('_recycle'), '回收站位置指向 _recycle 文件夹');
  }

  section('同一个会话既是正文来源又是提示词来源');
  {
    // 工作台直接拿提取好的提示词出图，不往会话里投任何东西：
    // 即使提示词来源 = 正文来源，也不该被「防回环」误拦。
    const cfg = await j('PUT', '/api/config', {
      target: { mode: 'local', sessionId: 's-source', title: '正文会话' },
    });
    eq(cfg.data.config.target.sessionId, 's-source', '提示词来源可以和正文来源是同一个会话');
    const src = sessions.get('s-source');
    const usersBefore = src.events.filter((e) => e.type === 'user/message').length;
    const r = await j('POST', '/api/generate', {
      sessionId: 's-source', sessionTitle: '正文会话',
      sourceSessionId: 's-source', sourceSessionTitle: '正文会话',
      sets: [{ title: '同会话', anchor: '同一会话里提取的最后一句。', size: null, positive: '1girl, same session manual', negative: '' }],
    });
    eq(r.status, 200, '同会话手动生图 → 200');
    const job = await waitJob(r.data.job.id);
    eq(job.status, 'done', '同会话手动生图完成', job.error || '');
    eq(job.images.length, 1, '同会话手动生图正常出 1 张');
    eq(job.sets[0].anchor, '同一会话里提取的最后一句。', '同会话手动生图保留锚点');
    eq(src.events.filter((e) => e.type === 'user/message').length, usersBefore, '工作台生图不往会话里投递正文');
    const img = await j('GET', `/api/images/${job.images[0].id}`);
    eq(img.data.image.sessionId, 's-source', '同会话手动生图仍归当前聊天');
    await j('PUT', '/api/config', { target: { mode: 'local', sessionId: 's-target', title: '桥会话' } });
  }

  section('图片替换：重新生成当前图 / 请求生成替换旧图');
  {
    const sid = 's-replace';
    const title = '替换测试';
    // 用同一条正文做两次请求生成，验证「同一正文只保留最新一组」。
    const replaceBody = '替换测试正文。';
    // 重新生成现在强制读正文来源的最新正文，这里把来源会话的最新回复对齐成同一条。
    emit('s-source', 'assistant/message', {
      turn: 77,
      message: { role: 'assistant', content: [{ type: 'text', text: replaceBody }] },
    });
    const g = await j('POST', '/api/forward', {
      text: replaceBody, ownerSessionId: sid, ownerSessionTitle: title,
    });
    const base = await waitJob(g.data.job.id);
    eq(base.status, 'done', '替换测试基础任务完成', base.error || '');
    eq(base.images.length, 2, '基础任务出 2 张');
    const oldId = base.images[0].id;
    const oldFileName = base.images[0].fileName;
    const beforeRegen = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    const oldIndex = beforeRegen.data.items.findIndex((i) => i.id === oldId);

    const rg = await j('POST', '/api/regenerate', {
      imageId: oldId, jobId: base.id, setIndex: base.images[0].setIndex,
      sessionId: sid, sessionTitle: title,
    });
    const rjob = await waitJob(rg.data.job.id);
    eq(rjob.status, 'done', '重新生成当前图完成', rjob.error || '');
    eq(rjob.sets.length, 1, '重新生成只针对当前图片对应的一套提示词');
    eq(rjob.images.length, 1, '重新生成只出一张');
    eq(rjob.images[0].id, oldId, '重新生成原地复用同一图片 id');
    eq(rjob.images[0].setIndex, 0, '新图保留当前 setIndex');
    eq(rjob.regenMode, 'single', '仅此图重生成标记为 single');
    ok(String(rjob.images[0].url || '').includes('?v='), '原地替换后 URL 带版本号，绕过 immutable 缓存');
    ok(String(rjob.text) === replaceBody, 'job.text 保留正文原文，不再混入指令');
    ok(String(rjob.outgoingText).includes('【基础消息】') && String(rjob.outgoingText).includes('重新生成第 1 张图的提示词（1 套）'), '仅此图投递带基础消息');
    ok(String(rjob.outgoingText).includes('【重新生成要求】') && String(rjob.outgoingText).includes('重新生成第1张图的提示词') && String(rjob.outgoingText).includes('【/重新生成要求】'), '重新生成要求被简单包裹');
    const afterRegen = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(afterRegen.data.total, 2, '重新生成后图片数量不变');
    eq(afterRegen.data.items.findIndex((i) => i.id === oldId), oldIndex, '重新生成保留原图片位置，不排到最新');
    ok(afterRegen.data.items.some((i) => i.id === oldId && i.fileName !== oldFileName), '原图片记录换成新文件');
    const bin1 = await j('GET', '/api/recycle');
    ok(bin1.data.items.some((i) => i.id !== oldId && i.fileName === oldFileName), '旧文件作为独立回收站记录保留');

    // 第二张也走「仅此图」：setIndex 原本是 1，替换后要归 0，
    // 否则下一次重新生成会拿 1 去单套任务里找不到。
    const other = base.images[1];
    const otherIndex = afterRegen.data.items.findIndex((i) => i.id === other.id);
    const rg2 = await j('POST', '/api/regenerate', {
      imageId: other.id, jobId: base.id, setIndex: other.setIndex,
      sessionId: sid, sessionTitle: title,
    });
    const rjob2 = await waitJob(rg2.data.job.id);
    eq(rjob2.status, 'done', '第二张原地重生成完成', rjob2.error || '');
    eq(rjob2.images[0].id, other.id, '第二张也复用原图片 id');
    eq(rjob2.images[0].setIndex, 0, '单套任务替换后 setIndex 归 0');
    const afterRegen2 = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(afterRegen2.data.total, 2, '第二张替换后图片数量仍不变');
    eq(afterRegen2.data.items.findIndex((i) => i.id === other.id), otherIndex, '第二张替换后也保留原位置');

    await j('PUT', '/api/config', { capture: { extraMessage: '投递后应留空', clearAfterSend: true } });
    const beforeReplace = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    const oldIds = beforeReplace.data.items.map((i) => i.id);
    const f = await j('POST', '/api/forward', {
      text: replaceBody, ownerSessionId: sid, ownerSessionTitle: title, replaceOld: true,
    });
    const fj = await waitJob(f.data.job.id);
    eq(fj.status, 'done', '请求生成替换任务完成', fj.error || '');
    eq(fj.images.length, 2, '请求生成重新出一整套图');
    const afterReplace = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(afterReplace.data.total, 2, '请求生成后当前会话只剩新图');
    ok(afterReplace.data.items.every((i) => !oldIds.includes(i.id)), '请求生成前已有的旧图全部被替换');
    const bin2 = await j('GET', '/api/recycle');
    ok(oldIds.every((id) => bin2.data.items.some((i) => i.id === id)), '请求生成替换的旧图都进了回收站');

    const autoBefore = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    const autoImage = autoBefore.data.items[0];
    const autoR = await j('POST', '/api/regenerate', {
      imageId: autoImage.id, jobId: autoImage.jobId, setIndex: autoImage.setIndex,
      sessionId: sid, sessionTitle: title, mode: 'auto',
    });
    const autoJob = await waitJob(autoR.data.job.id);
    eq(autoJob.status, 'done', '黑图复用模式重生成完成', autoJob.error || '');
    eq(autoJob.regenMode, 'auto', '黑图复用模式标记为 auto');
    eq(autoJob.internal, true, '黑图补图标记为内部任务，不当作新一轮“本次出图”');
    eq(autoJob.images.length, 1, '黑图复用模式只替换一张');
    eq(autoJob.images[0].id, autoImage.id, '黑图补图复用同一图片 id，不新增排序项');
    ok(String(autoJob.images[0].url || '').includes('?v='), '黑图原地替换后 URL 带版本号，绕过 immutable 缓存');
    const autoAfter = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(autoAfter.data.total, 2, '黑图补图后图片数量不变');
    ok(autoAfter.data.items.some((i) => i.id === autoImage.id), '黑图补图后原图片位置仍在');
    ok(!String(autoJob.outgoingText || '').includes('重新生成第'), '黑图复用模式不会多发会话指令');

    const allBefore = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    const allOldIds = allBefore.data.items.map((i) => i.id);
    const allImage = allBefore.data.items[0];
    const all = await j('POST', '/api/regenerate', {
      imageId: allImage.id, jobId: allImage.jobId, setIndex: allImage.setIndex,
      sessionId: sid, sessionTitle: title, mode: 'all', extra: '保持人物不变',
    });
    const allJob = await waitJob(all.data.job.id);
    eq(allJob.status, 'done', '全部重生成完成', allJob.error || '');
    eq(allJob.regenMode, 'all', '全部重生成标记为 all');
    eq(allJob.images.length, 2, '全部重生成仍出本轮的两张');
    ok(String(allJob.outgoingText).includes('【基础消息】') && String(allJob.outgoingText).includes('重新生成本轮全部 2 张图的提示词（2 套）'), '全部重生成投递带基础消息和套数');
    ok(String(allJob.outgoingText).includes('【重新生成要求】') && String(allJob.outgoingText).includes('重新生成本轮全部图片的提示词') && String(allJob.outgoingText).includes('【/重新生成要求】'), '全部重生成要求被简单包裹');
    ok(String(allJob.outgoingText).includes('【额外要求】') && String(allJob.outgoingText).includes('保持人物不变') && String(allJob.outgoingText).includes('【/额外要求】'), '共用文本框要求被简单包裹后投递');
    const afterAll = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(afterAll.data.total, 2, '全部重生成后同一正文只保留最新一组');
    ok(allOldIds.every((id) => !afterAll.data.items.some((i) => i.id === id)), '全部重生成的旧图全部离开当前列表');
    const bin3 = await j('GET', '/api/recycle');
    ok(allOldIds.every((id) => bin3.data.items.some((i) => i.id === id)), '全部重生成的旧图都进了回收站');
    const cfgAfter = await j('GET', '/api/config');
    eq(cfgAfter.data.config.capture.extraMessage, '', '投递成功后附加消息自动留空');
  }

  section('同一正文替换不误伤其它正文');
  {
    const sid = 's-replace-body';
    const title = '同正文替换';
    const a1 = await j('POST', '/api/forward', { text: '正文 A。', ownerSessionId: sid, ownerSessionTitle: title });
    const a1Job = await waitJob(a1.data.job.id);
    const b1 = await j('POST', '/api/forward', { text: '正文 B。', ownerSessionId: sid, ownerSessionTitle: title });
    const b1Job = await waitJob(b1.data.job.id);
    const favId = a1Job.images[0].id;
    await j('POST', `/api/images/${favId}/favorite`);
    const a2 = await j('POST', '/api/forward', {
      text: '正文 A。', ownerSessionId: sid, ownerSessionTitle: title, replaceOld: true,
    });
    const a2Job = await waitJob(a2.data.job.id);
    eq(a1Job.status, 'done', '正文 A 首轮完成');
    eq(b1Job.status, 'done', '正文 B 首轮完成');
    eq(a2Job.status, 'done', '正文 A 再生成完成');
    const list = await j('GET', `/api/images?page=1&size=50&sessionId=${sid}&check=0`);
    eq(list.data.total, 4, '正文 A 替换后：A 新 2 张 + B 的 2 张');
    ok(a1Job.images.every((i) => !list.data.items.some((x) => x.id === i.id)), '正文 A 的旧图被回收');
    ok(b1Job.images.every((i) => list.data.items.some((x) => x.id === i.id)), '正文 B 的图不受影响');
    ok(a2Job.images.every((i) => list.data.items.some((x) => x.id === i.id)), '正文 A 的新图保留');
    const favs = await j('GET', '/api/favorites');
    ok(favs.data.items.some((i) => i.id === favId), '被替换的收藏图仍留在收藏夹');
  }

  section('同会话改标题：目录复用');
  {
    const output = path.join(dataDir, 'output');
    const r1 = await j('POST', '/api/generate', {
      sessionId: 's-rename',
      sessionTitle: '第一次标题',
      sets: [{ title: '', size: null, positive: '1girl, solo, rename one', negative: '' }],
    });
    const job1 = await waitJob(r1.data.job.id);
    eq(job1.status, 'done', '同会话改标题后仍能出图', job1.error || '');
    const img1 = await j('GET', `/api/images/${job1.images[0].id}`);
    const dir1 = path.dirname(img1.data.image.absPath);
    ok(dir1.includes('第一次标题'), '第一次出图按会话标题建目录');

    const r2 = await j('POST', '/api/generate', {
      sessionId: 's-rename',
      sessionTitle: '第二次标题',
      sets: [{ title: '', size: null, positive: '1girl, solo, rename two', negative: '' }],
    });
    const job2 = await waitJob(r2.data.job.id);
    eq(job2.status, 'done', '同会话再次改标题仍能出图', job2.error || '');
    const img2 = await j('GET', `/api/images/${job2.images[0].id}`);
    eq(path.dirname(img2.data.image.absPath), dir1, '同一会话始终复用第一次的目录');
    ok(!fs.existsSync(path.join(output, '第二次标题')), '改标题不会再建新目录');
    const chatIndex = JSON.parse(fs.readFileSync(path.join(output, '_chat.json'), 'utf8'));
    const folders = Object.entries(chatIndex.folders).filter(([, meta]) => meta.sessionId === 's-rename');
    eq(folders.length, 1, '同一会话在索引里只剩一个目录');
    const folder = await j('POST', '/api/open-folder', {
      scope: 'session', sessionId: 's-rename', sessionTitle: '第三次标题', dry: true,
    });
    eq(folder.data.path, dir1, '打开位置也复用同一个目录，不跟新标题走');
  }

  section('目录合并会同步图片记录路径');
  {
    const mergeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airp-chat-merge-'));
    const output = path.join(mergeDir, 'output');
    const oldDir = path.join(output, '合并旧');
    const newDir = path.join(output, '合并新');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldImg = path.join(oldDir, 'a.png');
    const newImg = path.join(newDir, 'a.png');
    fs.writeFileSync(oldImg, PNG);
    fs.writeFileSync(newImg, PNG);
    fs.writeFileSync(path.join(output, '_chat.json'), JSON.stringify({
      version: 1,
      folders: {
        合并旧: { sessionId: 's-merge-rec', sessionTitle: '合并旧', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', count: 1 },
        合并新: { sessionId: 's-merge-rec', sessionTitle: '合并新', firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z', count: 3 },
      },
    }));
    fs.writeFileSync(path.join(mergeDir, 'images.json'), JSON.stringify([{
      id: 'img_merge', createdAt: '2026-01-01T00:00:00.000Z', sessionId: 's-merge-rec', sessionTitle: '合并旧',
      fileName: 'a.png', absPath: oldImg,
    }, {
      id: 'img_target', createdAt: '2026-01-02T00:00:00.000Z', sessionId: 's-merge-rec', sessionTitle: '合并新',
      fileName: 'a.png', absPath: newImg,
    }]));
    const st = createStore(mergeDir);
    st.loadAll();
    const name = st.chatFolderName('s-merge-rec', '随便什么新标题');
    eq(name, '合并新', '合并时沿用已有目录名');
    ok(!fs.existsSync(oldDir), '合并后旧目录不留下');
    ok(fs.existsSync(path.join(newDir, 'a_1.png')), '重名图片搬过去时自动加 _1，不覆盖目标目录里的同名图');
    eq(st.getImage('img_merge').absPath, path.join(newDir, 'a_1.png'), '图片记录路径同步到合并后的目录');
    eq(st.getImage('img_merge').fileName, 'a_1.png', '图片记录文件名同步成改名后的文件');
    eq(st.getImage('img_target').absPath, newImg, '目标目录原有图片记录不变');
    eq(st.chatFolderName('s-merge-rec', '再改标题'), '合并新', '之后改标题继续复用同一目录');
    try { fs.rmSync(mergeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  section('LoRA 面板');
  {
    const r = await j('POST', '/api/loras', { workflowId: wfId });
    eq(r.status, 200, 'POST /api/loras → 200');
    ok(Array.isArray(r.data.stacks), '返回 stacks');
    ok(r.data.catalog.count >= 1, '退回 /object_info 拿到了 LoRA 清单');

    const loraJson = {
      ...WORKFLOW,
      30: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'single.safetensors', strength_model: 0.7 } },
      31: { class_type: 'Power Lora Loader (rgthree)', inputs: { lora_1: { on: true, lora: 'power.safetensors', strength: 0.6, strengthTwo: 0.4 } } },
      32: { class_type: 'LoraStacker', inputs: { lora_name_1: 'stack.safetensors', model_weight_1: 0.5, clip_weight_1: 0.3 } },
      33: { class_type: 'LoraTagLoader', inputs: { text: '<lora:tag.safetensors:0.8>' } },
      34: { class_type: 'LoraLoader', inputs: { loras: { __value__: [{ name: 'manager.safetensors', active: true }] } } },
    };
    const panel = await j('POST', '/api/loras', { workflowId: wfId, json: loraJson });
    eq(panel.data.stacks.length, 5, 'LoRA 面板认出单 LoRA / Power / Stacker / Tag / 堆五种节点');
    const panelById = Object.fromEntries(panel.data.stacks.map((s) => [String(s.nodeId), s]));
    eq(panelById['30']?.kind, 'single', 'LoraLoaderModelOnly 归类为单 LoRA');
    eq(panelById['30']?.group, 'loose', '单 LoRA 归入普通节点组');
    eq(panelById['34']?.kind, 'manager', 'inputs.loras 归类为 LoRA 堆');
    eq(panelById['34']?.group, 'stack', 'LoraManager 堆归入堆组');
    eq(panelById['31']?.kind, 'power', 'Power Lora Loader 归类为 power');
    eq(panelById['32']?.kind, 'stacker', 'Lora Stacker 归类为 stacker');
    eq(panelById['33']?.kind, 'tags', 'Lora Tag Loader 归类为 tags');
    eq(panelById['30']?.entries[0]?.name, 'single.safetensors', '单 LoRA 名字读出来了');
    eq(panelById['31']?.entries[0]?.strength, 0.6, 'Power LoRA 强度读出来了');
    eq(panelById['32']?.entries[0]?.clipStrength, 0.3, 'Stacker 的 clip 强度读出来了');
    eq(panelById['33']?.entries[0]?.name, 'tag.safetensors', 'Tag LoRA 名字读出来了');
    const baseEntry = panelById['34']?.entries[0] || {};
    ok(!!baseEntry.labelDefault, 'LoRA 条目带默认显示名');
    eq(baseEntry.labelCustom, false, '没改名前不是自定义名');

    const customLabel = '我的堆 LoRA';
    await j('POST', '/api/loras/apply', {
      workflowId: wfId,
      loraState: { stacks: { 34: [{ name: 'manager.safetensors', on: true, strength: 1, label: customLabel }] }, switches: {} },
    });
    const labeled = await j('POST', '/api/loras', { workflowId: wfId, json: loraJson });
    const labeledEntry = (labeled.data.stacks.find((s) => String(s.nodeId) === '34')?.entries || [])[0] || {};
    eq(labeledEntry.label, customLabel, '运行时覆盖能显示自定义 LoRA 名');
    eq(labeledEntry.labelCustom, true, '自定义 LoRA 名标记为可保存');

    const savedLabelState = { stacks: { 34: [{ name: 'manager.safetensors', on: true, strength: 1, label: customLabel }] }, switches: {} };
    await j('PUT', `/api/workflows/${wfId}`, { loraState: savedLabelState });
    await j('POST', '/api/loras/apply', { workflowId: wfId });
    const savedLabel = await j('POST', '/api/loras', { workflowId: wfId, json: loraJson });
    const savedLabelEntry = (savedLabel.data.stacks.find((s) => String(s.nodeId) === '34')?.entries || [])[0] || {};
    eq(savedLabelEntry.label, customLabel, '保存到工作流后仍显示自定义 LoRA 名');

    await j('POST', '/api/loras/reset', { workflowId: wfId });
    const resetLabel = await j('POST', '/api/loras', { workflowId: wfId, json: loraJson });
    const resetLabelEntry = (resetLabel.data.stacks.find((s) => String(s.nodeId) === '34')?.entries || [])[0] || {};
    eq(resetLabelEntry.label, baseEntry.labelDefault, '重置后 LoRA 名恢复默认');
    eq(resetLabelEntry.labelCustom, false, '重置后不再是自定义名');

    const loraApply = await j('POST', '/api/workflows/dry-run', {
      workflowId: wfId, json: loraJson, positive: 'x', includeJson: true,
      loraState: {
        stacks: {
          30: [{ name: 'single.safetensors', on: false }],
          31: [{ name: 'power.safetensors', on: false }],
          32: [{ name: 'stack.safetensors', on: false }],
          33: [{ name: 'tag.safetensors', on: true, strength: 0.4 }],
        },
      },
    });
    eq(loraApply.status, 200, '散装 LoRA 干跑 → 200');
    eq(loraApply.data.json['30'].inputs.strength_model, 0, '关闭单 LoRA 会把强度写 0（不删节点）');
    eq(loraApply.data.json['31'].inputs.lora_1.on, false, '关闭 Power LoRA 写 on=false');
    eq(loraApply.data.json['32'].inputs.model_weight_1, 0, '关闭 Stacker 会写 0 强度');
    eq(loraApply.data.json['33'].inputs.text, '<lora:tag.safetensors:0.40>', 'Tag LoRA 的标签强度被改写');

    const chainJson = {
      ...WORKFLOW,
      40: { class_type: 'LoraLoader', inputs: { model: ['41', 0], clip: ['41', 1], lora_name: 'a.safetensors', strength_model: 1, strength_clip: 1 } },
      41: { class_type: 'LoraLoader', inputs: { model: ['42', 0], clip: ['42', 1], lora_name: 'b.safetensors', strength_model: 1, strength_clip: 1 } },
      42: { class_type: 'LoraLoader', inputs: { model: ['43', 0], clip: ['43', 1], lora_name: 'c.safetensors', strength_model: 1, strength_clip: 1 } },
      43: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' } },
    };
    const chainPanel = await j('POST', '/api/loras', { workflowId: wfId, json: chainJson });
    const chainById = Object.fromEntries(chainPanel.data.stacks.map((s) => [String(s.nodeId), s]));
    eq(chainById['42']?.order, 0, '连续 LoRA 链：最上游节点排第一');
    eq(chainById['41']?.order, 1, '连续 LoRA 链：中间节点排第二');
    eq(chainById['40']?.order, 2, '连续 LoRA 链：最下游节点排第三');
    eq(chainById['40']?.group, 'loose', '连续 LoraLoader 仍归入普通节点组（不冒充堆）');

    const switchJson = {
      ...WORKFLOW,
      30: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'single.safetensors', strength_model: 0.7 } },
      35: { class_type: 'LoraLoader', inputs: { loras: { __value__: [{ name: 'a.safetensors', active: true }] } } },
      36: { class_type: 'LoraLoader', inputs: { loras: { __value__: [{ name: 'b.safetensors', active: true }] } } },
      37: { class_type: 'PrimitiveBoolean', inputs: { value: true } },
      34: { class_type: 'ComfySwitchNode', inputs: { on_true: ['35', 0], on_false: ['36', 0], switch: ['37', 0] } },
    };
    const swPanel = await j('POST', '/api/loras', { workflowId: wfId, json: switchJson });
    const swById = Object.fromEntries(swPanel.data.stacks.map((s) => [String(s.nodeId), s]));
    eq(swById['30']?.active, true, '有开关时，不受开关控制的单 LoRA 仍标记为生效');
    eq(swById['35']?.active, true, '开关选中的 LoRA 堆标记为生效');
    eq(swById['36']?.active, false, '开关没选中的 LoRA 堆标记为不生效');
  }

  section('连续图：非 LoRA 堆节点');
  {
    const cfgFor = (lora) => ({ generation: { continuous: { on: true, lora, strengths: [0.35, 0.85] } } });
    const shot = (nodeId, name, strength = 0.35) => ({ nodeId: String(nodeId), name, strength });

    const singleWf = { json: { '1': { class_type: 'LoraLoader', inputs: { lora_name: 'single.safetensors', strength_model: 0.9, strength_clip: 0.9 } } } };
    const singlePlan = continuousTarget(singleWf, cfgFor('1::single.safetensors'));
    eq(singlePlan.count, 2, '单 LoRA 节点也能被连续图选中');
    const singleState = withLoraStrength(singleWf, null, shot('1', 'single.safetensors'));
    const singleApplied = applyLoraState(singleWf.json, singleState).workflow;
    eq(singleApplied['1'].inputs.strength_model, 0.35, '单 LoRA 连续图写入 model 强度');
    eq(singleApplied['1'].inputs.strength_clip, 0.35, '单 LoRA 连续图写入 clip 强度');

    const powerWf = { json: { '2': { class_type: 'Power Lora Loader (rgthree)', inputs: { lora_1: { on: true, lora: 'power.safetensors', strength: 0.9, strengthTwo: 0.8 } } } } };
    const powerPlan = continuousTarget(powerWf, cfgFor('2::power.safetensors'));
    eq(powerPlan.count, 2, 'Power LoRA 节点也能被连续图选中');
    const powerState = withLoraStrength(powerWf, null, shot('2', 'power.safetensors'));
    const powerApplied = applyLoraState(powerWf.json, powerState).workflow;
    eq(powerApplied['2'].inputs.lora_1.strength, 0.35, 'Power LoRA 连续图写入 model 强度');
    eq(powerApplied['2'].inputs.lora_1.strengthTwo, 0.35, 'Power LoRA 连续图写入 clip 强度');

    const stackerWf = { json: { '3': { class_type: 'Lora Stacker', inputs: { lora_name_1: 'stacker.safetensors', model_weight_1: 0.9, clip_weight_1: 0.8 } } } };
    const stackerPlan = continuousTarget(stackerWf, cfgFor('3::stacker.safetensors'));
    eq(stackerPlan.count, 2, 'Lora Stacker 节点也能被连续图选中');
    const stackerState = withLoraStrength(stackerWf, null, shot('3', 'stacker.safetensors'));
    const stackerApplied = applyLoraState(stackerWf.json, stackerState).workflow;
    eq(stackerApplied['3'].inputs.model_weight_1, 0.35, 'Lora Stacker 连续图写入 model 强度');
    eq(stackerApplied['3'].inputs.clip_weight_1, 0.35, 'Lora Stacker 连续图写入 clip 强度');

    const tagWf = { json: { '4': { class_type: 'Lora Tag Loader', inputs: { text: '<lora:tag.safetensors:0.9:0.8>' } } } };
    const tagPlan = continuousTarget(tagWf, cfgFor('4::tag.safetensors'));
    eq(tagPlan.count, 2, 'Lora Tag Loader 节点也能被连续图选中');
    const tagState = withLoraStrength(tagWf, null, shot('4', 'tag.safetensors'));
    const tagApplied = applyLoraState(tagWf.json, tagState).workflow;
    ok(String(tagApplied['4'].inputs.text).includes('<lora:tag.safetensors:0.35>'), 'Lora Tag Loader 连续图改写标签强度');
  }

  section('连续图整组替换');
  {
    const sid = 's-continuous';
    const title = '连续测试';
    const strengths = [0.3, 0.5, 0.7];
    const sets = strengths.map((strength, i) => ({
      title: `连续测试 ${i + 1}`,
      anchor: '连续测试锚点。',
      size: null,
      positive: '1girl, solo, continuous test',
      negative: '',
      continuousShot: { nodeId: '4', name: 'test.safetensors', strength, index: i + 1, total: 3 },
    }));
    const g = await j('POST', '/api/generate', {
      sets, text: '连续测试正文。', sessionId: sid, sessionTitle: title,
      sourceSessionId: sid, sourceSessionTitle: title, sourceTurn: 5,
    });
    const base = await waitJob(g.data.job.id);
    eq(base.status, 'done', '连续图基础任务完成', base.error || '');
    eq(base.images.length, 3, '连续图基础任务出 3 张');
    const before = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    const clicked = before.data.items.find((i) => i.setIndex === 1);
    const clickedAt = before.data.items.findIndex((i) => i.id === clicked.id);
    eq(clicked?.continuousShot?.total, 3, '图片记录带连续图强度信息');

    // 提示词来源为空时必须明确报错，不能悄悄拿旧提示词直接出图。
    await j('PUT', '/api/config', { target: { mode: 'remote', sessionId: '', title: '' } });
    const noTarget = await j('POST', '/api/regenerate', {
      imageId: clicked.id, jobId: base.id, setIndex: clicked.setIndex,
      sessionId: sid, sessionTitle: title, mode: 'single',
    });
    eq(noTarget.status, 400, '提示词来源为空时重新生成被拒绝');
    ok(String(noTarget.data.error || '').includes('提示词来源会话'), '明确提示先选提示词来源，不回退旧提示词');
    await j('PUT', '/api/config', { target: { mode: 'local', sessionId: 's-target', title: '桥会话' } });

    const r = await j('POST', '/api/regenerate', {
      imageId: clicked.id, jobId: base.id, setIndex: clicked.setIndex,
      sessionId: sid, sessionTitle: title, mode: 'single',
    });
    const rjob = await waitJob(r.data.job.id);
    eq(rjob.status, 'done', '连续图整组替换完成', rjob.error || '');
    eq(rjob.regenMode, 'continuous', '连续图仅此图标记为 continuous');
    ok(String(rjob.outgoingText).includes('连续测试正文') && String(rjob.outgoingText).includes('重新生成这一组连续图的提示词'), '连续图整组替换确实发给了桥会话');
    eq(rjob.images.length, 3, '连续图整组替换仍然 3 张');
    eq(JSON.stringify(rjob.sets.map((s) => s.continuousShot && s.continuousShot.strength)), JSON.stringify(strengths), '连续图整组替换保留各档强度');
    eq(JSON.stringify(rjob.images.map((i) => i.setIndex)), JSON.stringify([0, 1, 2]), '连续图整组替换重排 setIndex');
    ok(rjob.images.every((i) => String(i.url || '').includes('?v=')), '连续图整组替换都带版本号');

    const after = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(after.data.total, 3, '连续图整组替换后图片数量不变，不会多');
    eq(after.data.items.findIndex((i) => i.id === clicked.id), clickedAt, '连续图整组替换保留原位置');
    ok(rjob.images.every((i) => before.data.items.some((old) => old.id === i.id)), '连续图整组替换复用原图片 id');

    // 组里少一张时只替换剩下的，不会把删掉的旧图复活、也不会多出图片。
    const dropId = after.data.items[0].id;
    const keep = after.data.items[1];
    await j('POST', `/api/images/${dropId}/recycle`);
    const r2 = await j('POST', '/api/regenerate', {
      imageId: keep.id, jobId: keep.jobId, setIndex: keep.setIndex,
      sessionId: sid, sessionTitle: title, mode: 'single',
    });
    const rjob2 = await waitJob(r2.data.job.id);
    eq(rjob2.status, 'done', '连续图缺一张时整组替换完成', rjob2.error || '');
    eq(rjob2.images.length, 2, '连续图缺一张时只替换剩下的 2 张');
    const after2 = await j('GET', `/api/images?page=1&size=24&sessionId=${sid}&check=0`);
    eq(after2.data.total, 2, '连续图缺一张时列表只会少不会多');
    ok(!after2.data.items.some((i) => i.id === dropId), '连续图缺一张时不会复活已删的旧图');
  }

  section('输出节点默认勾选迁移');
  {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airp-store-legacy-'));
    const legacyJson = {
      ...WORKFLOW,
      10: { class_type: 'PreviewImage', inputs: { images: ['8', 0] }, _meta: { title: '预览' } },
    };
    fs.writeFileSync(path.join(legacyDir, 'workflows.json'), JSON.stringify([{
      id: 'wf_legacy', name: '旧工作流', json: legacyJson, mapping: {},
      outputNodes: ['9', '10'], tokenEmpty: 'blank', size: null, sizeMode: 'manual',
      randomSeed: true, pruneOutputs: true, onlyFirst: false, loraState: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]));
    const legacyStore = createStore(legacyDir);
    legacyStore.loadAll();
    const migrated = legacyStore.getWorkflow('wf_legacy');
    eq(migrated.outputNodes.length, 1, '旧版全勾的输出节点迁移成一个');
    eq(String(migrated.outputNodes[0]), '9', '迁移时保留标准 SaveImage');
    eq(migrated.outputSelectionVersion, 2, '迁移后写入输出勾选版本');
    legacyStore.patchWorkflow('wf_legacy', { outputNodes: ['9', '10'] });
    const reloadedStore = createStore(legacyDir);
    reloadedStore.loadAll();
    eq(reloadedStore.getWorkflow('wf_legacy').outputNodes.length, 2, '用户之后自己勾两个，重启不再被改回一个');
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  section('重新生成强制使用正文来源最新正文');
  {
    setReplyText(TARGET_REPLY);
    const oldBody = '旧正文：这一轮的旧内容。';
    const newBody = '最新正文：她推开门，外面的雨声一下子涌了进来。';
    const g = await j('POST', '/api/forward', {
      text: oldBody, ownerSessionId: 's-latest-body', ownerSessionTitle: '最新正文测试',
    });
    const base = await waitJob(g.data.job.id);
    eq(base.status, 'done', '最新正文测试基础任务完成', base.error || '');
    emit('s-source', 'assistant/message', {
      turn: 88,
      message: { role: 'assistant', content: [{ type: 'text', text: newBody }] },
    });
    const rg = await j('POST', '/api/regenerate', {
      imageId: base.images[0].id, jobId: base.id, setIndex: base.images[0].setIndex,
      sessionId: 's-latest-body', sessionTitle: '最新正文测试',
    });
    const rjob = await waitJob(rg.data.job.id);
    eq(rjob.status, 'done', '重新生成最新正文任务完成', rjob.error || '');
    eq(rjob.text, newBody, '重新生成使用正文来源的最新正文，而不是图片旧任务的正文');
    eq(rjob.sourceTurn, 88, '重新生成把最新正文的 turn 一起带过去');
    ok(String(rjob.outgoingText).includes(newBody), '投递出去的桥消息里是最新正文');
    ok(!String(rjob.outgoingText).includes(oldBody), '旧任务正文没有混进桥消息');
  }

  section('清空定位只影响当前会话');
  {
    const before = await j('GET', '/api/images?page=1&size=200&check=0');
    const anchored = before.data.items.filter((i) => i.anchor && i.sessionId);
    ok(anchored.length >= 2, '清空前有锚点可清');
    const targetSid = anchored[0].sessionId;
    const other = anchored.find((i) => i.sessionId !== targetSid);
    ok(!!other, '另一个会话的锚点留作对照');
    const r = await j('POST', '/api/follow/clear-anchors', { sessionId: targetSid });
    eq(r.status, 200, 'POST /api/follow/clear-anchors → 200');
    eq(r.data.sessionId, targetSid, '清空接口回显目标会话');
    ok(Number(r.data.images) > 0, '清空接口报告目标会话的图片数量');
    const after = await j('GET', '/api/images?page=1&size=200&check=0');
    ok(after.data.items.filter((i) => i.sessionId === targetSid).every((i) => !i.anchor), '目标会话的 anchor 已清空');
    ok(after.data.items.some((i) => i.sessionId === other.sessionId && i.anchor), '其它会话的 anchor 保留');
    const jobs = await j('GET', '/api/jobs?limit=100&full=1');
    const rows = jobs.data.jobs || [];
    ok(rows.filter((job) => String(job.ownerSessionId || '') === targetSid)
      .every((job) => (job.sets || []).every((s) => !s.anchor)), '目标会话任务 sets 的锚点清空');
    ok(rows.some((job) => String(job.ownerSessionId || '') !== targetSid
      && (job.sets || []).some((s) => s.anchor)), '其它会话任务 sets 的锚点保留');
  }

  section('清理');
  {
    await fetch(`${base}/api/recycle/purge`, { method: 'POST' }).catch(() => {});
    dispose();
    server.close();
    comfy.server.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dshHome, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  }

  console.log(`\n== ${pass} ✔ / ${fails.length} ✘ ==`);
  if (fails.length) {
    console.log('失败：');
    for (const f of fails) console.log(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n[test-host] 崩溃：', e);
  process.exit(1);
});
