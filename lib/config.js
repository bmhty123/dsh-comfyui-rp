import { ROUTE_PATH } from './meta.js';
import { DEFAULT_CUSTOM_TAGS } from './rule.js';
import { deepMerge, num, str } from './util.js';

/**
 * 配置默认值。
 *
 * ★ 这里没有 LLM：提示词一律由 DSH 会话产出，桥只负责「捕获 → 投递 → 按规则切分 → 出图」。
 * ★ source = 从哪个会话抓正文；target = 把正文投给哪个会话（也就是写提示词的那个）。
 *   两边都可以是本进程（local）或另一个 DSH 进程（remote，需要对方也装本插件）。
 */
export function defaultConfig() {
  return {
    version: 1,

    // ComfyUI 本体
    comfy: {
      baseUrl: 'http://127.0.0.1:8188',
      timeoutMs: 300000,      // 单批出图总预算
      pollIntervalMs: 1200,   // 轮询 history 的间隔
      interruptOnAbort: true, // 终止时顺手打断 ComfyUI 当前任务
    },

    // 正文来源
    source: {
      followActive: true,     // true = 正文来源跟随当前会话；false = 用下面的模式 / 会话
      mode: 'local',          // 'local' | 'remote'
      baseUrl: '',            // remote 时必填，例如 http://127.0.0.1:43120
      routePath: ROUTE_PATH,  // remote 时对方插件路由
      token: '',              // remote 时的共享口令（可选）
      sessionId: '',
      title: '',
    },

    // 桥会话（提示词来源）
    target: {
      mode: 'local',          // 'local' | 'remote'
      baseUrl: '',            // remote 时必填
      routePath: ROUTE_PATH,  // 对方插件路由；旧 relay 插件可填 /__dsh_prompt
      token: '',              // 可选共享口令（x-prompt-relay-token）
      sessionId: '',
      title: '',
    },

    capture: {
      autoForward: true,      // 抓到一个助手回复就自动投给桥会话
      autoGenerate: false,    // 首次安装默认不自动出图；用户可手动开
      timeoutMs: 300000,      // 等桥会话回复的上限
      maxSets: 3,             // 最多匹配几套提示词；第 N 套就是连续图的最后一套
      maxImages: 3,
      matchRule: 'contract_v2', // contract_v2 | all_text | custom_tags
      customTags: { ...DEFAULT_CUSTOM_TAGS },
      minChars: 8,            // 太短的回复不当正文（例如「好的」）
      ignoreTargetSession: true, // 桥会话自己的回复绝不再被抓去投递（防回环）
      extraMessage: '',       // 侧边栏附加消息：空 = 不启用；按原样放在正文前 / 后，不包裹
      extraPosition: 'top',   // 'top' | 'bottom'
      clearAfterSend: true,   // 投递成功后自动清空附加消息，默认开
    },

    // 手动出图 / 连续图
    generation: {
      imageCount: 1,          // 手动出图默认张数（1~3）
      countNotSet: false,     // true = 不按套数强制，重复第一套
      continuous: {
        on: false,            // 手动出图要不要也带连续图
        lora: '',             // '堆节点ID::LoRA名'
        strengths: [null, null, null], // 每档一张；null = 不用这一档
      },
    },

    workflowId: '',           // 当前启用的工作流

    // 高级：数据目录覆盖（默认 $DSH_HOME/airp-comfy）
    paths: {
      dataDir: '',
      outputDir: '',
    },

    // 酒馆(跨源)通道：留空 = 只放行酒馆默认端口的 http://localhost:8080 与
    // http://127.0.0.1:8080；填了就只认这些来源（逗号/空格分隔可写多个）。
    tavern: {
      origin: '',
    },
  };
}

export const CONFIG_FILE = 'config.json';

export function normalizeRoutePath(v) {
  let p = str(v, ROUTE_PATH).trim() || ROUTE_PATH;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  return p || ROUTE_PATH;
}

