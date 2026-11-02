/**
 * dsh-comfyui-rp —— DSH 插件 Host 半区（标准 Cordis 插件）。
 *
 * 一体化：捕获 → 投递 → 按规则切分 → ComfyUI 出图 → 图片进侧栏/悬浮球。
 *   · 不依赖外部 comfy-llm-bridge 进程；
 *   · 不调用 LLM（提示词一律由 DSH 里的桥会话产出）；
 *   · 本进程会话用 sessionController，跨进程会话用同一个插件的 HTTP 路由（/__airp_comfy/api/*）。
 *
 * 路由（默认前缀 /__airp_comfy）：
 *   <route>/api/*      控制面（面板、另一台 DSH 的插件）
 *   <route>/img/<id>   图片
 *   <route>/api/events SSE（job / image / log）
 *   <route>/api/stream SSE（给另一台 DSH 抓这个进程的助手回复）
 *   <route>/api/ask    远程投递（对方插件等回复）
 */
import path from 'node:path';
import { createApi } from './api.js';
import { createJobsEngine } from './jobs.js';
import { configureLoraDataDir, ensureLoraNamesFile } from './lora.js';
import { PANEL_ID, PACKAGE_NAME, ROUTE_PATH, VERSION } from './meta.js';
import { captureLocal, captureRemote } from './session.js';
import { createHub } from './sse.js';
import { createStore } from './store.js';
import { defaultDataDir } from './util.js';

export const name = PACKAGE_NAME;
export const inject = ['webServer'];

export function apply(ctx, pluginConfig = {}) {
  const dataDir = path.resolve(
    String(pluginConfig?.dataDir || process.env.AIRP_COMFY_DATA || defaultDataDir()),
  );

  // 先建 hub，所有 Host 日志只进插件日志界面，不写 DSH 的 web 终端。
  const hub = createHub();
  const log = (...a) => {
    try { hub.pushLog('info', a.map((x) => String(x)).join(' ')); } catch { /* ignore */ }
  };
  const errlog = (...a) => {
    try { hub.pushLog('error', a.map((x) => String(x)).join(' ')); } catch { /* ignore */ }
  };

  // 1) 数据
  const store = createStore(dataDir);
  store.loadAll();
  configureLoraDataDir(dataDir);
  ensureLoraNamesFile();
  const swept = store.sweepOrphanJobs();
  if (swept) log(`启动清扫：${swept} 条没跑完的任务已标记为失败`);

  // 2) 基础设施
  const sc = (() => {
    try { return ctx.get('sessionController') || null; } catch { return null; }
  })();
  const jobs = createJobsEngine({
    ctx,
    sc,
    store,
    hub,
    getConfig: () => store.getConfig(),
  });

  let disposeCapture = () => {};
  let captureKey = '';
  let captureRebuildTimer = null;
  let api = null;

  function rebuildCapture() {
    const cfg = store.getConfig();
    const followActive = cfg.source.followActive !== false;
    // 「本会话」= 捕获当前活动会话；否则用设置里指定的本进程 / 远程会话。
    const src = followActive
      ? {
        ...cfg.source,
        mode: 'local',
        sessionId: api ? api.activeSessionId : '',
        title: api ? api.activeSessionTitle : '',
      }
      : cfg.source;
    const key = JSON.stringify({
      followActive,
      mode: src.mode,
      baseUrl: src.baseUrl,
      routePath: src.routePath,
      sessionId: src.sessionId,
      title: src.title,
      token: !!src.token,
    });
    if (key === captureKey) return;
    captureKey = key;
    try { disposeCapture(); } catch { /* ignore */ }
    disposeCapture = () => {};
    if (!src.sessionId) return;

    if (src.mode === 'local') {
      if (typeof ctx.on !== 'function') {
        errlog('没有 session/event 服务，本进程捕获不可用');
        return;
      }
      disposeCapture = captureLocal(ctx, src.sessionId, (entry) => {
        jobs.handleCaptured({ ...entry, title: src.title });
      });
      log(`本进程捕获已启动：${src.sessionId}${src.title ? `（${src.title}）` : ''}`);
      return;
    }

    if (src.mode === 'remote') {
      if (!src.baseUrl) {
        errlog('远程捕获缺少 DSH 地址');
        return;
      }
      const handle = captureRemote({
        baseUrl: src.baseUrl,
        routePath: src.routePath,
        token: src.token,
        sessionId: src.sessionId,
        onEvent: (entry) => jobs.handleCaptured({ ...entry, title: src.title }),
        onError: (e) => log(`远程捕获断了（2.5s 后重连）：${e?.message || e}`),
        onStatus: (s) => { if (s.connected) log(`远程捕获已连接：${s.url}`); },
      });
      disposeCapture = () => handle.close();
      log(`远程捕获已启动：${src.baseUrl}${src.routePath} · ${src.sessionId}`);
    }
  }

  function scheduleCaptureRebuild() {
    if (captureRebuildTimer) clearTimeout(captureRebuildTimer);
    captureRebuildTimer = setTimeout(() => {
      captureRebuildTimer = null;
      rebuildCapture();
    }, 150);
    if (typeof captureRebuildTimer.unref === 'function') captureRebuildTimer.unref();
  }

  // 3) API
  api = createApi({
    store,
    jobs,
    hub,
    getConfig: () => store.getConfig(),
    ctx,
    sc,
    routePath: ROUTE_PATH,
    version: VERSION,
    onConfigChanged: () => scheduleCaptureRebuild(),
    onActiveSessionChanged: () => scheduleCaptureRebuild(),
  });

  // 4) 路由
  const ws = (() => {
    try { return ctx.get('webServer') || null; } catch { return null; }
  })();
  if (!ws || typeof ws.register !== 'function') {
    errlog('webServer 不可用 —— 路由注册不了，本插件等于没装');
    return () => {};
  }
  const disposeRoute = ws.register({
    kind: 'prefix',
    path: ROUTE_PATH,
    handler: (req, res) => api.handle(req, res),
  });

  // 5) 捕获
  rebuildCapture();

  log(`Host 半区已 apply：${PACKAGE_NAME} v${VERSION}`);
  log(`数据目录：${dataDir}`);
  log(`路由已注册：${ROUTE_PATH}/*  (webServer 端口 ${ws.port || '?'})`);
  log(`sessionController：${sc ? '有' : 'apply 时还没挂上（用到时会再取一次）'}`);
  log(`面板 id：${PANEL_ID}（右侧栏 ComfyRP 标签由客户端半区注册）`);
  const cfg = store.getConfig();
  log(`来源：${cfg.source.followActive !== false ? '本会话（跟随当前会话）' : `${cfg.source.mode} ${cfg.source.sessionId || '(未选)'}`} → 桥会话：${cfg.target.mode} ${cfg.target.sessionId || '(未选)'}`);

  const dispose = () => {
    try { jobs.dispose(); } catch { /* ignore */ }
    try { disposeCapture(); } catch { /* ignore */ }
    if (captureRebuildTimer) clearTimeout(captureRebuildTimer);
    try { hub.closeAll(); } catch { /* ignore */ }
    try {
      if (typeof disposeRoute === 'function') disposeRoute();
      else disposeRoute?.dispose?.();
    } catch { /* ignore */ }
    try { store.flush(); } catch { /* ignore */ }
    log('已卸载');
  };

  // Cordis 插件包形态：用返回的函数做回收；动态插件形态也认 ctx.effect。
  try {
    if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  } catch { /* ignore */ }
  return dispose;
}

export default { name, inject, apply };
