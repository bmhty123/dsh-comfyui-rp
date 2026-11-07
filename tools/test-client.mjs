/**
 * 客户端半区离线冒烟：node tools/test-client.mjs
 *
 * 不装 DSH、不跑浏览器：
 *   · 用 vm 执行 lib/client.js（它只认 window.__ModuleLoader__）
 *   · 假 React（createElement + 最小 hooks），把注册到的组件真调用一遍
 *   · 假 slots / layout / document / EventSource / fetch
 *
 * 覆盖：bundle 能执行 / factory 不抛异常 / 四个席位都注册了 / key 与 id 对 /
 *       面板与悬浮球首次渲染不炸。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let pass = 0;
const fails = [];
function ok(cond, label, extra = '') {
  if (cond) pass += 1; else fails.push(label);
  console.log(`${cond ? '  ✔' : '  ✘'} ${label}${!cond && extra ? `  ${extra}` : ''}`);
}
function eq(got, want, label) {
  ok(Object.is(got, want), label, Object.is(got, want) ? '' : `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}
const section = (t) => console.log(`\n--- ${t} ---`);

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');
const SRC = fs.readFileSync(CLIENT, 'utf8');
const API_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8');

/* ------------------------------- 假 React ------------------------------- */
function makeFakeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(init) {
      const value = typeof init === 'function' ? init() : init;
      return [value, () => {}];
    },
    useEffect() {},
    useRef(v) { return { current: v }; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    Fragment: 'Fragment',
  };
  return React;
}

/* ------------------------------- 假环境 ------------------------------- */
const registrations = [];
const injected = [];
const styleNodes = [];

function makeCtx() {
  const slots = {
    inject(name, fn) {
      injected.push(name);
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {
        const i = registrations.findIndex((r) => r.options === options);
        if (i >= 0) registrations.splice(i, 1);
      };
    },
    entries() { return []; },
  };
  const layout = {
    selected: null,
    selectPanel(id) { this.selected = id; },
  };
  const tabTypes = [];
  const openedTabs = [];
  const sidebarRightTabs = {
    register(def) { tabTypes.push(def); return () => {}; },
  };
  const sidebarRight = {
    openTab(kind) { openedTabs.push(kind); },
  };
  const ctx = {
    slots,
    layout,
    sidebarRightTabs,
    sidebarRight,
    tabTypes,
    openedTabs,
    effect(fn) { return fn(); },
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'layout') return layout;
      if (name === 'sidebarRightTabs') return sidebarRightTabs;
      if (name === 'sidebarRight') return sidebarRight;
      return null;
    },
  };
  return ctx;
}

function runClient() {
  let loaded = null;
  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    __ModuleLoader__: {
      load(def) { loaded = def; },
    },
  };
  const documentObj = {
    head: { appendChild(node) { node.parentNode = documentObj.head; } },
    body: { appendChild() {}, removeChild() {} },
    getElementById(id) { return styleNodes.find((n) => n.id === id) || null; },
    createElement(tag) {
      const node = { tagName: tag, id: '', textContent: '', style: {}, parentNode: null };
      if (tag === 'style') styleNodes.push(node);
      return node;
    },
    execCommand() { return true; },
  };
  const storage = new Map();
  const localStorageObj = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
  };
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; this.onopen = null; this.onerror = null; }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    close() {}
  }
  const fetchStub = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true, version: '0.2.1', routePath: '/__airp_comfy',
      config: { capture: { autoForward: true, autoGenerate: true, source: {}, target: {} }, comfy: { baseUrl: 'http://127.0.0.1:8188' } },
      workflows: [], jobs: [], images: [], logs: [], rules: [], imagesTotal: 0, favoritesTotal: 0, recycleTotal: 0,
      runtime: { dataDir: 'x', outputDir: 'y' },
      activeWorkflowId: '', activeWorkflow: null, activeSessionId: '',
    }),
  });
  const sandbox = {
    window: windowObj,
    document: documentObj,
    localStorage: localStorageObj,
    EventSource: FakeEventSource,
    fetch: fetchStub,
    navigator: { clipboard: { writeText: async () => {} } },
    console: { log() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, String, Number, Object, Array, Set, Map, Error, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'lib/client.js' });
  ok(!!loaded, 'window.__ModuleLoader__.load 被调用');
  ok(loaded && loaded.id === 'dsh-comfyui-rp', 'bundle id 正确', loaded && loaded.id);
  return { loaded, sandbox, windowObj, documentObj };
}

console.log('\n== ComfyRP · 客户端冒烟 ==');
section('bundle 执行');
const { loaded, sandbox } = runClient();
const React = makeFakeReact();
const mod = loaded.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return { createPortal(node) { return node; } };
  throw new Error('未知 require: ' + name);
});
ok(!!mod && typeof mod.apply === 'function', 'factory 返回 apply');
ok(mod.name === 'dsh-comfyui-rp-client', '客户端插件 name 正确', mod.name);
ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 含 slots');
ok(Array.isArray(mod.inject) && mod.inject.includes('sidebarRightTabs'), 'inject 含 sidebarRightTabs');

section('工作台草稿 / 日间模式');
const testApi = mod.__test || {};
try {
  const wrote = testApi.writeWorkbenchDraft({
    sets: [{ title: '草稿', anchor: '她推开门，雨声一下子涌进来。', size: { w: 832, h: 1216 }, positive: '1girl, solo', negative: 'blur' }],
    sizeMode: 'dsh', sizeDraft: { w: 832, h: 1216 },
    sourceSessionId: 's-src', sourceSessionTitle: '来源会话', sourceTurn: 7,
  });
  eq(wrote, true, '工作台草稿写入成功');
  const draft = testApi.readWorkbenchDraft();
  eq(draft?.sets[0]?.positive, '1girl, solo', '草稿正面持久化');
  eq(draft?.sets[0]?.negative, 'blur', '草稿负面持久化');
  eq(draft?.sets[0]?.anchor, '她推开门，雨声一下子涌进来。', '草稿原文锚点持久化');
  eq(draft?.sourceTurn, 7, '草稿来源 turn 持久化');
  eq(draft?.sizeMode, 'dsh', '草稿分辨率模式持久化');
  ok(draft?.savedAt > 0, '草稿带保存时间，供自动流程判断新旧');
  sandbox.localStorage.setItem('airp-comfy:float:v3', JSON.stringify({ adaptive: false, frame: { emptyW: 700, emptyH: 800 } }));
  const fp = testApi.loadFloatPrefs();
  ok(!('adaptive' in fp), '自适应选项已删除（旧字段被忽略）');
  eq(fp.frame.emptyW, 700, '空白框尺寸保留之前设置的宽');
  eq(fp.frame.emptyH, 800, '空白框尺寸保留之前设置的高');
  eq(fp.follow, true, '跟随滚动默认开启');
  eq(fp.pointerFollow, false, '光标跟随默认关闭');
  eq(fp.debug, false, '跟图调试默认关闭');
  eq(fp.open, true, '首次安装默认展开图片框');
  sandbox.localStorage.removeItem('airp-comfy:float:v3');
  testApi.saveTheme('light');
  eq(testApi.loadTheme(), 'light', '日间模式持久化');
  testApi.saveTheme('dark');
  sandbox.localStorage.removeItem('airp-comfy:workbench:v1');
  ok(!/桥正在为/.test(SRC), '删掉了会变化的「桥正在为…服务」状态文案');
  testApi.writeFloatHidden(true);
  eq(testApi.readFloatHidden(), true, '悬浮球隐藏状态可持久化');
  testApi.writeFloatHidden(false);
  sandbox.localStorage.removeItem('airp-comfy:float-hidden:v1');
} catch (e) {
  ok(false, '工作台草稿 / 日间模式不炸', e.message);
}

section('席位注册');
const ctx = makeCtx();
const dispose = mod.apply(ctx);
ok(typeof dispose === 'function', 'apply 返回 disposer');
ok(styleNodes.length === 1, '注入了一份样式');
const names = registrations.map((r) => r.options.name);
ok(names.includes('sidebar.right.pane.tab'), '注册了右侧栏正文');
ok(names.includes('sidebar.right.pane.tab.title'), '注册了右侧栏标签标题');
ok(!names.includes('sidebar.panellist'), '不再占用左侧栏');
ok(!names.includes('main'), '不再占用主区整页');
ok(names.includes('shell.overlay'), '注册了 shell.overlay');
ok(names.includes('conversation.input.dock'), '注册了 conversation.input.dock');

const body = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab');
ok(body && body.options.key === 'dsh-comfyui-rp', '正文 key = 插件 id');
ok(body && typeof body.component === 'function', '正文有组件');
ok(body && typeof body.options.inject === 'function' && body.options.inject('s1').sessionId === 's1', '正文能拿到 sessionId');
const titleSeat = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab.title');
ok(titleSeat && titleSeat.options.key === 'dsh-comfyui-rp', '标题 key = 插件 id');

ok(ctx.tabTypes.length === 1, '注册了一个右侧栏类型');
const def = ctx.tabTypes[0] || {};
ok(def.id === 'dsh-comfyui-rp', '类型 id 正确', def.id);
ok(def.kind === 'airp', '类型 kind = airp', def.kind);
ok(def.title && def.title() === 'ComfyRP', '标签名 = ComfyRP');
ok(def.keepMounted !== true, '切页 / 收起后卸载页面，避免后台 SSE');
ok(Array.isArray(def.guide) && def.guide.length === 1, '开始菜单有一张 ComfyRP 卡片');
const card = (def.guide || [])[0] || {};
ok(card.id === 'airp' && card.title() === 'ComfyRP', '开始菜单卡片 id / 标题正确');
ok(card.order === 30, '开始菜单卡片排在文件 / 终端之后', card.order);
ok(typeof card.description === 'function' && card.description().includes('本会话'), '开始菜单卡片说明含「本会话」');
ok(typeof card.icon === 'function', '开始菜单卡片有图标');