export function normalizeBaseUrl(v) {
  let u = str(v, '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

/**
 * 把磁盘上的配置洗成可用形态。
 * 原则：缺什么补什么、越界夹回来、坏值退回默认，**绝不因为一个坏字段整份配置报错**。
 */
export function normalizeConfig(raw) {
  const cfg = deepMerge(defaultConfig(), raw && typeof raw === 'object' ? raw : {});

  cfg.version = 1;
  cfg.comfy.baseUrl = normalizeBaseUrl(cfg.comfy.baseUrl) || 'http://127.0.0.1:8188';
  cfg.comfy.timeoutMs = Math.max(30000, Math.min(1800000, num(cfg.comfy.timeoutMs, 300000)));
  cfg.comfy.pollIntervalMs = Math.max(300, Math.min(10000, num(cfg.comfy.pollIntervalMs, 1200)));
  cfg.comfy.interruptOnAbort = cfg.comfy.interruptOnAbort !== false;

  for (const key of ['source', 'target']) {
    const s = cfg[key];
    s.mode = s.mode === 'remote' ? 'remote' : 'local';
    s.baseUrl = normalizeBaseUrl(s.baseUrl);
    s.routePath = normalizeRoutePath(s.routePath);
    s.token = str(s.token);
    s.sessionId = str(s.sessionId).trim();
    s.title = str(s.title);
  }
  // 默认跟随当前会话；只有明确存成 false 才用下面配置的本进程 / 远程会话。
  cfg.source.followActive = cfg.source.followActive !== false;
  cfg.target.routePath = normalizeRoutePath(cfg.target.routePath);
  cfg.target.token = str(cfg.target.token);

  cfg.capture.autoForward = cfg.capture.autoForward !== false;
  // 旧配置没有这个字段时沿用新默认「关」；只有明确存成 true 才自动出图。
  cfg.capture.autoGenerate = cfg.capture.autoGenerate === true;
  cfg.capture.timeoutMs = Math.max(5000, Math.min(1800000, num(cfg.capture.timeoutMs, 300000)));
  cfg.capture.maxSets = Math.max(1, Math.min(3, num(cfg.capture.maxSets, 3)));
  cfg.capture.maxImages = Math.max(1, Math.min(6, num(cfg.capture.maxImages, 3)));
  cfg.capture.minChars = Math.max(0, Math.min(1000, num(cfg.capture.minChars, 8)));
  cfg.capture.ignoreTargetSession = cfg.capture.ignoreTargetSession !== false;
  cfg.capture.extraMessage = str(cfg.capture.extraMessage).slice(0, 4000);
  cfg.capture.extraPosition = cfg.capture.extraPosition === 'bottom' ? 'bottom' : 'top';
  cfg.capture.clearAfterSend = cfg.capture.clearAfterSend !== false;
  cfg.capture.matchRule = str(cfg.capture.matchRule, 'contract_v2') || 'contract_v2';
  if (!['contract_v2', 'all_text', 'custom_tags'].includes(cfg.capture.matchRule)) {
    cfg.capture.matchRule = 'contract_v2';
  }
  const tags = cfg.capture.customTags && typeof cfg.capture.customTags === 'object' ? cfg.capture.customTags : {};
  cfg.capture.customTags = {};
  for (const key of Object.keys(DEFAULT_CUSTOM_TAGS)) {
    const value = str(tags[key]).trim();
    cfg.capture.customTags[key] = value ? value.slice(0, 120) : DEFAULT_CUSTOM_TAGS[key];
  }

  cfg.generation.imageCount = Math.max(1, Math.min(3, num(cfg.generation.imageCount, 1)));
  cfg.generation.countNotSet = cfg.generation.countNotSet === true;
  const cont = cfg.generation.continuous || {};
  cont.on = cont.on === true;
  cont.lora = str(cont.lora);
  const strengths = Array.isArray(cont.strengths) ? cont.strengths : [];
  cont.strengths = Array.from({ length: 3 }, (_, i) => {
    const v = strengths[i];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(-5, Math.min(5, Math.round(n * 10) / 10));
  });
  cfg.generation.continuous = cont;

  cfg.workflowId = str(cfg.workflowId);

  cfg.paths.dataDir = str(cfg.paths.dataDir).trim();
  cfg.paths.outputDir = str(cfg.paths.outputDir).trim();

  // 酒馆通道来源：留空 = 只认酒馆默认端口的两个本机来源；多条用逗号/空格分隔，
  // 逐条补协议、去尾斜杠后再存回去，resolve 时不用再做容错。
  cfg.tavern = cfg.tavern && typeof cfg.tavern === 'object' ? cfg.tavern : {};
  cfg.tavern.origin = (Array.isArray(cfg.tavern.origin) ? cfg.tavern.origin.join(',') : String(cfg.tavern.origin ?? ''))
    .split(/[\s,]+/)
    .map((s) => normalizeBaseUrl(s))
    .filter(Boolean)
    .join(', ');

  return cfg;
}

/** 给前端看的配置：token 不回传明文（只回「有没有配」）。 */
export function publicConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  out.target.hasToken = !!String(cfg.target.token || '').trim();
  out.target.token = '';
  out.source.hasToken = !!String(cfg.source.token || '').trim();
  out.source.token = '';
  return out;
}