section('组件首次渲染');
const T = mod.__test || {};
try {
  const el = body.component({ sessionId: 's1' });
  ok(!!el, 'BridgePanel 渲染出元素');
  ok(el.props && el.props.className === 'ac-root', '根节点是 ac-root');
  const header = (el.children || []).find((c) => c && c.props && c.props.className === 'ac-top');
  ok(!!header, '有顶部导航区');
  ok((header?.children || []).length === 1 && header.children[0].props.className === 'ac-navrow', '菜单栏直接置顶，品牌标题行已移走');
  ok(!(header?.children || []).some((c) => c && (c.props?.className === 'ac-toprow' || c.props?.className === 'ac-brandline')), '顶部不再显示 ComfyRP 图标 / 标题');
  ok(!(header.children || []).some((c) => c && c.props && c.props.className === 'ac-session'), '删掉了固定的本会话状态条');
  const navrow = (header.children || []).find((c) => c && c.props && c.props.className === 'ac-navrow');
  const seg = navrow && (navrow.children || []).find((c) => c && c.props && c.props.className === 'ac-seg');
  const navLabels = (seg ? seg.children : []).map((b) => b && b.children).join(',');
  ok(navLabels === '概览,工作台,LoRA,工作流,图库,设置,日志', '导航顺序：LoRA 在图库之前', navLabels);
  const topacts = navrow && (navrow.children || []).find((c) => c && c.props && c.props.className === 'ac-topacts');
  const actTitles = (topacts ? topacts.children : []).map((b) => b && b.props && b.props.title);
  ok(actTitles.some((t) => /日间模式|夜间模式/.test(t || '')), '顶部有日间 / 夜间模式按钮', actTitles.join('|'));
  ok(actTitles.some((t) => /悬浮球/.test(t || '')), '顶部图片按钮可隐藏 / 显示悬浮球', actTitles.join('|'));
  ok(!actTitles.some((t) => t === '刷新'), '顶部删掉了刷新按钮', actTitles.join('|'));
  ok(actTitles.some((t) => /全屏/.test(t || '')), '顶部有全屏按钮', actTitles.join('|'));
} catch (e) {
  ok(false, 'BridgePanel 渲染不炸', e.message);
}
const cssText = styleNodes[0] ? styleNodes[0].textContent : '';
ok(/\.ac-fullview\{/.test(cssText) && /\.ac-root\.fullimg\{background:transparent/.test(cssText), '全屏最新图是透明底');
ok(/\.ac-root\.light\{/.test(cssText), '有日间模式浅色变量');
ok(/\.ac-toast\.light\{/.test(cssText), '日间模式提示也是浅色');
ok(/\.ac-genbtn\{/.test(cssText), '生成图片按钮有放大样式');
ok(/\.ac-linkbtn\{/.test(cssText), '提取按钮并入提示词标题行');
ok(/从当前会话提取/.test(SRC) && /extractFrom\("source"\)/.test(SRC) && /promptSourceText/.test(SRC), '工作台有「提取」和「从当前会话提取」两个来源');
ok(!/saveToastTimer/.test(SRC) && /不再弹「已保存」/.test(SRC), '工作台自动保存不再弹「已保存」');
ok(/提示词已全部清空，保留一组空白/.test(SRC), '全部清空有专属提示');
ok(/\.ac-in:disabled/.test(SRC) && /disabled: sizeLocked/.test(SRC) && /听从会话 size/.test(SRC), '勾选听从会话 size 后宽高锁定');
ok(/sizeMode === "dsh"[\s\S]{0,120}sessionSize \|\| sizeDraft[\s\S]{0,120}: \(sizeDraft/.test(SRC), '手动模式不使用提取出来的会话 size');
ok(/jobStatusLabel = "空闲"/.test(SRC), '没图时状态显示空闲');
ok(/ac-toaststack/.test(cssText) && /setToasts/.test(SRC) && /2100/.test(SRC), '提示改为 2.1 秒并支持堆叠');
ok(!/4500/.test(SRC), '旧提示时长已减半（普通提示 2.1s，全局消息 4.2s）');
ok(/\.ac-fullview \.ac-bl\.show/.test(cssText) && /fullBLNear/.test(SRC) && /h\(FrameTools/.test(SRC), '全屏左下菜单靠近才显示，和悬浮窗共用');
ok(/ac-top\{[^}]*padding:0 12px/.test(cssText) && /ac-navrow\{[^}]*height:40px/.test(cssText), '菜单栏置顶并预留横线高度');
ok(/ComfyRP/.test(SRC) && /ComfyRP Bridge/.test(SRC) && /投递正文·接收提示词·返回图片/.test(SRC), '概览使用 ComfyRP 和固定说明');
ok(/基础信息/.test(SRC) && /工作流/.test(SRC) && /ac-basicrow/.test(SRC), '概览有可点击基础信息和工作流');
ok(/grid-template-columns:86px minmax\(0,1fr\) auto 12px/.test(cssText) && /ac-basicgo\{[^}]*justify-self:end/.test(cssText) && !/\.ac-basicrow\{[^}]*border-bottom/.test(cssText), '基础信息不逐行画线，小字靠右在三角左边');
ok(/自动投递正文/.test(SRC) && !/更换会话/.test(SRC), '自动投递改名为自动投递正文，删掉更换会话');
ok(/附加消息/.test(SRC) && /正文最上面/.test(SRC) && /正文最下面/.test(SRC) && /extraPosition/.test(SRC), '概览有附加消息与置顶 / 置底');
ok(/ac-deliverygrid/.test(cssText) && /grid-template-columns:minmax\(0,1fr\) 128px/.test(cssText) && /ac-deliverytoggles/.test(SRC), '附加消息在左，位置下拉在右，开关在按钮右侧');
ok(!/并非本会话/.test(SRC) && /api\.forwardSource/.test(SRC), '手动投递按正文来源会话取正文，删掉并非本会话小字');
ok(/api\.forwardSource\(\{\s*autoGenerate: genNow/.test(SRC) && /api\.forwardSource\(\{\s*autoGenerate: autoGenerate/.test(SRC), '概览和悬浮球都走正文来源投递');
ok(/capture: \{ autoForward: next, autoGenerate: next \}/.test(SRC) && /cap\.autoForward !== false && cap\.autoGenerate !== false/.test(SRC), '悬浮窗 A 同步自动投递正文和自动出图两项');
ok((SRC.match(/className: "ac-genbtn"/g) || []).length >= 2, '投递最新正文与生成图片按钮同尺寸');
ok(/ac-pathlink/.test(cssText) && /openSavePath\("all"/.test(SRC) && /openSavePath\("recycle"/.test(SRC), '设置里的输出目录 / 回收站路径可点击打开');
ok(/recycleImage/.test(SRC) && /recycleNotice/.test(SRC) && /deleteBusy/.test(SRC) && /recycleGuard/.test(SRC), '图片删除有并发去重和重复操作提示');
ok(/prompt-source\/text/.test(API_SRC) && /session-text/.test(API_SRC) && /forward-source/.test(API_SRC), '提示词来源 / 会话正文 / 正文来源投递接口已注册');
ok(/bodyPreview: function/.test(SRC) && /body-source\/preview/.test(SRC) && /body-source\/preview/.test(API_SRC), '概览正文框走只读预览接口，不会误触投递');
ok(/loading: "eager"/.test(SRC) && /fetchpriority: i < 3 \? "high" : "auto"/.test(SRC), '图库首屏图片立即加载并提高优先级');
ok(/pre\.decoding = "async"/.test(SRC) && /fullSafeIdx \+ 1/.test(SRC), '全屏预取相邻图片，翻页更快');
ok(/max-age=604800, immutable/.test(API_SRC) && /Last-Modified/.test(API_SRC), '图片端缓存改为长缓存 + immutable');
ok(/选择工作流预设/.test(SRC) && /该界面修改完记得点保存，不涉及 lora 相关/.test(SRC), '工作流标题和保存提示已改');
ok(/新建并保存/.test(SRC) && /saveAsNew/.test(SRC) && /保存为新工作流/.test(SRC), '工作流页有新建并保存 / 保存为新工作流入口');
ok(/给这份工作流起个名字/.test(SRC) && /asNew = !wf\.id/.test(SRC) && /askName\(name\)/.test(SRC), '新建或导入草稿保存时自动弹命名框');
ok(/name: baseName/.test(SRC) && /已导入为草稿/.test(SRC) && /setId\(""\)/.test(SRC), '导入 JSON 后变成未保存草稿，不再覆盖当前工作流');
ok(!/onClick: create \}, "新建"/.test(SRC) && /重新读取/.test(SRC) && !/设为当前/.test(SRC), '删掉右上新建，设为当前改成重新读取');
ok(/在这里导入和测试工作流文件/.test(SRC), '工作流 JSON 收起说明已改');
ok(/导入 JSON 后点「保存为新工作流」/.test(SRC) && /ac-jsonacts/.test(cssText) && !/ac-filepick\{margin-left:auto/.test(cssText), 'JSON 按钮旁有保存提示，导入按钮不再靠右');
const importAt = SRC.indexOf('"导入JSON"');
const parseAt = SRC.indexOf('"解析预览"');
ok(importAt >= 0 && parseAt > importAt, '「导入JSON」在「解析预览」左边');
ok(!/w\.name \+ \(w\.active \? " · 当前" : ""\) \+ "（"/.test(SRC), '工作流名去掉节点数后缀');
ok(!/ID " \+ wf\.id/.test(SRC), '工作流 ID 行已被保存提示替换');
ok(/loraDetected/.test(SRC) && /当前按工作流原样/.test(SRC) && /检测到 " \+ Math.max/.test(SRC), '干跑如实显示 LoRA 检测数和覆盖状态');
ok(/mapping: wf\.mapping/.test(SRC), '干跑把界面上当前选择的映射一起发出去（不用先保存）');
ok(/sz\.matched/.test(SRC) && /无需改动/.test(SRC), '干跑区分「已是目标分辨率」和「没有可用值」');
ok(!/占位符为空时/.test(SRC) && !/只留 #/.test(SRC), '删掉「占位符为空时」和「只留 #」按钮');
{
  const presetAt = SRC.indexOf('title: "选择工作流预设"');
  const jsonAt = SRC.indexOf('title: "工作流 JSON"');
  const outputAt = SRC.indexOf('title: "图片输出相关"');
  ok(presetAt >= 0 && jsonAt > presetAt && outputAt > jsonAt, '预设后面直接是 JSON，图片输出相关在后面');
  ok(SRC.indexOf('每次换随机种子', outputAt) > outputAt && SRC.indexOf('提交前裁剪输出节点', outputAt) > outputAt, '开关移进图片输出相关的额外设置');
}
ok(!/兜底只返回第一张/.test(SRC), '删掉兜底只返回第一张开关');
ok(/ac-maprow/.test(SRC) && /ac-mapnode/.test(SRC) && /ac-tokenlist/.test(SRC) && /ac-tokenlink/.test(SRC) && !/maxHeight: 300/.test(SRC), '节点只读列表 / 可复制占位符样式，不再有滚动窗口');
ok(!/hasTokenInfo/.test(SRC) && /h\("div", \{ className: "ac-tokenlist" \}/.test(SRC), '占位符列表不再按计数隐藏');
ok(!/formatReveal/.test(SRC) && !/打开文件夹/.test(SRC) && /内置匹配方式（contract_v2）/.test(SRC) && /ac-helpcode/.test(cssText), '删掉打开文件夹，改成内置匹配方式说明弹窗');
ok(/formatReference/.test(SRC) && /格式要求文件参考/.test(SRC) && /PROMPT_FORMAT_REFERENCE\.md/.test(SRC) && /只是随插件附带/.test(SRC), '？弹窗新增格式参考文件按钮，并说明不参与解析');
ok(/支持自动识别标题、size和正面提示词/.test(SRC) && !/提示词来源不会自动知道本插件需要什么格式/.test(SRC), '内置格式说明已简化');
ok(/仅格式要求，建议放到目标会话所在工作区让agent遵守/.test(SRC), '格式规范改成工作区建议');
ok(/暂不提供生图提示词预设，建议选择具有提示词产出能力的会话/.test(SRC) && !/只列未归档会话；由 session\/event 捕获/.test(SRC), '提示词来源 / 正文来源说明已改');
ok(/h\(PaletteGlyph, \{ size: 25 \}\)/.test(SRC) && !/🎨/.test(SRC), '悬浮球改用概览同款图标');
const saveAt = SRC.indexOf('h(Btn, { small: true, onClick: save, disabled: !wf || busy }');
const renameAt = SRC.indexOf('h(Btn, { small: true, disabled: !wf, onClick: rename }');
ok(saveAt >= 0 && renameAt > saveAt, '保存按钮排在工作流按钮组最左边');
ok(/生成图片后自动创建文件夹/.test(SRC) && /noImages/.test(SRC), '没图打开位置只提示，不创建文件夹');
ok(!/Select, \{ value: workflowId/.test(SRC) && /activeWorkflowId !== workflowId/.test(SRC), 'LoRA 页去掉单独工作流选择，跟随当前预设');
ok(/按工作流原样/.test(SRC) && /LoRA 目录 /.test(SRC) && !/未保存记录/.test(SRC), 'LoRA 状态和目录说明已改');
ok(/props\.subtitle \? h\("span", \{ className: "ac-h2sub" \}/.test(SRC) && /\.ac-h2sub\{/.test(cssText), 'Card 支持标题下方副行样式');
ok(/subtitle: data \? loraBadges : null/.test(SRC), 'LoRA 的「按工作流原样」和目录计数气泡移到标题下副行');
ok(/没有识别到 LoRA 节点/.test(SRC) && /Power Lora Loader/.test(SRC) && /Lora Stacker/.test(SRC), 'LoRA 空态说明覆盖散装节点');
ok(/LoRA 堆/.test(SRC) && /普通 LoRA 节点/.test(SRC) && /looseItems/.test(SRC), 'LoRA 页分「堆」和「普通节点」两组');
ok(/collapsedStacks/.test(SRC) && /toggleStack/.test(SRC) && /展开这一堆/.test(SRC), 'LoRA 堆支持折叠展开');
ok(/\.ac-lorarow\.loose\{/.test(cssText) && /!canSort && "loose"/.test(SRC), '普通节点行去掉拖动列，只留开关和强度');
ok(/ac-loraname/.test(cssText) && /beginNameEdit/.test(SRC) && /commitNameEdit/.test(SRC) && /labelCustom/.test(SRC), 'LoRA 名称可点击改名并写进 loraState');
ok(/点击 LoRA 名称可改显示名/.test(SRC) && /重置会恢复默认名/.test(SRC), 'LoRA 页有改名小字说明');
ok(/isContTaken/.test(SRC) && /连续图接管/.test(SRC) && /taken && "cont"/.test(SRC) && /disabled: taken/.test(SRC), '连续图选中的 LoRA 灰显并禁用开关 / 强度，但保留拖动');
ok(/contHasStrength/.test(SRC) && /typeof v === "number" && Number\.isFinite\(v\)/.test(SRC), '连续图没有有效强度时不误灰 LoRA');
ok(/clamp\(value, -5, 5\)/.test(SRC) && !/clamp\(value, 0, 2\)/.test(SRC), '连续图档位允许负数（夹到 -5~5，不再夹到 0）');
ok(/editContStrength/.test(SRC) && /commitContStrength/.test(SRC), '连续图档位输入期间保留原文（- / -.5），失焦才兜底');
ok(/editStrength\(st\.nodeId, i/.test(SRC) && /commitStrength\(st\.nodeId, i/.test(SRC), 'LoRA 页强度输入允许打负数中间态，失焦才夹取');
ok(/min: "-5", max: "5"/.test(SRC), '强度输入框标注 -5~5 范围（连续图和 LoRA 页各一处以上）');
ok(/强度可以填负数/.test(SRC), '连续图说明里写清了可填负数');
ok(/label: "固定种子"/.test(SRC) && /disabled: seedAuto/.test(SRC), '工作流页有固定种子输入框，自动换种子时置灰不可编辑');
ok(/lastSeed/.test(SRC) && /toggleRandomSeed/.test(SRC), '自动模式下显示上一轮用的种子，取消自动时把它带进输入框');
ok(/persistWf/.test(SRC), '改种子 / 切换开关立刻落库，不用再点保存');
ok(/ac-blackbar/.test(cssText) && /停止自动补图/.test(SRC), '自动补图时面板顶部有「停止自动补图」条');
ok(/BLACK_UI\.stop/.test(SRC) && /setBlackPendingGlobal/.test(SRC), '补图状态跨组件共享（FloatBall 跑，面板显示）');
ok(/blackStopRef\.current = false/.test(SRC), '停止只影响本轮，下一轮新任务会复位');
ok(/live = blackActive \|\|/.test(SRC), '补图进行中，图片框菜单把「请求生成」换成「终止」');
ok(/if \(blackQueueRef\.current\.length \|\| blackBusyRef\.current\) \{[\s\S]{0,80}stopBlack\(\)/.test(SRC), '图片框菜单的「终止」会先停掉自动补图');
ok(/if \(BLACK_UI\.stop\) BLACK_UI\.stop\(\)/.test(SRC), '全屏 / 工作台的「终止」也会停掉自动补图');
ok(/黑图自动替换/.test(SRC) && /persistWf\(\{ blackRetry: e\.target\.checked \}\)/.test(SRC), '工作流页「图片输出相关」有黑图自动替换开关');
ok(/activeWorkflow\.blackRetry === false/.test(SRC) && /blackQueueRef\.current = \[\]/.test(SRC), '关掉开关后不再检测，并清空待补队列');
ok(/function judgeNearlyBlack\(d\)/.test(SRC) && /darkRatio >= 0\.995 && meanLum <= 8 && brightRatio < 0\.001/.test(SRC), '纯黑判定要同时满足暗比例 / 平均亮度 / 亮点比例');
ok(/coverage >= 0\.5/.test(SRC), '透明图（不透明像素不足一半）不算黑');
{
  // 直接抽 client.js 里的 judgeNearlyBlack 跑样本：纯函数，可以在 Node 里验证。
  const at = SRC.indexOf('function judgeNearlyBlack(d) {');
  ok(at >= 0, '纯黑判定抽成了纯函数');
  if (at >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const fn = new Function(`${SRC.slice(at, end)}; return judgeNearlyBlack;`)();
    const mk = (px) => {
      const d = new Uint8ClampedArray(px.length * 4);
      px.forEach((p, i) => {
        d[i * 4] = p[0]; d[i * 4 + 1] = p[1]; d[i * 4 + 2] = p[2];
        d[i * 4 + 3] = p[3] === undefined ? 255 : p[3];
      });
      return d;
    };
    const rep = (n, p) => Array.from({ length: n }, () => p);
    eq(fn(mk(rep(4096, [0, 0, 0]))).black, true, '全黑图判为黑');
    eq(fn(mk(rep(4096, [3, 3, 3]))).black, true, '3/255 的近黑也算黑');
    eq(fn(mk(rep(4096, [10, 10, 10]))).black, false, '10/255 的深灰不算黑（旧逻辑会误判）');
    eq(fn(mk([...rep(4000, [2, 2, 2]), ...rep(96, [220, 220, 220])])).black, false, '夜景（97% 暗 + 少量亮）不算黑');
    eq(fn(mk([...rep(4050, [3, 3, 3]), ...rep(46, [240, 240, 240])])).black, false, '黑底小主体不算黑');
    eq(fn(mk(rep(4096, [0, 0, 0, 0]))).black, false, '全透明图不算黑');
    eq(fn(mk([...rep(10, [0, 0, 0]), ...rep(4086, [0, 0, 0, 0])])).black, false, '透明底 + 小黑块不算黑');
  }
}
ok(/BLACK_MAX_BYTES = 120000/.test(SRC) && /bytes > BLACK_MAX_BYTES/.test(SRC), '体积超过 120KB 的图不参与黑图判定（真黑图只有 20 多 KB）');
ok(/probeBlackImage/.test(SRC) && /isNearlyBlack\(url, true\)/.test(SRC), '判黑要两次都黑才算（第二次绕过缓存再确认）');
ok(/reportBlackCheck/.test(SRC) && /blackCheck\(/.test(SRC), '每次判定都把统计写进 Host 日志，便于复查误判');
ok(/nameEditRef\.current = null;[\s\S]{0,60}setNameEdit\(null\)/.test(SRC), '换工作流时取消正在编辑的 LoRA 名');
ok(/effectiveSource: "temporary"/.test(SRC) && /临时覆盖（未保存）/.test(SRC), '改动 LoRA 节点后徽标立即变成临时覆盖');
ok(/lorasApply\(\{ workflowId: workflowId \}\)/.test(SRC) && /不需要再去工作流页点保存/.test(SRC) && /不需要再回工作流页点保存/.test(SRC), '保存到工作流会清临时覆盖，并提示无需回工作流页保存');
ok(/LS_WORKBENCH/.test(SRC) && /writeWorkbenchDraft/.test(SRC), '工作台有永久草稿保存');
ok(/formatHelp/.test(SRC) && /setFormatHelp/.test(SRC) && /内置匹配方式说明/.test(SRC), '格式规范有「？」说明弹窗入口');
ok(/"all_text"/.test(SRC) && /"custom_tags"/.test(SRC), '设置里有全部匹配 / 自定义');
ok(/FLOAT_VIS_EVENT/.test(SRC) && /float-hidden:v1/.test(SRC), '悬浮球隐藏状态有本地持久化与同步事件');
ok(/onPointerDown: function \(ev\)/.test(SRC) && !/draggable: true/.test(SRC) && !/onDrag(Start|Over|Drop|End)/.test(SRC), 'LoRA 排序改成 pointer 拖动，不再触发浏览器原生拖拽');
ok(/srcDraft/.test(SRC) && /tgtDraft/.test(SRC) && /next\.capture = Object\.assign/.test(SRC), '来源设置本地即时渲染并同步 state.capture');
ok(/投递正文·接收提示词·返回图片/.test(SRC), '顶部说明固定，不再按会话变化');
ok(/ac-inlinehint/.test(SRC) && /· /.test(SRC), '听从会话 size 与说明在同一行');
ok(/全部清空/.test(SRC), '工作台有「全部清空」');
ok(/最多匹配几套提示词/.test(SRC), '最多套数改成「最多匹配几套提示词」');
ok(/图片保存/.test(SRC) && /当前聊天/.test(SRC), '设置有图片按当前聊天保存的说明');
ok((SRC.match(/h\(FrameTools/g) || []).length >= 2 && /openFullImage/.test(SRC) && /fullCloseNear/.test(SRC), '全屏和悬浮窗共用左下菜单，保留叉叉');
ok(!/bubble\("adaptive"/.test(SRC) && /bubble\("download"/.test(SRC) && /bubble\("fav"/.test(SRC), '悬浮球三级菜单删掉自适应，保留下载 / 收藏');
ok(!/bubble\("view"/.test(SRC) && !/bubble\("copy"/.test(SRC) && !/bubble\("panel"/.test(SRC), '悬浮球三级菜单删掉看大图 / 复制 / 打开面板');
ok(/fitFrameToImage/.test(SRC) && !/prefs\.adaptive/.test(SRC) && /emptyW/.test(SRC) && /width:100%;height:100%;object-fit:contain/.test(cssText), '空白用保存尺寸，图片整张装进框里，不裁切');
ok(/if \(frame\.userSized\) \{ fitAnchorRef\.current = ""; return; \}/.test(SRC) && /userSized: true/.test(SRC), '普通悬浮框切图保留用户缩放 / 位置，不回归初始大小');
ok(/stateSignature/.test(SRC) && /dataSig/.test(SRC) && /imgIdRef/.test(SRC) && /fittedImgId/.test(SRC), '悬浮窗状态去重，并按图片 id 保持当前页不跳');
ok(/fitAnchorRef/.test(SRC) && /fitAnchorRef\.current = "left"/.test(SRC) && /fitAnchorRef\.current = "right"/.test(SRC) && /arrowMidY/.test(SRC) && /targetX = oldRight - tw/.test(SRC), '翻页时点击侧箭头的位置保持不动（左右都锚定）');
ok(!/capW = square/.test(SRC) && /var maxH = Math\.max\(1, size\.h\)/.test(SRC) && /frameRatio/.test(SRC), '手动 / 自动切图都用视口高度自适应，不再被旧底边卡住，比例不符会补一次');
ok(/translate3d/.test(SRC) && /will-change:transform/.test(cssText) && /pendingData/.test(SRC) && /pendingLoad/.test(SRC) && /dragRaf/.test(SRC), '拖动走合成层 + 按帧节流，拖动中暂缓换数据 / 刷新避免闪烁');
ok(/\.ac-frame\{[^}]*border:1px solid/.test(cssText), '图片框保留 1px 细边框');
ok(/new Image\(\)/.test(SRC) && /pendingView/.test(SRC) && /setViewImg/.test(SRC), '下一张先预加载再换图，切换时不空白');
ok(/cachedImageSrc/.test(SRC) && /IMG_SRC_READY/.test(SRC) && /cachedImageSrcNow/.test(SRC) && /viewSrc \|\| view\.url/.test(SRC), '切回看过的图走 Blob 缓存，不再重复下载 / 转圈');
ok(/fullSrc\.key/.test(SRC) && /cachedImageSrcNow\(retryUrl\)/.test(SRC), '右侧栏全屏也复用 Blob 缓存，不串图');
ok(/fallbackTimer/.test(SRC) && /show\(0, 0, target\.url\)/.test(SRC) && /最多等 1\.5 秒/.test(SRC), '删除 / 出图后预加载过慢最多等 1.5 秒，不会一直加载中');
ok(/followApply/.test(SRC) && /followPercentTarget/.test(SRC) && /data-chat-turn/.test(SRC) && /followNormChar/.test(SRC) && /Range/.test(SRC), '跟随滚动：句子锚点 + Range 定位 + 百分比回退');
ok(/followPause/.test(SRC) && /followPauseKey/.test(SRC) && /if \(followOn \|\| pointerFollow\) followPause\(\)/.test(SRC), '手动翻页后暂停跟随，滚到下一个锚点再恢复');
ok(/anchor/.test(SRC) && /原文锚点/.test(SRC) && /sourceTurn/.test(SRC) && /getAttribute\("data-chat-turn"\)/.test(SRC), '工作台有原文锚点，图片带 turn 和 anchor');
ok(/followAnchorGroups/.test(SRC) && /followInsertTarget/.test(SRC) && /baselineDoc/.test(SRC) && /atBottom/.test(SRC) && /scrollHeight - host.scrollTop - host.clientHeight/.test(SRC), '插入点按中线计数切图，滚到底强制最后一张');
ok(/isContinuousImage/.test(SRC) && /continuousShot/.test(SRC) && /variants/.test(SRC) && /start \+ step \* \(k \+ 1\)/.test(SRC), '连续图按段落比例拆位置，不是只留最后一张');
ok(/if \(read\.atBottom && imgs\.length\)/.test(SRC) && /var lastIndex = imgs\.length - 1;/.test(SRC), '段落太短滚到底仍显示最后一张');
ok(/groups\[n\]\.yDoc = groups\[n\]\.point - viewTop \+ scrollTop/.test(SRC) && /read\.host\.clientWidth/.test(SRC), '锚点文档坐标减去会话区 top，菜单栏 / 全屏切换不再产生固定偏移');
ok(/ac-followoffset/.test(cssText) && /changeFollowOffset/.test(SRC) && /ac-followline-offset/.test(cssText) && /手动偏移/.test(SRC) && /上=提前/.test(SRC), '跟图调试有手动偏移滑块和蓝色偏移线');
ok(/onClearAnchors/.test(SRC) && /清空定位/.test(SRC) && /clearAnchors/.test(SRC) && /按当前会话区域比例/.test(SRC) && /api\.clearAnchors\(\{ sessionId: sid, sessionTitle: title \}\)/.test(SRC), '清空定位只清当前会话，回退按比例分配');
ok(/清空当前会话所有图片的原文锚点/.test(SRC) && /其它会话不受影响/.test(SRC), '清空定位的确认框明确只影响当前会话');
ok(/没有当前会话，无法清空定位/.test(SRC) && /sessionId: sid,[\s\S]{0,120}sessionTitle: String\(\(state && state.activeSessionTitle\)/.test(SRC), '右侧栏全屏清空定位也带当前会话 id');
ok(/pointerFollow/.test(SRC) && /onPointerMove/.test(SRC) && /光标跟随/.test(SRC) && /pointerYRef/.test(SRC), '可选光标跟随：鼠标在正文区域移动时切图');
ok(/showToast\("跟随滚动：/.test(SRC) && /showToast\("光标跟随：/.test(SRC), '跟随滚动 / 光标跟随切换有提示反馈');
ok(/ac-followline/.test(cssText) && /ac-followhud/.test(cssText) && /跟图采样/.test(SRC) && /当前图：/.test(SRC) && /目标区域：/.test(SRC), '跟图调试画出中线 / 当前图 / 目标区域 / 采样信息');
ok(/var currentId = String\(imgIdRef\.current/.test(SRC) && /切过去就再也切不回来/.test(SRC), '跟图比较当前图用 ref，避免闭包里的旧 img 把切图卡死');
ok(/followNextAt/.test(SRC) && /followTimerDue/.test(SRC) && /pointerLastAt/.test(SRC) && /followPointerPulse/.test(SRC), '滚动 / 光标采样用节流，不会连续移动时一直推迟');
ok(/旧图既没有锚点也没有 turn/.test(SRC) && /recentBucket/.test(SRC) && /latestJobId/.test(SRC), '既没锚点也没 turn 的旧图，最新一轮按最近一次出图等分回退');
ok(/rr\.width <= 0\.5/.test(SRC) && /零宽 rect/.test(SRC), '锚点量位置时过滤段尾零宽 caret，避免插入点晚一行');
ok(/point = lineTop \+ \(lineBottom - lineTop\) \* 0\.5/.test(SRC) && /groups\[n\]\.yDoc = groups\[n\]\.point/.test(SRC) && /文字中心/.test(SRC), '插入点用最后一行文字中心，线落在字上而不是行框底部');
ok(/followFrame/.test(SRC) && /requestAnimationFrame|raf\(run\)/.test(SRC) && /followRaf/.test(SRC) && /triggerDelta/.test(SRC), '滚动 / 光标按帧采样，并在 HUD 显示触发差');
ok(/anchor: String\(\(s && s\.anchor\) \|\| ""\)/.test(SRC) && /savedAt: draftAtRef\.current/.test(SRC), '工作台草稿保存 / 读回原文锚点，自动保存不把任务永久压在草稿后面');
ok(/ac-anchorbox/.test(cssText) && /ac-anchorstate/.test(cssText) && /原文锚点/.test(SRC) && !/未设置原文锚点/.test(SRC), '工作台只保留锚点输入框，不再重复三处插入点文案；匹配后只显示一条小字');
ok(/imageId: imageId/.test(SRC) && /setIndex: setId/.test(SRC) && /pendingShowJobRef/.test(SRC), '重新生成只带当前图片 id / setIndex，并在新图到达后自动选中');
ok(/var imgDead = /.test(SRC) && /knownAt/.test(SRC) && /replaced\[at\] = Object\.assign/.test(SRC), '图片事件按 id 原位更新，替换图不再插到最新');
ok(/regenMode !== "single" && regenMode !== "reuse" && regenMode !== "auto"/.test(SRC), '仅此图原地替换不把全屏页码拉回最新');
ok(/var fullMediaKey = fullItem/.test(SRC) && /fullSrc\.key === fullMediaKey/.test(SRC), '原地替换后全屏大图按 URL 版本刷新');
ok(/replaceOld: genNow/.test(SRC) && /replaceOld: body\.replaceOld/.test(API_SRC) && /sessionImageIds/.test(fs.readFileSync(path.join(ROOT, 'lib', 'store.js'), 'utf8')), '请求生成把当前会话旧图整套替换为回收站');
ok(/clearAfterSend/.test(SRC) && /投递后自动留空/.test(SRC), '概览位置下面有「投递后自动留空」，默认开');
ok(/preferImgId/.test(SRC) && /imgs\[safeIdx \+ 1\] \|\| imgs\[safeIdx - 1\]/.test(SRC), '删除后优先下一张，没有下一张再上一张');
ok(/picRows\.filter\(function \(x\) \{ return x && !x\.recycled && !x\.deletedAt; \}\)/.test(SRC) && /IMAGE_EVENT/.test(SRC) && /fireImageChanged/.test(SRC), '图片框过滤回收站图，图库删除会广播同步');
ok(/setViewImg\(null\)[\s\S]{0,160}setViewTick/.test(SRC) && /dataSig\.current = "";[\s\S]{0,180}load\(true\)/.test(SRC), '图片框刷新会丢掉旧 view 并强制重拉状态');
ok(/ac-counter/.test(cssText) && /flashCounter/.test(SRC) && /counterVisible/.test(SRC), '图片框顶部有短暂显示的 xx/xx');
ok(/onDoubleClick: function \(e\)[\s\S]{0,260}collapse\(e\.clientX, e\.clientY\);/.test(SRC) && !/if \(view\) openViewer/.test(SRC), '双击图片框收回悬浮球');
ok(/\.ac-frame \.ac-tr/.test(cssText) && /nearAny/.test(SRC) && /sidebarR/.test(SRC) && /openSidebarFull/.test(SRC) && /FULL_OPEN_EVENT/.test(SRC), '图片框右上角靠近出现侧栏按钮');
ok(/var openSidebarFull = function \(\)[\s\S]{0,520}setPref\(\{ reserve: "" \}\)/.test(SRC), '去右侧栏看图时自动取消左侧留空');
ok(/\.ac-frame \.ac-tl/.test(cssText) && /sidebarL/.test(SRC) && /toggleDockLeft/.test(SRC) && /data-airp-dock="left"/.test(SRC) && /--airp-dock-left/.test(SRC), '图片框左上角停靠按钮让会话留出空间');
ok(/\.ac-dockgrip/.test(cssText) && /onDockGripDown/.test(SRC) && /setFrame\(\{ dockW:/.test(SRC), '停靠后拖图片框右边框可调宽度');
ok(/var showTL = nearAny/.test(SRC) && /var showTR = nearAny/.test(SRC) && /var showBR = nearAny/.test(SRC) && /var showBL = nearAny/.test(SRC), '靠近任意角落时四个角的气泡一起显示');
ok(/ac-sidenav left/.test(SRC) && /ac-sidenav right/.test(SRC) && /\.ac-frame \.ac-sidenav\{[^}]*opacity:0;[^}]*pointer-events:auto/.test(cssText), '翻页箭头在图片框左右侧，隐藏时也能点');
ok(/window\.addEventListener\(FULL_OPEN_EVENT/.test(SRC) && /pendingFullOpen/.test(SRC) && /sr\.openTab\(TAB_KIND/.test(SRC), '悬浮球和右侧栏通过事件接上全屏');
ok(/\.ac-fullcounter/.test(cssText) && /fullCounterText/.test(SRC) && /fullImages\.length - fullSafeIdx/.test(SRC), '右侧栏全屏顶部显示对应页数');
ok(/fullCounterVisible/.test(SRC) && /className: cls\("ac-fullcounter", fullCounterVisible && "show"\)/.test(SRC) && /1800/.test(SRC), '右侧栏页码也自动消失，不再一直挂着');
ok(/rightViewMemory/.test(SRC) && /restoreRight/.test(SRC) && /rightViewMemory\.list/.test(SRC), '切右侧标签后回来仍在同一张图');
ok(/var lastFrameView = null/.test(SRC) && /openFullImage\(seed \? String\(seed\.id\) : "", seed\)/.test(SRC), '右侧栏无参全屏看图从悬浮框最后一张开始');
ok(/RIGHT_VIEW_KEY/.test(SRC) && /sessionStorage/.test(SRC) && /saveRightViewMemory/.test(SRC), '右侧栏图片记忆刷新页面也不丢');
ok(!/页面在“全屏中”被卸载时/.test(SRC), '切右侧标签不再把右侧图片弹回悬浮框');
ok(/if \(fullImage && wanted\)/.test(SRC) && /if \(!fullListReady\)/.test(SRC) && /fullWantId\.current = wanted/.test(SRC), '右侧全屏重复打开不会把当前页重置成最新');
ok(/if \(wanted && at < 0\)[\s\S]{0,600}items = \[keep\]\.concat\(items\)/.test(SRC), '切换右侧栏时目标图不在列表也不跳回最新');
ok(/var bootPending = pendingFullOpen/.test(SRC) && /bootWantedId/.test(SRC) && /fullAnchorIdRef/.test(SRC), '挂载前点右侧栏看图的目标会压过旧全屏记忆');
ok(/emitFullNav\(wanted, true\)/.test(SRC) && /emitFullNav\(\(baseList\[at\] && baseList\[at\]\.id\) \|\| wanted \|\| "", !!wanted\)/.test(SRC), '打开右侧全屏时暂停当前滚动区间的跟图');
ok(/var targetImg = startImage && startImage\.id/.test(SRC) && /setFullList\(\[targetImg\]\)/.test(SRC) && /reloadFullList\(wanted, targetImg\)/.test(SRC), '悬浮框点右侧栏看图时目标不在当前列表也顶住不跳最新');
ok(/恢复全屏时先告诉悬浮框[\s\S]{0,500}emitFullNav\(id, true\)/.test(SRC), '恢复右侧全屏先停住当前图，不被跟图拉回最新');
ok(/fullOpenedAtRef/.test(SRC) && /Date\.now\(\) - fullOpenedAtRef\.current < 800/.test(SRC), '右侧栏刚打开时短暂忽略悬浮框跟图回流');
ok(/var wanted = String\(fullWantId\.current \|\| fullAnchorIdRef\.current \|\| \(fullItem && fullItem\.id\) \|\| ""\)/.test(SRC), 'tab 会话 id 晚到时仍用锚点图，不回最新');
ok(/var anchorId = String\(fullWantId\.current \|\| fullAnchorIdRef\.current \|\| ""\)/.test(SRC) && /var fullItem = anchorItem \|\| fullImages\[fullSafeIdx\]/.test(SRC), '全屏渲染优先用明确目标图，不等列表刷新');
ok(/fullAnchorIdRef\.current = id;/.test(SRC), '跟图切页时锚点跟着换，全屏不会钉在打开时那张');
ok(/fullAnchorIdRef\.current = target \? String\(target\.id \|\| ""\) : ""/.test(SRC), '删除当前图后锚点挪到邻图，不再显示已删的图');
ok(/String\(fullAnchorIdRef\.current \|\| ""\) === imgId[\s\S]{0,320}fullAnchorIdRef\.current = ""/.test(SRC), '别的窗口删掉锚点图时解除锚点');
ok(/fullAnchorIdRef\.current = "";[\s\S]{0,160}bootWantedImageRef\.current = null;/.test(SRC), '新一组图回最新时连兜底图一起清掉');
ok(/liveJobIdSeen/.test(SRC) && /只有「新任务」才回到最新一张/.test(SRC), '只有新任务才回最新，切标签 / 恢复不重排页码');
ok(/panels\.setRightbar/.test(SRC) && /data-sidebar-right-session/.test(SRC) && /ac-fullview/.test(SRC), '右侧栏全屏滚轮可调侧栏宽度');
ok(/minF = Math\.min\(maxF, minRatio\)/.test(SRC) && !/Math\.min\(maxF, 0\.45\)/.test(SRC), '图片框缩放下限按绝对像素，不会越缩越小');
ok(/\.ac-leftrail\{/.test(cssText) && /data-airp-reserve/.test(SRC) && /toggleReserveLeft/.test(SRC) && /reserveW/.test(SRC), '新增左侧留空测试：图片框仍是普通图片框');
ok(/onRailDown/.test(SRC) && /reserveDrag/.test(SRC) && /setFrame\(\{ reserveW:/.test(SRC) && /\.ac-leftrail\.show \.ac-railline/.test(cssText) && /linear-gradient\(180deg,transparent/.test(cssText), '左侧留空竖线靠近才显示，两头渐变');
ok(/railNear/.test(SRC) && /Math\.abs\(ev\.clientX - r\.x\) <= 16/.test(SRC), '竖线按光标距离显示 / 隐藏');
ok(/\.ac-leftrail\{[^}]*pointer-events:auto/.test(cssText), '左侧留空竖线在悬浮层里能收到鼠标');
ok(/h\(Ico, \{ name: "leftrail"/.test(SRC) && /左侧留空/.test(SRC), '图片框左上角有左侧留空气泡按钮');
ok(/var toggleReserveLeft = function \(\)[\s\S]{0,2800}closeSidePanels\(\)/.test(SRC) && /setTimeout\(doReserve, 280\)/.test(SRC), '打开左侧留空时先收起左右侧栏');
ok(/fitFrameToReserve/.test(SRC) && /rect\.left \+ reserveW - tw/.test(SRC) && /Math\.min\(maxW \/ nw, maxH \/ nh\)/.test(SRC) && /w: tw/.test(SRC) && /h: th/.test(SRC), '留空激活时图片框按原比例放大到最大并靠左');
ok(/if \(reservedActive\) \{[^}]{0,220}return;/.test(SRC) && !/reservedActive\)[\s\S]{0,300}fitFrameToReserve\(dockRect, reserveMax, nw, nh\)/.test(SRC) && /fitFrameToReserve\(rect, max\)/.test(SRC), '悬浮于左侧只在进入时放一次位，翻页 / 新图不再把框拉回初始位置');
ok(/var reserveW = Math\.max\(1, Math\.min\(tw, maxW\)\)/.test(SRC) && /RESERVE_MIN_H/.test(SRC) && /放不下最大图片框/.test(SRC), '留空宽度跟图片框一致，太矮时明确报错');
ok(/if \(dockedActive\) \{ fitAnchorRef\.current = ""; return; \}/.test(SRC) && /\.ac-frame\.reserved \.ac-stage img\{object-fit:contain;\}/.test(cssText) && /reservedActive && "reserved"/.test(SRC), '悬浮于左侧比例对不上时用 contain 整张显示，不裁图也不改框');
ok(/railTop/.test(SRC) && /railHeight/.test(SRC) && /railLineTop/.test(SRC) && /railLineH/.test(SRC) && /ac-railline/.test(cssText), '整段竖线都能拖，白线只跟图片框一样高');
ok(/fullCapture/.test(SRC) && /fullRegenerate/.test(SRC) && /fullDelete/.test(SRC) && /fullRefresh/.test(SRC) && /fullToggleAuto/.test(SRC), '右侧栏全屏左下菜单动作和悬浮窗一致');
ok(/aria-disabled": fullSafeIdx >= fullImages\.length - 1/.test(SRC) && /is-disabled/.test(SRC), '翻页到边界时箭头仍保留可点击区域，不会触发双击关闭');
ok(/deleteDisabled: !fullItem/.test(SRC) && /favorited: !!\(fullItem/.test(SRC), '右侧栏全屏删除禁用 / 收藏状态接上');
ok(/bubble\("capture", "请求生成".*title: "发送正文，生成图片"/.test(SRC) && /bubble\("regen", "重新生成".*仅此图 \/ 本轮全部/.test(SRC), '请求生成 / 重新生成气泡说明已改');
ok(/ac-regenbox/.test(SRC) && /仅此图/.test(SRC) && /本轮全部图片一起替换/.test(SRC), '重新生成展开仅此图 / 全部两个选项和共用文本框');
ok(/disabled: false,[\s\S]{0,120}dockLeftFromFull/.test(SRC), '没有图片也允许把空图框停靠左侧');
ok(/title: "右侧栏看图",[\s\S]{0,160}disabled: false,[\s\S]{0,100}openSidebarFull/.test(SRC), '没有图片时右上角右侧栏看图也可点');
ok(/title: docked \? "取消固定于左侧" : "固定于左侧（会话让位）"/.test(SRC) && /title: reserved \? "取消悬浮于左侧" : "悬浮于左侧（只挪会话，不动图片框）"/.test(SRC), '左上角两个按钮改成固定于左侧 / 悬浮于左侧');
ok(!/停靠左侧（会话让位）|左侧留空（测试）/.test(SRC), '旧的停靠 / 留空说明已替换');
ok(/opts\.strike/.test(SRC) && /strike: !props\.autoOn/.test(SRC) && /\.ac-bubble \.ac-strike\{/.test(cssText), 'A 关闭状态用删除线，不再换成 M');
ok(/followOn: floatPrefs\.follow !== false/.test(SRC) && /onTogglePointer: fullTogglePointerFollow/.test(SRC) && /onToggleDebug: fullToggleDebug/.test(SRC), '右侧栏全屏菜单也带跟随 / 光标 / 调试，三处同步');
ok(/out\.open = out\.open !== false/.test(SRC) && /out\.debug = out\.debug === true/.test(SRC), '首次安装默认展开图片框、跟图调试默认关');
ok(/PREFS_EVENT/.test(SRC) && /announceFloatPrefs/.test(SRC) && /UI_CONFIG_EVENT/.test(SRC) && /announceUiConfig/.test(SRC), '跟随 / 自动 / 连图开关通过事件跨菜单同步');
ok(/hasImage: !!img/.test(SRC) && /hasImage: !!fullItem/.test(SRC) && /disabled: !props\.hasImage/.test(SRC), '无图时只禁用真正依赖图片的选项');
ok(/isNearlyBlack/.test(SRC) && /0\.99/.test(SRC) && /mode: "auto"/.test(SRC) && /BLACK_MAX_RETRIES/.test(SRC) && /blackCheckedJobsRef/.test(SRC) && /继续第/.test(SRC), '纯黑图检测 + 最多 3 次自动重生成已接上');
ok(/checkBlackImages\(list\[i\]\)/.test(SRC) && /jobsSig/.test(SRC), '黑图检查覆盖所有已完成任务，不只最新一条');
ok(/bubble\("refresh", "刷新", .*icon: "refresh", title: "刷新"/.test(SRC), '刷新显示图标 + 名字');
ok(/data\.images\.slice\(\)\.reverse\(\)/.test(SRC) && /\(safeIdx \+ 1\) \+ "\/" \+ imgs\.length/.test(SRC), '图片顺序改成旧→新，第一张是 1/xx、最新是最后一张');
ok(/\[prefs\.open, safeIdx, imgs\.length, viewTick\]/.test(SRC), '切图时显示页码');
ok(/ac-frameloading/.test(cssText) && /加载中…/.test(SRC) && /switching/.test(SRC), '翻页时显示加载中，删除按钮变灰');
ok(/\.ac-frametoaststack\{[^}]*left:11px;[^}]*top:52px/.test(cssText), '悬浮窗日志下移，不挡停靠按钮');
ok(/var \[nearBR/.test(SRC) && /var showBR = nearAny \|\| nearBR/.test(SRC) && /setNearBR\(true\)/.test(SRC), '展开后右下角收起按钮立即出现');
ok(/\.ac-frame\.docked\{[^}]*border-radius:0;[^}]*border-right:1px solid/.test(cssText), '停靠后直角并保留右侧边框线');
ok(/undock: true/.test(SRC) && /d\.undocked/.test(SRC) && /setPref\(\{ dock: "" \}\)/.test(SRC), '停靠时拖动超过阈值后变回图片框');
ok(/ox: drawX, oy: drawY, w: fw, h: fh, moved: false, undock: true/.test(SRC), '拖动脱开停靠时不会把停靠区宽高写回图片框');
ok(/if \(reserved\) restoreReserveFrame\(\)/.test(SRC), '从左侧留空切回停靠时还原留空前的尺寸');
ok(/fullSide/.test(SRC) && /setFullSide/.test(SRC) && /fullSide === "left"/.test(SRC) && /fullSide === "right"/.test(SRC), '右侧栏图片左右箭头靠近显示');
ok(/COLLAPSE_EVENT/.test(SRC) && /collapseFullToBall/.test(SRC) && /onDoubleClick[\s\S]{0,160}collapseFullToBall/.test(SRC), '右侧栏图片双击收回悬浮球');
ok(/DOCK_LEFT_EVENT/.test(SRC) && /dockLeftFromFull/.test(SRC) && /fullTLNear/.test(SRC) && /\.ac-fullview \.ac-tl/.test(cssText), '右侧栏全屏左上角也有固定于左侧按钮');
ok(/RESERVE_LEFT_EVENT/.test(SRC) && /reserveLeftFromFull/.test(SRC) && /handleReserveLeftRequest/.test(SRC) && /h\(Ico, \{ name: "leftrail"/.test(SRC), '右侧栏全屏左上角也有悬浮于左侧按钮');
ok(/手动「请求生成」不受自动出图开关影响/.test(SRC), '自动出图关闭时手动请求生成仍会出图');
ok(/var local = localSessionRef\.current \|\| \{\};[\s\S]{0,420}api\.generate\(\{ sets: job\.sets/.test(SRC), '悬浮球出图归属本会话，不被全局 active 抢走');
ok(/SESSION_EVENT/.test(SRC) && /addEventListener\(SESSION_EVENT/.test(SRC) && /dataSig\.current = ""/.test(SRC), '切换会话时主动重置图片框并强制刷新');
ok(/loadSeq/.test(SRC) && /refreshSeq/.test(SRC) && /loadSeq\.current !== seq/.test(SRC), '并发刷新只让最后一次响应落地');
ok(/AbortController/.test(SRC) && /20000/.test(SRC) && /12000/.test(SRC), '状态请求和右侧大图都有超时兜底');
ok(!/最近出图/.test(SRC), '概览不再有最近出图');
ok(/setData\(null\)[\s\S]{0,80}load\(1\)/.test(SRC) && /imgRetry/.test(SRC) && /\?r=/.test(SRC), '打开图库强制刷新，裂图自动重试');
ok(/ac-globaltoaststack/.test(SRC) && /noticeJob/.test(SRC) && /出图完成/.test(SRC), '右下角有收到提示词 / 出图完成的全局消息');
ok(/job\.regenMode !== "auto"/.test(SRC) && /黑图已替换为正常图[\s\S]{0,260}notify\("出图完成"/.test(SRC), '黑图自动替换先替换再报出图完成，不让完成提示抢在前面');
ok(/window\.addEventListener\("wheel", onWheel/.test(SRC), '图片框滚轮监听在 window，切会话不会丢');
ok(/data-conversation-scroll/.test(SRC) && /data-conversation-scroll\]\[data-airp-dock/.test(cssText), '兼容旧版 DSH-Tavern 的会话滚动容器');
ok(/ownerSessionId/.test(SRC) && /ownerSessionId/.test(fs.readFileSync(path.join(ROOT, 'lib', 'jobs.js'), 'utf8')), '图片按 ownerSessionId 归当前聊天');
ok(/var size = 9;/.test(SRC) && /ac-gallery/.test(SRC) && /打开位置/.test(SRC), '图库每页 9 张、三列、顶部翻页和打开位置');
ok(/openRecycle/.test(SRC) && /打开回收站位置/.test(SRC) && /scope: "recycle"/.test(SRC), '图库打开位置旁边有打开回收站位置');
ok(/syncGallery/.test(SRC) && /api\.syncFavorites/.test(SRC) && /收藏同步完成/.test(SRC) && !/fav \? null : h\(Btn/.test(SRC), '收藏夹也有同步按钮，且走收藏同步接口');
ok(/pendingDelete/.test(SRC) && /setPendingDelete/.test(SRC) && /shownItems = items\.filter/.test(SRC), '图库删除后先拿掉卡片，不留下黑图');
ok(/删除成功后文件已经进回收站，继续停留只会看到黑图/.test(SRC), '大图查看器删除后自动关闭');
ok(/page=1&size=200/.test(SRC) && /ac-full-loading/.test(SRC), '全屏按需取图片清单并显示载入状态');
ok(/openFolder/.test(SRC) && /open-folder/.test(fs.readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8')), '打开图片目录走后端接口');
ok(/chatFolderName\(ownerSessionId, ownerSessionTitle\)/.test(fs.readFileSync(path.join(ROOT, 'lib', 'jobs.js'), 'utf8')), '图片目录使用会话名');
const ball = registrations.find((r) => r.options.name === 'shell.overlay');
try {
  sandbox.localStorage.setItem('airp-comfy:float-hidden:v1', '1');
  const hiddenEl = ball.component({});
  ok(hiddenEl === null, '隐藏悬浮球后 FloatBall 不渲染');
  sandbox.localStorage.removeItem('airp-comfy:float-hidden:v1');
  const el = ball.component({});
  ok(!!el, 'FloatBall 渲染出元素');
  ok(el.props && el.props.className === 'ac-ballroot', '悬浮球根节点是 ac-ballroot');
  const defaultFrame = (el.children || []).find((c) => c && c.props && /ac-frame/.test(c.props.className || ''));
  ok(!!defaultFrame, '首次安装默认展开图片框');
  ok(!!defaultFrame && !/\bsquare\b/.test(defaultFrame.props.className || ''), '首次安装默认圆角');
  sandbox.localStorage.setItem('airp-comfy:float:v3', JSON.stringify({ open: false }));
  const ballEl = (ball.component({}).children || []).find((c) => c && c.props && c.props.className === 'ac-ball');
  ok(ballEl && ballEl.props && ballEl.props.className === 'ac-ball', '收起后显示圆角悬浮球');
  ok(!(ballEl.children || []).some((c) => c && c.props && c.props.className === 'bdot'), '悬浮球不再显示绿色状态点');
  ok((ballEl.children || []).some((c) => c && c.type === T.PaletteGlyph), '悬浮球使用概览同款图标');
  ok(typeof ballEl.props.onPointerDown === 'function', '悬浮球本体保留拖动，缩放只走滚轮');
  sandbox.localStorage.setItem('airp-comfy:float:v3', JSON.stringify({
    open: true, dock: 'left', frame: { emptyW: 420, emptyH: 600 },
  }));
  const openEl = ball.component({});
  const frameEl = (openEl.children || []).find((c) => c && c.props && /ac-frame/.test(c.props.className || ''));
  ok(!!frameEl, '打开图片框时能渲染出 ac-frame');
  const tl = frameEl && (frameEl.children || []).find((c) => c && c.props && /ac-tl/.test(c.props.className || ''));
  const tlBtn = tl && (tl.children || [])[0];
  ok(!!tlBtn && /ac-round ac-glass on/.test(tlBtn.props.className || ''), '停靠状态左上角按钮高亮');
  sandbox.localStorage.removeItem('airp-comfy:float:v3');
} catch (e) {
  ok(false, 'FloatBall 渲染不炸', e.message);
}
try {
  const noop = () => {};
  const tools = T.FrameTools({
    show: true, live: false, hasJob: true, autoOn: true, contOn: false,
    menuOpen: true, subOpen: true, menuClipped: false, subPos: { left: 4, bottom: 40 },
    blRef: { current: null }, menuRef: { current: null }, moreRef: { current: null },
    onToggleMenu: noop, onToggleSub: noop, onCapture: noop, onRegenerate: noop, onStop: noop,
    onContinuous: noop, onAuto: noop, onDelete: noop, onDownload: noop, onFav: noop, onRefresh: noop,
    deleteDisabled: false, deleteTitle: '删除', downloadDisabled: false, favDisabled: false, favorited: true,
  });
  ok(tools && tools.props.className === 'ac-bl show', '悬浮窗 / 全屏共用菜单能渲染');
  const kids = tools.children || [];
  ok(!kids.some((c) => c && c.props && c.props.className === 'ac-navcol'), '共用菜单不再含上下翻页');
  ok(/imgs.length > 1/.test(SRC) && /ac-sidenav left/.test(SRC) && /ac-sidenav right/.test(SRC), '翻页改成图片框左右侧箭头');
  const menu = kids.find((c) => c && c.props && c.props.className === 'ac-bubblemenu');
  const labels = (menu ? menu.children : []).map((c) => c && c.children && c.children[1]).filter((x) => typeof x === 'string' && x);
  ok(labels.join(',') === '请求生成,重新生成,连图·关,A', '共用菜单文案和顺序和悬浮窗一致', labels.join(','));
  const offTools = T.FrameTools({
    show: true, live: false, hasJob: true, autoOn: false, contOn: false,
    menuOpen: true, subOpen: false,
    onToggleMenu: noop, onToggleSub: noop, onCapture: noop, onStop: noop,
    onContinuous: noop, onAuto: noop, onDelete: noop, onDownload: noop, onFav: noop, onRefresh: noop,
    deleteDisabled: false, downloadDisabled: false, favDisabled: false, favorited: false,
  });
  const offMenu = (offTools.children || []).find((c) => c && c.props && c.props.className === 'ac-bubblemenu');
  const autoBtn = (offMenu ? offMenu.children : []).find((c) => c && c.props && /^A（划掉）/.test(String(c.props.title || '')));
  const strike = autoBtn && (autoBtn.children || []).find((c) => c && c.props && c.props.className === 'ac-strike');
  ok(!!strike && textOf(strike) === 'A', 'A 关闭状态显示划掉的 A，不再显示 M');
  ok(!/\bM\b/.test(labels.join(',')), '菜单里不再出现 M 状态');
  const sub = kids.find((c) => c && c.props && c.props.className === 'ac-bubble-sub');
  ok(sub && (sub.children || []).filter(Boolean).length === 4, '共用菜单更多里有下载 / 收藏 / 刷新 / 圆角切换（没有跟随开关时不占位）');
  const regenTools = T.FrameTools({
    show: true, live: false, hasJob: true, hasImage: true, autoOn: true, contOn: false,
    menuOpen: true, regenOpen: true, regenText: '',
    onToggleMenu: noop, onToggleSub: noop, onCapture: noop, onToggleRegen: noop,
    onRegenText: noop, onRegenSingle: noop, onRegenAll: noop, onStop: noop,
    onContinuous: noop, onAuto: noop, onDelete: noop, onDownload: noop, onFav: noop, onRefresh: noop,
    deleteDisabled: false, downloadDisabled: false, favDisabled: false, favorited: false,
  });
  const regenBox = (regenTools.children || []).find((c) => c && c.props && c.props.className === 'ac-regenbox');
  ok(!!regenBox && textOf(regenBox).includes('仅此图') && textOf(regenBox).includes('全部'), '重新生成面板有仅此图 / 全部两个入口');
  ok(!!regenBox && (regenBox.children || []).some((c) => c && c.type === 'textarea' || (c && c.props && c.props.placeholder && String(c.props.placeholder).includes('可选要求'))), '重新生成面板有一个共用文本框');
  ok(/bubble\("square"/.test(SRC) && /onToggleSquare/.test(SRC) && /\.ac-frame\.square\{/.test(cssText), '三级菜单可切换圆角 / 直角');
  const followTools = T.FrameTools({
    show: true, live: false, hasJob: true, autoOn: true, contOn: false,
    menuOpen: true, subOpen: true, followOn: true, onToggleFollow: noop,
    pointerFollow: true, onTogglePointer: noop,
    debug: true, onToggleDebug: noop,
    onClearAnchors: noop,
    deleteDisabled: false, downloadDisabled: false, favDisabled: false, favorited: false,
    onToggleMenu: noop, onToggleSub: noop, onCapture: noop, onRegenerate: noop, onStop: noop,
    onContinuous: noop, onAuto: noop, onDelete: noop, onDownload: noop, onFav: noop, onRefresh: noop,
    onToggleSquare: noop,
  });
  const followSub = (followTools.children || []).find((c) => c && c.props && c.props.className === 'ac-bubble-sub');
  const followSubKids = (followSub ? followSub.children : []).filter(Boolean);
  const followSubLabels = followSubKids.map((c) => c && c.children && c.children[1]).filter((x) => typeof x === 'string');
  ok(followSubKids.length === 8 && followSubLabels.join(',') === '收藏,下载,滚动切图,光标切图,切图调试,清空定位,刷新,切直角', '悬浮窗更多里每一项都有图标 + 名字');
  ok(/bubble\("clearanchors", "清空定位".*icon: "bars"/.test(SRC), '清空定位用三杠图标');
  ok(/FULL_NAV_EVENT/.test(SRC) && /FULL_FOLLOW_EVENT/.test(SRC) && /FULL_STATE_EVENT/.test(SRC) && /emitFullNav/.test(SRC), '右侧栏全屏与悬浮框的切图 / 调试状态双向同步');
  ok(/ac-debug-only/.test(cssText) && /dock === false/.test(SRC) && /detail: \{ dock: false \}/.test(SRC), '全屏打开时清掉左侧停靠 / 留空，调试层在隐藏时仍显示');
  ok(/closeSidePanels/.test(SRC) && /toggleSidebar/.test(SRC) && /sr\.toggleExpanded/.test(SRC), '停靠前先关闭左右侧栏');
ok(!/已停靠左侧|已取消左侧停靠|已取消停靠/.test(SRC), '停靠 / 取消停靠的提示消息已删除');
ok(/collapse\(e\.clientX, e\.clientY\)/.test(SRC) && /collapseFullToBall\(e\)/.test(SRC) && /detail\.x/.test(SRC), '双击关闭时悬浮球回到光标位置');
  ok(/clamp\(ball\.x, 0, size\.w - BALL\)/.test(SRC) && /clamp\(frame\.x, 0,/.test(SRC), '图片框和悬浮球可以贴到界面边界');
  ok(/var showTR = nearAny \|\| peek;/.test(SRC), '没图时右上角按钮也显示（禁用状态）');
} catch (e) {
  ok(false, 'FrameTools 渲染不炸', e.message);
}
const dock = registrations.find((r) => r.options.name === 'conversation.input.dock');
try {
  const el = dock.component({ sessionId: 'session-abc' });
  ok(el === null, 'SessionReporter 渲染 null（隐形）');
} catch (e) {
  ok(false, 'SessionReporter 不炸', e.message);
}
const glyph = T.PaletteGlyph ? T.PaletteGlyph({}) : null;
ok(glyph && glyph.type === 'svg', 'ComfyRP 图标是 svg');
const tabTitle = T.TabTitle ? T.TabTitle({}) : null;
ok(tabTitle && tabTitle.props && tabTitle.props.className === 'ac-tabtitle', '标签标题渲染 ComfyRP + 状态点');

section('各页面首屏渲染');
const noop = () => {};
const apiStub = new Proxy({}, { get: () => () => Promise.resolve({ ok: true, jobs: [], images: [], sessions: [], workflows: [] }) });
const job = {
  id: 'job_1', source: 'capture', status: 'done', text: '正文', textPreview: '正文',
  sourceSessionId: 's1', sourceSessionTitle: '正文会话', sourceSeq: 1,
  targetSessionId: 't1', targetMode: 'local', replyText: '', replyPreview: '①标题\nsize: 832x1216', replyChars: 20,
  deliveryMs: 100, sawOwnPrompt: true, interrupted: false, ruleId: 'contract_v2', issues: [], parseWarn: '',
  sets: [{ title: '①标题', size: { w: 832, h: 1216 }, positive: '1girl, solo, white dress', negative: '', tags: '', nl: '' }],
  positive: '1girl, solo, white dress', negative: '', imageCount: 1, expectCount: 1, warn: '',
  continuous: false, continuousInfo: null, workflowId: 'wf1', workflowName: '测试工作流',
  images: [{ id: 'img1', url: '/__airp_comfy/img/img1', fileName: 'a.png', bytes: 10, title: '①标题', setIndex: 0, seed: 1, favorited: false, recycled: false }],
  comfyPromptId: 'p1', comfyMs: 100, totalMs: 200, overrideReport: null, error: null, failedStage: '', errorCode: null,
  autoGenerate: true, cancellable: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
};
const fakeState = {
  ok: true, version: '0.2.1', routePath: '/__airp_comfy',
  config: {
    comfy: { baseUrl: 'http://127.0.0.1:8188', timeoutMs: 300000, pollIntervalMs: 1200 },
    capture: { autoForward: true, autoGenerate: true, timeoutMs: 300000, maxSets: 3, maxImages: 3, matchRule: 'contract_v2', minChars: 8, ignoreTargetSession: true, extraMessage: '', extraPosition: 'top' },
    source: { mode: 'local', sessionId: 's1', title: '正文会话', baseUrl: '', routePath: '/__airp_comfy', hasToken: false },
    target: { mode: 'local', sessionId: 't1', title: '桥会话', baseUrl: '', routePath: '/__airp_comfy', hasToken: false },
    generation: { imageCount: 1, countNotSet: false, continuous: { on: false, lora: '', strengths: [null, null, null] } },
    workflowId: 'wf1', ui: { ball: { x: null, y: null, open: false, w: 420, h: null, pinned: true } },
    paths: { dataDir: '', outputDir: '' },
  },
  workflows: [{ id: 'wf1', name: '测试工作流', size: { w: 832, h: 1216 }, sizeMode: 'dsh', nodeCount: 5, outputs: 1, hasLora: false, active: true }],
  activeWorkflowId: 'wf1',
  activeWorkflow: { id: 'wf1', name: '测试工作流', size: { w: 832, h: 1216 }, sizeMode: 'dsh', randomSeed: true, nodeCount: 5 },
  jobs: [job], images: job.images, imagesTotal: 1, imagesGhost: 0, favoritesTotal: 0, recycleTotal: 0,
  rules: [{ id: 'contract_v2', label: '契约 v2', description: '标题 + size + text 块' }],
  logs: [{ at: new Date().toISOString(), level: 'info', message: '测试日志' }],
  activeSessionId: 's1', activeSessionTitle: '正文会话',
  runtime: { dataDir: 'D:\\data', outputDir: 'D:\\data\\output', recycleDir: 'D:\\data\\output\\_recycle', favoriteDir: 'D:\\data\\output\\_favorites', lastSaveError: '', clients: 1 },
  capture: {
    source: { mode: 'local', sessionId: 's1', title: '正文会话', baseUrl: '', routePath: '/__airp_comfy', hasToken: false },
    target: { mode: 'local', sessionId: 't1', title: '桥会话', baseUrl: '', routePath: '/__airp_comfy', hasToken: false },
    autoForward: true, autoGenerate: true,
  },
};
function renderPage(name, Comp, props) {
  try {
    const el = Comp(props);
    ok(!!el, `${name} 渲染出元素`);
    return el;
  } catch (e) {
    ok(false, `${name} 渲染不炸`, `${e.message}\n${String(e.stack || '').split('\n').slice(1, 3).join('\n')}`);
    return null;
  }
}
function collect(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (Array.isArray(node.children)) node.children.forEach((n) => collect(n, out));
  ['title', 'label', 'actions'].forEach((key) => {
    const value = node.props?.[key];
    if (value && typeof value === 'object') collect(value, out);
  });
  return out;
}
function textOf(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  const props = node.props || {};
  const own = ['title', 'label', 'placeholder']
    .map((key) => (typeof props[key] === 'string' ? props[key] : ''))
    .join('');
  const nested = ['title', 'label', 'actions']
    .map((key) => (props[key] && typeof props[key] === 'object' ? textOf(props[key]) : ''))
    .join('');
  return own + nested + (node.children || []).map(textOf).join('');
}
function byClass(node, name) {
  return collect(node).filter((n) => String(n.props?.className || '').split(/\s+/).includes(name));
}
renderPage('DashboardPage', T.DashboardPage, { state: fakeState, jobs: [job], images: job.images, liveJob: job, api: apiStub, refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), setPage: noop, onView: noop });
renderPage('WorkbenchPage', T.WorkbenchPage, { state: fakeState, jobs: [job], images: job.images, liveJob: job, api: apiStub, refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop });
{
  const deletedJob = Object.assign({}, job, {
    images: [Object.assign({}, job.images[0], { id: 'img-deleted', recycled: true, deletedAt: new Date().toISOString() })],
  });
  const wbDeleted = T.WorkbenchPage({ state: fakeState, jobs: [deletedJob], images: deletedJob.images, liveJob: deletedJob, api: apiStub, refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop });
  const deletedThumb = byClass(wbDeleted, 'deleted')[0];
  ok(!!deletedThumb && textOf(deletedThumb).includes('已删除'), '工作台本次出图里已删除的图片显示灰色占位');
}
renderPage('WorkflowsPage', T.WorkflowsPage, { state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve() });
const wfData = { id: 'wf1', name: '测试工作流', json: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } } }, mapping: { '6': 'positive' }, outputNodes: ['9'], tokenEmpty: 'blank', size: { w: 832, h: 1216 }, sizeMode: 'dsh', randomSeed: true, pruneOutputs: true, onlyFirst: false, loraState: null };
const scanData = {
  nodeCount: 5,
  nodes: [
    { id: '6', classType: 'CLIPTextEncode', title: '正面', mode: 'token', tokenName: '%prompt%', kind: 'token', label: '占位符%prompt%', hint: '建议映射为正面提示词', tone: 'ok', suggestRole: 'positive' },
    { id: '5', classType: 'EmptyLatentImage', title: '尺寸', mode: 'size', kind: 'size', label: '分辨率', hint: '建议映射为分辨率', tone: 'acc', suggestRole: 'size' },
    { id: '7', classType: 'CLIPTextEncode', title: '负面', mode: 'token', tokenName: '%negative_prompt%', kind: 'token', label: '占位符%negative_prompt%', hint: '建议映射为负面提示词', tone: 'ok', suggestRole: 'negative' },
    { id: '12', classType: 'LoraLoader', title: 'LoRA 堆', mode: 'lora', kind: 'loraStack', label: 'lora堆', hint: '建议保留原内容', tone: 'warn', loraCount: 2 },
    { id: '13', classType: 'LoraLoader', title: '单 LoRA', mode: 'lora', kind: 'lora', label: 'lora', hint: '建议保留原内容', tone: 'warn' },
    { id: '22', classType: 'StringNode', title: '工具', mode: 'whole', kind: 'unknown', label: '未知', hint: '插件未能识别，请自行判断映射与否，映射会将整段原有内容替换', tone: null },
  ],
  tokens: { positive: 1, negative: 1, width: 1, height: 1 },
  outputs: [{ id: '9', classType: 'SaveImage', title: '保存', isPreview: false }],
  defaultOutputIds: ['9'],
  suggestedKeep: { id: '9' },
};
const wfPage = renderPage('WorkflowsPage(data)', T.WorkflowsPage, { state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve(), initialWorkflow: wfData, initialScan: scanData, initialJsonOpen: true });
const wfBoxes = collect(wfPage).filter((n) => n.props && n.props.type === 'checkbox');
ok(wfBoxes.length === 1 && wfBoxes[0].props.checked === true, '已保存的输出节点显示为勾选');
const wfText = textOf(wfPage);
ok(wfText.includes('占位符%prompt%') && wfText.includes('#6'), '只列出占位符节点本身，不再显示建议映射说明');
ok(!wfText.includes('工具') && !wfText.includes('未知'), '未知 / 工具节点不再展示给用户');
ok(wfText.includes('可映射节点') && wfText.includes('固定 3 项'), '可映射节点固定三行');
ok(wfText.includes('分辨率') && wfText.includes('正面提示词') && wfText.includes('负面提示词'), '三行分别是分辨率 / 正面 / 负面');
ok(!wfText.includes('LoRA 堆') && !wfText.includes('单 LoRA'), 'LoRA 堆和单 LoRA 节点不再显示');
ok(wfText.includes('图片输出相关') && wfText.includes('输出节点') && wfText.includes('额外设置'), '输出节点 / 额外设置子标题');
ok(!wfText.includes('兜底只返回第一张'), '删掉兜底只返回第一张开关');
ok(wfText.includes('%prompt%') && wfText.includes('%negative_prompt%') && wfText.includes('%width%') && wfText.includes('%height%'), '占位符区一起列出正负面和宽高');
const noScanPage = renderPage('WorkflowsPage(placeholders always)', T.WorkflowsPage, {
  state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve(),
  initialWorkflow: wfData, initialScan: null, initialJsonOpen: true,
});
const noScanText = textOf(noScanPage);
ok(noScanText.includes('%prompt%') && noScanText.includes('%negative_prompt%') && noScanText.includes('%width%') && noScanText.includes('%height%'), '没有扫描结果时占位符气泡和复制提示仍常驻');
eq(byClass(noScanPage, 'ac-maprow').length, 3, '没有扫描结果时仍显示固定三行（未检测到）');
const mapSelects = collect(wfPage).filter((n) => n.type && n.type.name === 'Select' && String(n.props?.className || '').includes('ac-mapselect'));
const mapValues = mapSelects.map((n) => n.props && n.props.value);
ok(mapValues.includes('positive') && mapValues.includes('size') && !mapValues.includes('negative'), '默认自动选正面 / 分辨率，负面默认保留原内容');
ok(mapSelects.some((n) => textOf(n).includes('保留原内容')), '可映射节点下拉用「保留原内容」而不是「忽略」');
eq(byClass(wfPage, 'ac-maprow').length, 3, '固定显示三个节点条目');
const scanMissing = Object.assign({}, scanData, {
  nodes: scanData.nodes.filter((n) => n.id === '6'),
});
const missingPage = renderPage('WorkflowsPage(missing roles)', T.WorkflowsPage, {
  state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve(),
  initialWorkflow: wfData, initialScan: scanMissing, initialJsonOpen: true,
});
eq(byClass(missingPage, 'ac-maprow').length, 3, '未检测到的角色仍保留三行');
ok(textOf(missingPage).includes('未检测到'), '未检测到的角色显示未检测到');
ok(wfText.includes('默认只勾一个 SaveImage 节点'), '输出节点小字说明默认只勾一个');
const scanTwo = Object.assign({}, scanData, {
  outputs: scanData.outputs.concat([{ id: '10', classType: 'PreviewImage', title: '预览', isPreview: true }]),
});
const emptyOutputWf = Object.assign({}, wfData, { outputNodes: [] });
const emptyOutputPage = renderPage('WorkflowsPage(default outputs)', T.WorkflowsPage, { state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve(), initialWorkflow: emptyOutputWf, initialScan: scanTwo, initialJsonOpen: true });
const emptyBoxes = collect(emptyOutputPage).filter((n) => n.props && n.props.type === 'checkbox');
ok(emptyBoxes.length === 2 && emptyBoxes[0].props.checked === true && emptyBoxes[1].props.checked === false, '输出节点默认只勾一个 SaveImage，不勾预览');
const connPage = renderPage('ConnectionsPage', T.ConnectionsPage, { state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve() });
const sourceCard = collect(connPage).find((n) => n.props && n.props.title === '正文来源');
ok(!!sourceCard && textOf(sourceCard).includes('本会话'), '正文来源有「本会话」勾选项');
const sourceFollow = collect(sourceCard).find((n) => n.type && n.type.name === 'Switch' && textOf(n).includes('本会话'));
ok(!!sourceFollow && sourceFollow.props.checked === true, '「本会话」默认勾选');
const sourceSelects = collect(sourceCard).filter((n) => n.type && n.type.name === 'Select');
ok(sourceSelects.length >= 2 && sourceSelects.every((n) => n.props.disabled === true), '勾选本会话后模式 / 会话下拉禁用');
ok(/savedOnly/.test(SRC) && /已保存/.test(SRC) && /conf\.sessionId && !options\.some/.test(SRC), '刷新后会先把已保存的会话补进下拉，不显示成未选择');
ok(/api\.setActive\(sid, title\)\.then\(function \(r\)/.test(SRC) && /r && r\.title/.test(SRC), '会话上报回填后端补查到的标题');
ok(/addEventListener\(SESSION_EVENT, onSession\)/.test(SRC) && /reload\(false\)/.test(SRC), '设置页在会话切换时自动刷新会话列表');
ok(!/\n\s+h\(Field, \{ label: "口令"/.test(SRC) && /远程口令输入暂时隐藏/.test(SRC), '远程口令输入暂时隐藏');
ok(/api\.refreshSessions\(\{\}\)/.test(SRC) && /已刷新未归档会话/.test(SRC) && /setBusy\(true\)/.test(SRC), '设置页「刷新」真正重读未归档会话和名称');
ok(/disabled: busy,/.test(SRC) && /busy \? "读取中…" : "刷新"/.test(SRC) && /已刷新未归档会话/.test(SRC), '设置页刷新按钮有读取中状态，本会话模式下也可刷新');
const sourceBtns = collect(sourceCard).filter((n) => n.type && n.type.name === 'Btn');
ok(sourceBtns.length >= 2 && sourceBtns[0]?.props?.disabled !== true && sourceBtns[1]?.props?.disabled === true, '勾选本会话后刷新仍可用，测试按钮禁用');
const sourceOffState = Object.assign({}, fakeState, {
  config: Object.assign({}, fakeState.config, {
    source: Object.assign({}, fakeState.config.source, { followActive: false }),
  }),
});
const sourceOffPage = renderPage('ConnectionsPage(source off)', T.ConnectionsPage, { state: sourceOffState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve() });
const sourceOffCard = collect(sourceOffPage).find((n) => n.props && n.props.title === '正文来源');
const sourceOffSelects = collect(sourceOffCard).filter((n) => n.type && n.type.name === 'Select');
const sourceOffBtns = collect(sourceOffCard).filter((n) => n.type && n.type.name === 'Btn');
ok(sourceOffSelects.length >= 2 && sourceOffSelects.every((n) => !n.props.disabled), '取消本会话后模式 / 会话下拉启用');
ok(sourceOffBtns.length >= 2 && sourceOffBtns.every((n) => !n.props.disabled), '取消本会话后刷新 / 测试按钮启用');
ok(/updateParty\("source", \{ followActive: e\.target\.checked \}, "正文来源已保存", 0\)/.test(SRC), '本会话勾选后即时自动保存');
const customState = Object.assign({}, fakeState, {
  config: Object.assign({}, fakeState.config, {
    capture: Object.assign({}, fakeState.config.capture, {
      matchRule: 'custom_tags',
      customTags: { title: '</标题>', size: '</尺寸>', positive: '</正面>', negative: '</负面>' },
    }),
  }),
});
renderPage('ConnectionsPage(custom)', T.ConnectionsPage, { state: customState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve() });
const allState = Object.assign({}, fakeState, {
  config: Object.assign({}, fakeState.config, {
    capture: Object.assign({}, fakeState.config.capture, { matchRule: 'all_text' }),
  }),
});
renderPage('ConnectionsPage(all_text)', T.ConnectionsPage, { state: allState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve() });
renderPage('LogsPage', T.LogsPage, { state: fakeState, jobs: [job], logs: fakeState.logs, api: apiStub, toast: noop, refresh: noop, setSelectedJob: noop });
const imgPage = renderPage('ImagesPage(images)', T.ImagesPage, { state: fakeState, api: apiStub, toast: noop, onView: noop, mode: 'images' });
const imgTabs = byClass(imgPage, 'ac-subtab');
const activeImgTab = imgTabs.find((n) => /\bon\b/.test(String(n.props?.className || '')));
ok(activeImgTab && textOf(activeImgTab) === '当前会话', '图库默认打开当前会话，而不是全部');
renderPage('ImagesPage(favorites)', T.ImagesPage, { state: fakeState, api: apiStub, toast: noop, onView: noop, mode: 'favorites' });
renderPage('Lightbox', T.Lightbox, { item: job.images[0], api: apiStub, toast: noop, onClose: noop });
const loraData = {
  state: { effectiveSource: 'record' },
  catalog: { count: 20, source: 'LoraManager' },
  stacks: [{
    nodeId: '12', title: 'LoRA 堆', classType: 'LoraLoader', kind: 'manager', group: 'stack', order: 0, active: true,
    entries: [{
      name: 'style.safetensors', label: '风格 LoRA', labelDefault: '风格 LoRA', labelCustom: false,
      active: true, strength: 0.8, clipStrength: 0.8, words: ['watercolor', 'soft light'], wordsOff: ['soft light'],
    }],
  }, {
    nodeId: '13', title: '单 LoRA', classType: 'LoraLoaderModelOnly', kind: 'single', group: 'loose', order: 1, active: true,
    entries: [{
      name: 'turbo.safetensors', label: '加速 LoRA', labelDefault: '加速 LoRA', labelCustom: false,
      active: true, strength: 1, clipStrength: 1, words: [], wordsOff: [],
    }],
  }],
};
renderPage('LoraPage', T.LoraPage, { state: fakeState, api: apiStub, toast: noop, refresh: noop });
const loraPage = renderPage('LoraPage(data)', T.LoraPage, { state: fakeState, api: apiStub, toast: noop, refresh: noop, initialWorkflowId: 'wf1', initialData: loraData });
{
  const loraCard = collect(loraPage).find((n) => n.props && n.props.title === 'LoRA');
  const sub = loraCard?.props?.subtitle || null;
  ok(!!sub, 'LoRA 卡片用 subtitle 承载状态气泡');
  ok(!!sub && textOf(sub).includes('按工作流原样') && textOf(sub).includes('LoRA 目录'), '副行同时显示按工作流原样和 LoRA 计数');
  const loraText = textOf(loraPage);
  ok(loraText.includes('LoRA 堆') && loraText.includes('普通 LoRA 节点'), 'LoRA 页把堆和普通节点分成两组');
  ok(loraText.includes('可折叠') && loraText.includes('按工作流顺序'), '两组分别说明可折叠排序 / 按顺序只改强度');
  const cards = collect(loraPage).filter((n) => n.props && /^#1[23] /.test(String(n.props.title || '')));
  eq(cards.length, 2, '堆和普通节点各渲染一张卡片');
  ok(textOf(cards[0]?.props?.actions || null).includes('收起'), 'LoRA 堆卡片有收起按钮');
  ok(!textOf(cards[1]?.props?.actions || null).includes('收起'), '普通节点卡片没有折叠按钮');
  ok(loraText.includes('点击 LoRA 名称可改显示名'), 'LoRA 页有改名小字说明');
  const nameBtns = byClass(loraPage, 'ac-loraname').filter((n) => n.type === 'button');
  eq(nameBtns.length, 2, '每个 LoRA 名称都是可点击按钮');
  ok(nameBtns.every((n) => n.props.disabled !== true), '未接管的名称可编辑');
  ok(String(nameBtns[0]?.props?.title || '').includes('点击修改显示名'), '名称按钮有改名提示');
}
const contState = Object.assign({}, fakeState, {
  config: Object.assign({}, fakeState.config, {
    generation: Object.assign({}, fakeState.config.generation, {
      continuous: { on: true, lora: '12::style.safetensors', strengths: [0.8, 1.0, 1.2] },
    }),
  }),
});
const contLora = renderPage('LoraPage(continuous)', T.LoraPage, {
  state: contState, api: apiStub, toast: noop, refresh: noop, initialWorkflowId: 'wf1', initialData: loraData,
});
{
  const takenRow = byClass(contLora, 'ac-lorarow')
    .find((n) => String(n.props?.className || '').split(/\s+/).includes('cont'));
  ok(!!takenRow, '连续图选中的 LoRA 行灰显');
  const check = collect(takenRow).find((n) => n.type === 'input' && n.props?.type === 'checkbox');
  eq(check?.props?.disabled, true, '接管行的开关不可点');
  const num = collect(takenRow).find((n) => n.type === 'input' && n.props?.type === 'number');
  eq(num?.props?.disabled, true, '接管行的强度不可改');
  ok(byClass(takenRow, 'ac-loraname').every((n) => n.props?.disabled === true), '接管行的名称不可编辑');
  ok(byClass(contLora, 'ac-drag').length >= 1, '接管行仍保留拖动排序');
  const card12 = collect(contLora).find((n) => n.props && /^#12 /.test(String(n.props.title || '')));
  ok(textOf(card12?.props?.actions || null).includes('连续图接管'), '卡片上有连续图接管标记');
}

section('概览 / 工作台 / 设置');
{
  const pages = [];
  const dash = T.DashboardPage({
    state: fakeState, jobs: [job], images: job.images, liveJob: job, api: apiStub,
    refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), setPage: (p) => pages.push(p), onView: noop,
  });
  const dt = textOf(dash);
  ok(dt.includes('ComfyRP'), '概览标题是 ComfyRP');
  ok(dt.includes('投递正文·接收提示词·返回图片'), '概览说明固定为投递正文·接收提示词·返回图片');
  ok(dt.includes('基础信息') && dt.includes('测试工作流'), '概览有基础信息和工作流名称');
  ok(dt.includes('正文会话') && !dt.includes('正文会话（s1）'), '概览的当前会话 / 正文来源只显示会话名，不再附加 session 短 id');
  ok(dt.includes('桥会话 · 本进程'), '提示词来源会话名后显示本进程 / 远程');
  ok(!dt.includes('更换会话'), '概览删掉了更换会话');
  ok(dt.includes('自动投递正文'), '自动投递选项改名自动投递正文');
  ok(/refreshSessions: function/.test(SRC) && /sessions\/refresh/.test(API_SRC), '会话刷新接口已注册');
  ok(/api\.refreshSessions\(\{ sessionId: sid \}\)/.test(SRC) && /可用会话/.test(SRC) && /当前：/.test(SRC), '概览「检测」同时刷新可用会话列表和当前会话名');
  ok(dt.includes('附加消息'), '概览有附加消息区域');
  const ta = collect(dash).find((n) => typeof n.props?.placeholder === 'string' && n.props.placeholder.includes('附加消息'));
  ok(ta, '附加消息留空时有灰色说明');
  const bodyField = byClass(dash, 'ac-deliverybody')[0];
  ok(bodyField, '投递区上方有正文文本框');
  const bodyTa = bodyField?.children?.[0];
  eq(bodyTa?.props?.value, '', '正文框初始留空，不自动读取正文');
  ok(/var effectiveSource = sourceCfg\.followActive/.test(SRC) && /var source = effectiveSource/.test(SRC), '本会话模式用 activeSessionId 作为正文来源，不依赖 capture.source 先刷新');
  ok(/加载 \/ 切换 \/ 当前会话更新：清空文本框，不自动读取正文。[\s\S]{0,80}clearBody\(\)/.test(SRC), '加载 / 切换 / 当前会话更新只清空正文框，不自动读取');
  ok(!/bodyRetry/.test(SRC) && !/loadBody\(true\)/.test(SRC), '不再自动重试读取正文');
  ok(/field === "autoForward" && value && !bodyDirty\.current[\s\S]{0,120}loadBody\(\)/.test(SRC), '打开自动投递正文才读取正文');
  ok(/source === "capture"/.test(SRC) && /at <= Math\.max\(autoBodyMountedAt\.current, sourceSinceRef\.current\)/.test(SRC) && /api\.job\(id\)/.test(SRC), '自动投递真的发生时把投出去的正文显示出来');
  ok(/bodyEditSeq\.current !== editSeq/.test(SRC), '读取期间用户已输入时不覆盖正文');
  ok(String(bodyTa?.props?.placeholder || '').includes('留空时不读取正文')
    && String(bodyTa?.props?.placeholder || '').includes('投递最新正文'), '正文框留空说明不自动读取，投递时才读取');
  ok(textOf(bodyField?.props?.label || null).includes('重新读取'), '正文框标题旁有重新读取');
  const deliveryCard = collect(dash).find((n) => n.props?.title === '投递');
  ok(deliveryCard?.children?.[0] === bodyField, '正文框在附加消息上方');
  const rows = byClass(dash, 'ac-basicrow');
  eq(rows.length, 5, '基础信息 5 行都可点击');
  const rowKids = rows[0].children || [];
  eq(rowKids[2]?.props?.className, 'ac-basicgo', '小字提示在右向三角左边');
  eq(rowKids[3]?.props?.className, 'ac-basicarrow', '右向三角在最右');
  const delivery = byClass(dash, 'ac-deliverygrid')[0];
  ok(delivery && (delivery.children || []).length === 2, '附加消息与位置是左右两栏');
  eq(delivery?.children?.[1]?.props?.label, '位置', '右侧栏标题是位置');
  const dacts = byClass(dash, 'ac-deliveryacts')[0];
  const dbtn = byClass(dacts, 'ac-genbtn')[0];
  ok(dbtn && textOf(dbtn).includes('投递最新正文'), '投递最新正文使用工作台同款大按钮');
  ok(byClass(dash, 'ac-deliverytoggles').length === 1 && !textOf(dash).includes('并非本会话'), '自动开关在按钮右侧，删掉并非本会话小字');
  rows[0].props.onClick();
  eq(pages[0], 'workbench', '点当前会话跳到工作台');
  rows[3].props.onClick();
  eq(pages[1], 'workflows', '点工作流跳到工作流页');

  const wfManual = Object.assign({}, fakeState, {
    activeWorkflow: Object.assign({}, fakeState.activeWorkflow, { sizeMode: 'manual' }),
  });
  const manualPage = T.WorkbenchPage({
    state: wfManual, jobs: [job], images: job.images, liveJob: job, api: apiStub,
    refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop, sessionId: 's1',
  });
  const mt = textOf(manualPage);
  const fieldW = collect(manualPage).find((n) => n.props?.label === '宽');
  const fieldH = collect(manualPage).find((n) => n.props?.label === '高');
  const inputW = fieldW?.children?.[0];
  const inputH = fieldH?.children?.[0];
  ok(inputW && inputW.props.disabled !== true && inputH.props.disabled !== true, '不勾选听从会话 size 时宽高可编辑');
  eq(String(inputW?.props.value), '832', '手动模式显示自己的宽，不被提取 size 顶掉');
  ok(mt.includes('从当前会话提取') && mt.includes('提取') && mt.includes('全部清空'), '提示词标题行有提取 / 从当前会话提取 / 全部清空');
  eq(byClass(manualPage, 'ac-linkbtn').length >= 3, true, '三个提示词操作都是链接按钮');
  ok(byClass(manualPage, 'ac-anchorbox').length === 1 && !mt.includes('未设置原文锚点') && !mt.includes('插入点：'), '工作台保留原文锚点输入框，但默认不再重复插入点文案');

  const autoJob = Object.assign({}, job, {
    createdAt: new Date().toISOString(),
    sets: [{ title: '自动任务', anchor: '这一场的最后一句。', size: null, positive: 'auto-new-prompt', negative: '' }],
    images: [{ ...job.images[0], anchor: '这一场的最后一句。' }],
  });
  sandbox.localStorage.setItem('airp-comfy:workbench:v1', JSON.stringify({
    sets: [{ title: '旧草稿', size: null, positive: 'draft-old-prompt', negative: '' }],
    sizeMode: 'manual', sizeDraft: { w: 1024, h: 1024 }, savedAt: 1,
  }));
  const autoPage = T.WorkbenchPage({
    state: fakeState, jobs: [autoJob], images: [], liveJob: autoJob, api: apiStub,
    refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop, sessionId: 's1',
  });
  ok(collect(autoPage).some((n) => n.props && n.props.value === 'auto-new-prompt'), '自动流程任务比草稿新时，工作台自动显示任务提示词');
  ok(collect(autoPage).some((n) => n.props && n.props.value === '这一场的最后一句。') && !textOf(autoPage).includes('插入点：这一场的最后一句。'), '任务里的原文锚点在输入框里显示，不再重复插入点文案');
  ok(textOf(autoPage).includes('插入点已匹配当前图') && (textOf(autoPage).match(/插入点已匹配当前图/g) || []).length === 1, '锚点匹配到图片时只显示一条小字');
  sandbox.localStorage.setItem('airp-comfy:workbench:v1', JSON.stringify({
    sets: [{
      title: '新草稿', anchor: '草稿里保存的原文锚点。',
      size: null, positive: 'draft-new-prompt', negative: '',
    }],
    sizeMode: 'manual', sizeDraft: { w: 1024, h: 1024 }, savedAt: Date.now() + 60000,
  }));
  const draftPage = T.WorkbenchPage({
    state: fakeState, jobs: [job], images: [], liveJob: job, api: apiStub,
    refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop, sessionId: 's1',
  });
  ok(collect(draftPage).some((n) => n.props && n.props.value === 'draft-new-prompt'), '本地草稿更新时不被旧任务覆盖');
  ok(collect(draftPage).some((n) => n.props && n.props.value === '草稿里保存的原文锚点。')
    && !textOf(draftPage).includes('插入点：草稿里保存的原文锚点。'), '本地草稿重开后原文锚点不丢，且不重复显示');
  sandbox.localStorage.removeItem('airp-comfy:workbench:v1');

  const dshPage = T.WorkbenchPage({
    state: fakeState, jobs: [job], images: job.images, liveJob: job, api: apiStub,
    refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop, sessionId: 's1',
  });
  const fieldWL = collect(dshPage).find((n) => n.props?.label === '宽');
  const fieldHL = collect(dshPage).find((n) => n.props?.label === '高');
  ok(fieldWL?.children?.[0]?.props.disabled === true && fieldHL?.children?.[0]?.props.disabled === true, '勾选听从会话 size 后宽高变灰锁住');
  eq(String(fieldWL?.children?.[0]?.props.value), '832', '锁定时显示提取到的会话宽');
  eq(String(fieldHL?.children?.[0]?.props.value), '1216', '锁定时显示提取到的会话高');
  ok(!/clamp\(e\.target\.value, 64, 4096\)/.test(SRC), '宽高输入不再每按一次键就夹到 64');
  ok(/beginSizeEdit\("w"\)/.test(SRC) && /commitSizeField\("w"/.test(SRC), '宽高输入聚焦开始编辑、失焦才兜底');
  ok(/onKeyDown: function \(e\) \{ if \(e\.key === "Enter"\) e\.currentTarget\.blur\(\); \}/.test(SRC), '宽高输入回车也会提交（失焦兜底）');
  ok(/n >= 64 && n <= 4096/.test(SRC) && /String\(raw\)\.trim\(\) !== ""/.test(SRC), '中间态（比如只打了 8）先留在文本框里，不打断输入');

  const errJob = Object.assign({}, job, { status: 'error', images: [] });
  const idlePage = T.WorkbenchPage({
    state: fakeState, jobs: [errJob], images: [], liveJob: errJob, api: apiStub,
    refresh: noop, toast: noop, saveConfig: () => Promise.resolve(), onView: noop, sessionId: 's1',
  });
  ok(textOf(idlePage).includes('状态：空闲'), '本次出图没图时状态是空闲，不是 error');

  const conn = T.ConnectionsPage({ state: fakeState, api: apiStub, toast: noop, refresh: noop, saveConfig: () => Promise.resolve() });
  const paths = byClass(conn, 'ac-pathlink');
  eq(paths.length, 2, '设置里输出目录 / 回收站两个路径可点');
  ok(paths.some((p) => textOf(p).includes('output')), '输出目录路径显示并可打开');
  ok(paths.some((p) => textOf(p).includes('_recycle')), '回收站路径显示并可打开');
}

section('单击亮菜单 / 双指捏合');
ok(/var \[peek, setPeek\] = useState\(false\)/.test(SRC) && /var PEEK_MS = 5000/.test(SRC), '单击图片框短暂亮菜单，5 秒后收回');
ok(/var showBL = nearAny \|\| menuOpen \|\| peek;/.test(SRC) && /var showBR = nearAny \|\| nearBR \|\| peek;/.test(SRC)
  && /var showTL = nearAny \|\| peek;/.test(SRC), '亮菜单期间四角按钮全部显示');
ok(/var startPeek = function \(\) \{[\s\S]{0,420}setMenuOpen\(true\);/.test(SRC), '亮菜单时自动展开铅笔那排菜单');
ok(/var bumpPeek = function \(\) \{[\s\S]{0,60}if \(!peekRef\.current\) return;/.test(SRC)
  && /peekTimer\.current = setTimeout\(endPeek, PEEK_MS\)/.test(SRC), '框内一有操作就续命，没操作才到点收回');
ok(/if \(!d\.moved && d\.kind === "frame" && !uiDownRef\.current && !pinchRef\.current\.active\) \{[\s\S]{0,80}startPeek\(\)/.test(SRC), '只有单击（没拖动 / 没点菜单 / 没捏合）才亮菜单');
ok(/if \(!next\) endPeek\(\);/.test(SRC), '手动关掉铅笔菜单立刻收回，不等 5 秒');
ok(/PEEK_DELAY_MS = 240/.test(SRC) && /peekDelay\.current = setTimeout/.test(SRC), '亮菜单前等过双击间隔，双击收框不会先闪一下');
ok(/var onUi = !!\(e\.target && e\.target\.closest && e\.target\.closest\("\[data-ui\]"\)\);/.test(SRC) && /uiDownRef\.current = onUi;/.test(SRC), '记下这次按下是不是落在菜单按钮上');
ok(/if \(peekDelay\.current\) \{ clearPeekTimer\(\); return; \}/.test(SRC), '双击的第二下撤掉待亮的菜单，不会闪一下');
ok(/onPointerMove: onFrameMove,/.test(SRC) && /var onFrameMove = function \(e\) \{\s*bumpPeek\(\);/.test(SRC), '鼠标在框里动也算操作');
ok(/clearPeekTimer\(\);/.test(SRC) && /clearTimeout\(peekDelay\.current\)/.test(SRC), '卸载 / 收框时清掉亮菜单的定时器');

ok(/function scaleFrameAround\(p, factor, midX, midY, vw, vh\)/.test(SRC), '框缩放算法抽成纯函数');
{
  const at = SRC.indexOf('function scaleFrameAround(');
  if (at < 0) { ok(false, '框缩放纯函数可执行'); } else {
    let depth = 0; let end = -1;
    for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const fn = new Function(`${SRC.slice(at, end)}; return scaleFrameAround;`)();
    const box = (o) => Object.assign({ x: 0, y: 0, w: 400, h: 400, anchorX: 200, anchorY: 200 }, o);
    const up = fn(box({ x: 200, y: 100, anchorX: 400, anchorY: 300 }), 1.5, 400, 300, 2000, 1200);
    eq(Math.round(up.w), 600, '放大 1.5 倍宽度跟着走');
    eq(Math.round(up.h), 600, '放大 1.5 倍高度跟着走');
    eq(Math.round(up.x), 100, '放大后两指中点在图上那一点不动');
    eq(Math.round(up.y), 0, '放大后锚点纵向同样钉住');
    const tiny = fn(box({ x: 0, y: 0, w: 400, h: 400 }), 0.001, 200, 200, 2000, 1200);
    eq(Math.round(tiny.h), 360, '缩到最小也不小于 360 高');
    const huge = fn(box({ x: 0, y: 0, w: 400, h: 400 }), 100, 200, 200, 2000, 1200);
    eq(Math.round(huge.w), 1200, '放到最大不超过视口（取宽高里更紧的那个）');
    const half = fn(box({ x: 0, y: 0, w: 800, h: 800, anchorX: 200, anchorY: 200 }), 0.5, 200, 200, 2000, 1200);
    eq([Math.round(half.w), Math.round(half.x), Math.round(half.y)].join(','), '400,100,100', '缩小后 25% 处的点仍在原屏幕位置');
    const pan = fn(box({ x: 0, y: 0, w: 800, h: 800, anchorX: 200, anchorY: 200 }), 1, 300, 300, 2000, 1200);
    eq([Math.round(pan.x), Math.round(pan.y)].join(','), '100,100', '两指一起平移时框跟着中点走');
    const over = fn(box({ x: 0, y: 0, w: 1000, h: 1000, anchorX: 0, anchorY: 0 }), 1, 0, 0, 800, 600);
    eq([Math.round(over.w), Math.round(over.h)].join(','), '600,600', '比视口大的框先压回视口再缩放');
  }
}
ok(/function pinchFrameStep\(p, a, b, vw, vh, dockMin\)/.test(SRC), '捏合的一步也抽成纯函数');
{
  const at = SRC.indexOf('function pinchFrameStep(');
  const from = SRC.indexOf('function scaleFrameAround(');
  if (at < 0 || from < 0) { ok(false, '捏合纯函数可执行'); } else {
    let depth = 0; let end = -1;
    for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const mod = new Function(`${SRC.slice(from, end)}; return { scaleFrameAround, pinchFrameStep };`)();
    const step = mod.pinchFrameStep;
    const dock = { active: true, dist: 100, docked: true, dockW: 300, dockMax: 800 };
    eq(step(dock, { clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }, 1600, 900, 240).dockW, 600, '停靠时两指拉开一倍，停靠宽度也翻倍');
    eq(step(dock, { clientX: 0, clientY: 0 }, { clientX: 1000, clientY: 0 }, 1600, 900, 240).dockW, 800, '停靠宽度不会超过上限');
    eq(step(dock, { clientX: 0, clientY: 0 }, { clientX: 5, clientY: 0 }, 1600, 900, 240).dockW, 240, '停靠宽度不会小于下限');
    eq(step(dock, { clientX: 0, clientY: 0 }, { clientX: 0, clientY: 0 }, 1600, 900, 240), null, '两指重合时不动');
    eq(step(Object.assign({}, dock, { active: false }), { clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }, 1600, 900, 240), null, '没在捏合时不动');
    const free = { active: true, dist: 200, docked: false, x: 800, y: 400, w: 400, h: 400, midX: 1000, midY: 600 };
    const out = step(free, { clientX: 900, clientY: 600 }, { clientX: 1300, clientY: 600 }, 2000, 1200, 240);
    eq([Math.round(out.w), Math.round(out.h), Math.round(out.x), Math.round(out.y)].join(','), '800,800,700,200', '自由状态按两指中点放大，中点钉住');
    eq(step(free, { clientX: 900, clientY: 600 }, { clientX: 1000, clientY: 600 }, 2000, 1200, 240).docked, false, '自由状态返回的是框尺寸');
  }
}
ok(/var factor = d \/ Math\.max\(1, Number\(p\.dist\) \|\| 1\);/.test(SRC) && /Math\.sqrt\(dx \* dx \+ dy \* dy\)/.test(SRC), '按两指距离比例算缩放倍数');
ok(/addEventListener\("touchstart", onTouchStart, \{ passive: false \}\)/.test(SRC)
  && /addEventListener\("touchmove", onTouchMove, \{ passive: false \}\)/.test(SRC), '双指手势用非 passive 监听，能压掉页面缩放 / 滚动');
ok(/if \(!inside\(a\) \|\| !inside\(b\)\) return;/.test(SRC), '两指都在框里才接管，框外双指还能缩页面');
ok(/if \(step\.docked\) \{[\s\S]{0,160}setFrame\(\{ dockW: step\.dockW \}, false\)/.test(SRC), '停靠时捏合改的是停靠宽度');
ok(/dragRef\.current = null;\s*setDragging\(false\);/.test(SRC), '捏合开始先掐掉单指拖动');
ok(/if \(pinchRef\.current\.active\) return;/.test(SRC), '捏合期间第二根手指不会再拖动图片框');
ok(/\.ac-frame \.ac-stage\{[^}]*touch-action:none/.test(cssText), '图片区本来就禁掉了浏览器手势，双指才归插件处理');
ok(/if \(ev\.touches && ev\.touches\.length >= 2\) return;[\s\S]{0,160}persistPrefs\(\);/.test(SRC), '捏合结束才落库，中间不写 localStorage');

section('会话下拉：同名会话能区分');
ok(/function sessionOptionLabel\(session, counts\)/.test(SRC), '会话下拉的显示名抽成纯函数');
{
  const at = SRC.indexOf('function sessionOptionLabel(');
  if (at < 0) { ok(false, '会话下拉纯函数可执行'); } else {
    let depth = 0; let end = -1;
    for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    const fn = new Function(SRC.slice(at, end) + '; return sessionOptionLabel;')();
    eq(fn({ displayTitle: '沐白形象管理', firstText: '小欣，别紧张，吃点零食。', userCount: 83 }, { '沐白形象管理': 2 }),
      '沐白形象管理 · “小欣，别紧张，吃点零食。” · 83条', '同名会话补首条用户消息 + 条数');
    eq(fn({ displayTitle: '普通会话', firstText: '随便写点', userCount: 12 }, { '普通会话': 1 }),
      '普通会话', '标题唯一时保持原样（不啰嗦）');
    eq(fn({ displayTitle: '沐白形象管理' }, { '沐白形象管理': 3 }), '沐白形象管理', '同名但没有首条消息时只显示标题');
    eq(fn({ sessionId: 'session-abcdef123456' }, {}), 'session-abcd', '没有标题时退回短 id');
    eq(fn({ displayTitle: '长标题', firstText: '一'.repeat(40), userCount: 2 }, { '长标题': 2 }),
      '长标题 · “' + '一'.repeat(22) + '…” · 2条', '首条消息过长要截断');
  }
}
ok(/bodyMeta\.opening/.test(SRC) && /人物卡开场（最新一条助手消息就是会话第一条）/.test(SRC), '概览正文框只有开场时给出提示');
ok(/opening: !!\(r && r\.opening\)/.test(SRC), '正文预览把「只有开场」带进 bodyMeta');
ok(/firstText: info\.firstText/.test(API_SRC) === false, '（host 字段在 session.js，不在 api.js）');

section('卸载');
try { dispose(); ok(true, 'disposer 可调用'); } catch (e) { ok(false, 'disposer 可调用', e.message); }

console.log(`\n== ${pass} ✔ / ${fails.length} ✘ ==`);
if (fails.length) {
  console.log('失败：');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
