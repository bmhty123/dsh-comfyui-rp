/**
 * LoRA 开关：把「哪几个 LoRA 开着 / 强度多少 / 顺序」从工作流 JSON 里解耦出来，
 * 存成一份按工作流的运行时覆盖表（workflow.loraState），出图那一刻才应用。
 *
 * 工作流本体（workflows.json 里的 json 字段）一个字都不改 —— 你在 ComfyUI 里
 * 改完再导出，桥这边不会把开关状态写死进去。
 *
 * ── LoraManager 实测行为（读的是 custom_nodes/comfyui-lora-manager 的源码）──
 *   py/nodes/lora_loader.py:156  `def load_loras(self, model, text, loras, **kwargs)`
 *                                第一行就是 `del text` —— ★ `<lora:xxx:1.00>` 那串
 *                                标签在运行时被完全忽略，只有 `loras.__value__` 数组
 *                                里的条目算数。
 *   py/nodes/lora_loader.py:52   `_collect_widget_entries` → `if not lora.get("active", False): continue`
 *                                ★ `active` 就是开关；`strength` = 模型强度，
 *                                `clipStrength` = 文本编码器强度（缺省取 strength）。
 *   py/nodes/utils.py:97         `get_loras_list` 原样返回 `__value__`，**不排序、不过滤**
 *                                ★ 数组顺序 = LoRA 的加载顺序。
 *   py/nodes/trigger_word_toggle.py:82  触发词节点：连进来的 `trigger_words` 只要
 *                                「非空」且与保存的 `orinalMessage` 的**词集**不同，
 *                                就直接用它；否则回落到节点里保存的分组开关。
 *                                ★ 坑：把某堆 LoRA 全关 → 连进来的串变成空串 → 覆盖
 *                                失效 → 保存的分组（active:true）又把触发词全放回来。
 *                                所以下面 applyLoraState() 会把被接管那堆的触发词节点
 *                                改成「纯通道」：orinalMessage 清空 + 分组全部 active:false，
 *                                从此它的输出恰好等于 LoraLoader 算出来的触发词。
 *                                ★ 一旦你在界面上**逐词**关掉了某个触发词，就不能再靠
 *                                「连进来的串」了（它会盖掉分组开关）——这时
 *                                applyLoraState() 会把 `inputs.trigger_words` 那条连线
 *                                摘掉（它是 optional 输入，可以不给），再按
 *                                `group_mode` 重建分组：开着的 LoRA 一组，组里每个词
 *                                一个 items 子项，`active` 就是逐词开关。
 *                                group_mode=false 时则摊平成「一个词一条」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './util.js';

/* ------------------------------- 常量 ------------------------------- */

const LORA_CLASS_RE = /lora/i;
const POWER_LORA_RE = /power\s*lora/i;
const LORA_STACKER_RE = /lora\s*stack(?:er)?/i;
const LORA_TAG_RE = /lora\s*tag/i;
const EFF_LOADER_RE = /efficient\s*loader|eff\.?\s*loader/i;
const TRIGGER_TOGGLE_RE = /trigger\s*word/i;

/** LoRA 名字的归一化：去掉扩展名 / 反斜杠 / 大小写差异，用来做匹配。 */
export function normalizeLoraName(name) {
  let s = String(name ?? '').trim().replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  if (i >= 0) s = s.slice(i + 1);
  s = s.replace(/\.(safetensors|ckpt|pt|bin)$/i, '');
  return s;
}

/** 用于比较的宽松键（忽略大小写、空格、下划线/连字符差异）。 */
function looseKey(name) {
  return normalizeLoraName(name).toLowerCase().replace(/[\s_\-.]/g, '');
}

/** 宽松键的公开版：跨接口比较 LoRA 名字时用它，别自己写一份。 */
export const loraKey = looseKey;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/** null / undefined / 空串都当「没填」，用 fallback；0 仍然是有效值。 */
const numOr = (v, fallback) => (v === null || v === undefined || v === '' ? fallback : num(v, fallback));

/** `<lora:name:1.00>` 里的强度写法：两位小数（和 LoraManager 自己写出来的一致）。 */
export function formatStrength(n) {
  return num(n, 1).toFixed(2);
}

/* --------------------------- 工作流结构扫描 --------------------------- */

function lorasValueOf(node) {
  const raw = node?.inputs?.loras;
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.__value__)) return raw.__value__;
  return null;
}

/**
 * 是不是「节点连线」：`[节点id, 槽位]`。
 * ★ 节点 id 不一定是纯数字 —— rgthree 之类的组节点长这样：`299:750`，
 *   所以这里只要求第一项是非空字符串/数字，别去卡 `/^\d+$/`。
 *   （踩过一次：卡了数字正则 → 带冒号的布尔量节点全被当成「写死」，开关整段失效）
 */
function isLink(v) {
  return Array.isArray(v) && v.length >= 2
    && (typeof v[0] === 'string' || typeof v[0] === 'number')
    && String(v[0]).length > 0;
}

/** 从 `<lora:name:0.80>` 这种文字标签里读出 LoRA 条目（LoraTagLoader 一类节点用）。 */
function tagEntries(text) {
  const out = [];
  const re = /<lora:([^:>]+):(-?\d+(?:\.\d+)?)(?::([^>]+))?>/gi;
  for (const m of String(text ?? '').matchAll(re)) {
    const name = String(m[1] ?? '').trim();
    if (!name) continue;
    const strength = numOr(m[2], 1);
    const clip = numOr(m[3], strength);
    out.push({ name, strength, clipStrength: clip, active: true });
  }
  return out;
}

function firstKeyOf(inputs, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) return key;
  }
  return '';
}

/**
 * 单 LoRA 节点：LoraLoader / LoraLoaderModelOnly / Efficient Loader 等。
 * 只认「节点类型或标题像 LoRA」且真的带 lora_name 的节点，避免把工具节点误认成 LoRA。
 */
function singleLoraStack(nodeId, node, classType) {
  const inputs = node.inputs || {};
  const nameKey = firstKeyOf(inputs, ['lora_name', 'loraName', 'lora']);
  if (!nameKey || typeof inputs[nameKey] !== 'string' || !inputs[nameKey].trim()) return null;
  const title = String(node?._meta?.title || node?.title || '');
  if (!LORA_CLASS_RE.test(classType) && !EFF_LOADER_RE.test(classType) && !LORA_CLASS_RE.test(title)) return null;
  const modelKey = firstKeyOf(inputs, ['strength_model', 'lora_model_strength', 'lora_strength', 'strength']);
  const clipKey = firstKeyOf(inputs, ['strength_clip', 'lora_clip_strength', 'lora_strength_clip', 'clip_strength']);
  const strength = modelKey ? numOr(inputs[modelKey], 1) : 1;
  const clip = clipKey ? numOr(inputs[clipKey], strength) : strength;
  return {
    kind: 'single',
    bind: { nameKey, modelKey, clipKey },
    entries: [{
      name: String(inputs[nameKey]).trim(),
      strength,
      clipStrength: clip,
      active: strength !== 0 || clip !== 0,
      selected: false,
      locked: false,
      expanded: false,
    }],
  };
}

/** rgthree 的 Power Lora Loader：inputs.lora_1 / lora_2 = { on, lora, strength, strengthTwo }。 */
function powerLoraStack(node, classType) {
  const title = String(node?._meta?.title || node?.title || '');
  if (!POWER_LORA_RE.test(classType) && !POWER_LORA_RE.test(title)) return null;
  const inputs = node.inputs || {};
  const entries = [];
  const slots = Object.keys(inputs)
    .map((key) => ({ key, m: /^lora_(\d+)$/i.exec(key) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  for (const { key, m } of slots) {
    const v = inputs[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const name = String(v.lora ?? v.name ?? '').trim();
    if (!name) continue;
    const strength = numOr(v.strength, 1);
    const clip = numOr(v.strengthTwo, strength);
    entries.push({
      name,
      strength,
      clipStrength: clip,
      active: v.on !== false,
      selected: false,
      locked: false,
      expanded: false,
      slot: Number(m[1]),
      key,
      nameKey: 'lora',
      modelKey: 'strength',
      clipKey: 'strengthTwo',
      onKey: 'on',
    });
  }
  return entries.length ? { kind: 'power', bind: {}, entries } : null;
}

/** Lora Stacker：lora_name_1 / model_weight_1 / clip_weight_1 这种编号格子。 */
function stackerLoraStack(node, classType) {
  const title = String(node?._meta?.title || node?.title || '');
  if (!LORA_STACKER_RE.test(classType) && !LORA_STACKER_RE.test(title)) return null;
  const inputs = node.inputs || {};
  const entries = [];
  const names = Object.keys(inputs)
    .map((key) => ({ key, m: /^lora_name[_-]?(\d+)$/i.exec(key) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  for (const { key, m } of names) {
    const name = String(inputs[key] ?? '').trim();
    if (!name) continue;
    const slot = Number(m[1]);
    const modelKey = firstKeyOf(inputs, [
      `model_weight_${slot}`, `model_strength_${slot}`, `strength_model_${slot}`,
      `lora_model_strength_${slot}`, `lora_model_weight_${slot}`, `weight_${slot}`,
    ]);
    const clipKey = firstKeyOf(inputs, [
      `clip_weight_${slot}`, `clip_strength_${slot}`, `strength_clip_${slot}`,
      `lora_clip_strength_${slot}`, `lora_clip_weight_${slot}`,
    ]);
    const strength = modelKey ? numOr(inputs[modelKey], 1) : 1;
    const clip = clipKey ? numOr(inputs[clipKey], strength) : strength;
    entries.push({
      name,
      strength,
      clipStrength: clip,
      active: strength !== 0 || clip !== 0,
      selected: false,
      locked: false,
      expanded: false,
      slot,
      nameKey: key,
      modelKey,
      clipKey,
    });
  }
  return entries.length ? { kind: 'stacker', bind: {}, entries } : null;
}

/** Lora Tag Loader：把文字里的 `<lora:name:0.8>` 标签当成 LoRA 清单。 */
function tagLoraStack(node, classType) {
  const title = String(node?._meta?.title || node?.title || '');
  if (!LORA_TAG_RE.test(classType) && !LORA_TAG_RE.test(title)) return null;
  const entries = tagEntries(node.inputs?.text).map((e, i) => ({
    ...e, selected: false, locked: false, expanded: false, slot: i,
  }));
  return entries.length ? { kind: 'tags', bind: { textKey: 'text' }, entries } : null;
}

/* --------------------- 运行时（临时）覆盖表 --------------------- */

/**
 * 「⚡ 临时生效」和总开关写这里：**只活在桥进程的内存里，桥一重启就没了**。
 * 出图时到底用哪份开关，优先级是：
 *
 *   运行时表（可能是 null = 明确「停用」，这时连记录里的也不认）
 *     > 工作流记录里的 loraState
 *       > 不接管（完全按工作流原样）
 *
 * 用 Map 存 `workflowId -> { state: object|null, at }`。`state === null` 也是一条
 * 有效记录（= 临时停用），所以判断「有没有临时覆盖」必须用 has()，不能看值。
 */
const runtimeLora = new Map();

/**
 * 写运行时覆盖。
 *   state = 一个对象 → 临时用这份
 *   state = null      → 临时停用（出图回到工作流原样，记录里那份先不用）
 *   state = undefined → 删掉这条临时覆盖，回落到工作流记录
 */
export function setRuntimeLoraState(workflowId, state) {
  const id = String(workflowId || '');
  if (!id) return { ok: false, temporary: false, state: null };
  if (state === undefined) {
    runtimeLora.delete(id);
  } else {
    const s = state && typeof state === 'object' && !Array.isArray(state) ? state : null;
    runtimeLora.set(id, { state: s, at: Date.now() });
  }
  const hit = runtimeLora.get(id);
  return { ok: true, temporary: runtimeLora.has(id), state: hit ? hit.state : null, at: hit ? hit.at : 0 };
}

/** 这条工作流有没有临时覆盖（temporary=true 时 state 可能还是 null）。 */
export function runtimeLoraInfo(workflowId) {
  const id = String(workflowId || '');
  const hit = runtimeLora.get(id);
  return { temporary: runtimeLora.has(id), state: hit ? hit.state : null, at: hit ? hit.at : 0 };
}

/** 彻底忘掉这条工作流的临时覆盖（「↻ 读取 & 重置 & 刷新」用）。 */
export function clearRuntimeLoraState(workflowId) {
  return runtimeLora.delete(String(workflowId || ''));
}

/**
 * 出图这一刻真正要用哪份开关。
 * 返回值可能是 null（= 不接管），也可能是 { stacks, switches }。
 */
export function resolveLoraState(wf) {
  const id = String((wf && wf.id) || '');
  if (id && runtimeLora.has(id)) return runtimeLora.get(id).state;
  const rec = wf && wf.loraState;
  return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
}

/**
 * 扫出工作流里的 LoRA 堆、它们的触发词节点、以及「选哪一堆生效」的开关。
 *
 * 返回：
 *   stacks:   [{ nodeId, title, classType, entries:[{name,strength,clipStrength,active,selected,locked}] }]
 *   toggles:  [{ nodeId, title, stackNodeId, groups:[{text,active}], orinalMessage }]
 *   switches: [{ controlNodeId, controlClass, value, trueStack, falseStack, nodeIds:[] }]
 */
export function scanLoraStacks(workflow) {
  const wf = workflow && typeof workflow === 'object' ? workflow : {};
  const stacks = [];
  const byId = new Map();

  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object') continue;
    const classType = String(node.class_type || '');
    const title = String(node?._meta?.title || node?.title || '');
    const list = lorasValueOf(node);

    let detected = null;
    // 1) LoraManager 式堆：inputs.loras 数组 / __value__
    if (Array.isArray(list) && list.length && (LORA_CLASS_RE.test(classType) || LORA_CLASS_RE.test(title))) {
      const entries = list.map((e) => ({
        name: String(e?.name ?? ''),
        strength: num(e?.strength, 1),
        clipStrength: num(e?.clipStrength, num(e?.strength, 1)),
        active: e?.active === true,
        selected: e?.selected === true,
        locked: e?.locked === true,
        expanded: false,
      })).filter((e) => e.name);
      if (entries.length) detected = { kind: 'manager', bind: {}, entries };
    }
    // 2) 散装节点：Power Lora Loader / Lora Stacker / 单 LoraLoader / Lora Tag Loader
    if (!detected) {
      detected = powerLoraStack(node, classType)
        || stackerLoraStack(node, classType)
        || singleLoraStack(nodeId, node, classType)
        || tagLoraStack(node, classType);
    }
    if (!detected) continue;

    const st = {
      nodeId,
      title,
      classType,
      kind: detected.kind,
      // 只有 LoraManager 的数组堆算「LoRA 堆」；其余都按普通节点列出。
      group: detected.kind === 'manager' ? 'stack' : 'loose',
      order: 0,
      bind: detected.bind || {},
      entries: detected.entries,
      toggles: [],
    };
    stacks.push(st);
    byId.set(String(nodeId), st);
  }

  // 普通单 LoRA 节点按 model 连线排出一个链式顺序：上游先、下游后。
  // 这样界面上「按工作流顺序」不会受 JSON key 顺序影响。
  {
    const assigned = new Set();
    let seq = 0;
    const assignOrder = (st, seen = new Set()) => {
      if (!st || assigned.has(st.nodeId) || seen.has(st.nodeId)) return;
      seen.add(st.nodeId);
      if (st.kind === 'single') {
        const link = wf[st.nodeId]?.inputs?.model;
        const up = isLink(link) ? byId.get(String(link[0])) : null;
        if (up && up.kind === 'single') assignOrder(up, seen);
      }
      assigned.add(st.nodeId);
      st.order = seq;
      seq += 1;
    };
    for (const st of stacks) assignOrder(st);
  }

  // 触发词节点：inputs.trigger_words = [<stackNodeId>, 2]
  const toggleOwner = new Map();
  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object') continue;
    if (!TRIGGER_TOGGLE_RE.test(String(node.class_type || ''))) continue;
    const link = node.inputs?.trigger_words;
    if (!isLink(link)) continue;
    const st = byId.get(String(link[0]));
    if (!st) continue;
    toggleOwner.set(String(nodeId), st.nodeId);
    const raw = node.inputs?.toggle_trigger_words;
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.__value__) ? raw.__value__ : []);
    const t = {
      nodeId,
      title: node._meta?.title || node.title || '',
      stackNodeId: st.nodeId,
      groups: arr.map((g) => ({ text: String(g?.text ?? ''), active: g?.active === true })),
      orinalMessage: typeof node.inputs?.orinalMessage === 'string' ? node.inputs.orinalMessage : '',
      groupMode: node.inputs?.group_mode !== false,
    };
    st.toggles.push(t);
  }

  // 「选哪一堆生效」：ComfySwitchNode 的 on_true / on_false 指向 LoRA 堆
  // ★ 触发词那条链上的开关指向的是「触发词节点」而不是堆本身，要用 toggleOwner 折算回它所属的堆，
  //   否则 299:1075 会被漏掉（实测：只看 LoRA 堆的时候 3 个开关只认出 2 个）。
  const switches = [];
  const byControl = new Map();
  const resolveStack = (id) => (byId.has(id) ? id : (toggleOwner.get(id) || ''));
  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object') continue;
    const inputs = node.inputs || {};
    if (!('on_true' in inputs) || !('on_false' in inputs)) continue;
    const t = resolveStack(String(inputs.on_true?.[0] ?? ''));
    const f = resolveStack(String(inputs.on_false?.[0] ?? ''));
    if (!t && !f) continue;
    const ctl = inputs.switch;
    let controlNodeId = '';
    let controlClass = '';
    if (isLink(ctl)) {
      controlNodeId = String(ctl[0]);
      controlClass = String(wf[controlNodeId]?.class_type || '');
      if (!/boolean/i.test(controlClass)) continue; // 只认布尔量（PrimitiveBoolean）
    } else if (typeof ctl !== 'boolean') {
      continue; // 开关来源看不懂就不碰它
    }
    const key = controlNodeId || `__literal__:${nodeId}`;
    let rec = byControl.get(key);
    if (!rec) {
      rec = {
        controlNodeId,
        controlClass,
        literal: controlNodeId ? null : ctl,
        value: controlNodeId ? wf[controlNodeId]?.inputs?.value === true : ctl,
        trueStack: t,
        falseStack: f,
        nodeIds: [],
      };
      byControl.set(key, rec);
      switches.push(rec);
    }
    rec.nodeIds.push(nodeId);
  }

  return { stacks, toggles: stacks.flatMap((s) => s.toggles), switches };
}

/* --------------------------- 运行时覆盖应用 --------------------------- */

/**
 * 把 loraState 应用到工作流副本上。
 *
 * loraState = {
 *   stacks:  { "<堆节点id>": [{ name, on, strength?, clip?, words?, wordsOff? }, ...] },  // 顺序 = 加载顺序
 *   switches:{ "<控制节点id>": true|false },                            // 选哪一堆生效
 * }
 *
 * `words` = 这个 LoRA 的触发词全集（界面上那份，来自 LoraManager 元数据）；
 * `wordsOff` = 被逐词关掉的那些。**只要有一行带 wordsOff，这一堆的触发词节点就整段接管**
 * （摘掉连线 + 重建分组），否则保持「纯通道」不变。
 *
 * 规则：
 *   · `stacks` 里没有的堆 → **一个字节都不改**（没被桥接管的堆保持原样）
 *   · `stacks[id]` 是空数组 → 也当没接管（防止误清空）
 *   · 被接管那堆：数组顺序 = 清单顺序；清单里没有、但工作流里原有的条目按原顺序追加
 *     （这样以后你在 ComfyUI 里往堆里加了新 LoRA，桥这边也不会把它弄丢）
 *   · 触发词节点被改成纯通道（见文件头注释里的坑）
 */
export function applyLoraState(workflow, loraState) {
  const wf = structuredClone(workflow);
  const report = { applied: false, stacks: [], toggles: [], switches: [], warnings: [] };
  if (!loraState || typeof loraState !== 'object') return { workflow: wf, report };

  const { stacks, switches } = scanLoraStacks(wf);
  const managed = loraState.stacks && typeof loraState.stacks === 'object' ? loraState.stacks : {};
  const stackById = new Map(stacks.map((s) => [String(s.nodeId), s]));

  // 1) 每堆的条目
  for (const [nodeId, list] of Object.entries(managed)) {
    const st = stackById.get(String(nodeId));
    if (!st) {
      report.warnings.push(`开关表里的 LoRA 堆 #${nodeId} 在当前工作流里找不到，已跳过`);
      continue;
    }
    if (!Array.isArray(list) || !list.length) {
      report.warnings.push(`LoRA 堆 #${nodeId} 的开关清单是空的，按「不接管」处理`);
      continue;
    }

    const srcByName = new Map();
    for (const e of st.entries) srcByName.set(looseKey(e.name), e);

    const out = [];
    const used = new Set();
    for (const item of list) {
      const key = looseKey(item?.name);
      if (!key || used.has(key)) continue;
      used.add(key);
      const src = srcByName.get(key) || null;
      const strength = num(item?.strength, src ? src.strength : 1);
      out.push({
        ...(src || {}),
        name: src ? src.name : String(item.name),
        strength,
        clipStrength: num(item?.clip, strength),
        active: item?.on !== false,
        expanded: false,
        selected: false,
        locked: src ? src.locked === true : false,
      });
    }
    // 工作流里原有、但清单里没提到的 → 原样追加，绝不悄悄丢掉
    for (const e of st.entries) {
      if (used.has(looseKey(e.name))) continue;
      out.push({ ...e, expanded: false, selected: false });
      report.warnings.push(`LoRA 堆 #${nodeId}：「${e.name}」不在开关清单里，按工作流原样保留`);
    }

    // 逐词开关：只有界面上真的关过某个触发词，才接管这一堆的触发词节点
    const wordsByKey = new Map();
    for (const item of list) {
      const key = looseKey(item?.name);
      if (!key) continue;
      const words = Array.isArray(item?.words) ? item.words.filter((w) => typeof w === 'string' && w.trim()) : [];
      const off = Array.isArray(item?.wordsOff) ? item.wordsOff.filter((w) => typeof w === 'string' && w.trim()) : [];
      if (words.length || off.length) wordsByKey.set(key, { name: String(item?.name ?? ''), words, off: new Set(off) });
    }
    // ★ 只有「关过词 **并且** 带着词表」才算真的逐词：没带词表就不知道要保留哪些词，
    //   摘掉连线会让这条 LoRA 的触发词一个都出不来 —— 那就宁可退回纯通道（保留全部词）。
    const customWords = [...wordsByKey.values()].some((v) => v.off.size > 0 && v.words.length > 0);
    for (const v of wordsByKey.values()) {
      if (v.off.size && !v.words.length) {
        report.warnings.push(`LoRA 堆 #${nodeId}：「${v.name}」关掉了触发词但没带上词表，这一堆按老办法处理（保留全部触发词）`);
      }
    }

    const node = wf[st.nodeId];
    node.inputs = node.inputs || {};
    const tagText = (e) => `<lora:${e.name}:${formatStrength(e.strength)}`
      + `${Number(e.clipStrength) !== Number(e.strength) ? ':' + formatStrength(e.clipStrength) : ''}>`;

    if (st.kind === 'manager') {
      node.inputs.loras = { __value__: out };
      // text 那个标签串运行时是被 `del text` 掉的，这里同步一份只为让预览/导出一致
      node.inputs.text = out.filter((e) => e.active).map(tagText).join(' ');
    } else if (st.kind === 'single') {
      const entry = out[0];
      const bind = st.bind || {};
      if (entry && bind.nameKey) node.inputs[bind.nameKey] = entry.name;
      if (entry && bind.modelKey) node.inputs[bind.modelKey] = entry.active ? entry.strength : 0;
      if (entry && bind.clipKey) node.inputs[bind.clipKey] = entry.active ? entry.clipStrength : 0;
      if (out.length > 1) report.warnings.push(`单 LoRA 节点 #${st.nodeId} 只接管第一条，其余 ${out.length - 1} 条已忽略`);
    } else if (st.kind === 'power') {
      for (const e of out) {
        const src = st.entries.find((x) => looseKey(x.name) === looseKey(e.name));
        const key = e.key || src?.key || '';
        const obj = key ? node.inputs[key] : null;
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        if (e.name) obj.lora = e.name;
        obj.on = e.active === true;
        if (e.active) {
          if (e.modelKey || Object.prototype.hasOwnProperty.call(obj, 'strength')) obj.strength = e.strength;
          if (e.clipKey || Object.prototype.hasOwnProperty.call(obj, 'strengthTwo')) obj.strengthTwo = e.clipStrength;
        }
      }
    } else if (st.kind === 'stacker') {
      for (const e of out) {
        if (!e.nameKey) continue;
        node.inputs[e.nameKey] = e.name;
        if (e.modelKey) node.inputs[e.modelKey] = e.active ? e.strength : 0;
        if (e.clipKey) node.inputs[e.clipKey] = e.active ? e.clipStrength : 0;
      }
    } else if (st.kind === 'tags') {
      const textKey = st.bind?.textKey || 'text';
      let text = String(node.inputs[textKey] ?? '');
      let i = 0;
      const re = /<lora:([^:>]+):(-?\d+(?:\.\d+)?)(?::([^>]+))?>/gi;
      text = text.replace(re, () => {
        const e = out[i];
        i += 1;
        return e && e.active ? tagText(e) : '';
      });
      if (i < out.length) {
        text = [text.trim(), ...out.slice(i).filter((e) => e.active).map(tagText)].filter(Boolean).join(' ');
      }
      node.inputs[textKey] = text.trim();
    } else {
      report.warnings.push(`LoRA 节点 #${st.nodeId} 的类型无法接管，已跳过`);
      continue;
    }

    // 2) 触发词节点：默认改成「纯通道」；有关掉的词就整段接管（逐词开关）
    for (const t of st.toggles) {
      const tnode = wf[t.nodeId];
      if (!tnode) continue;
      tnode.inputs = tnode.inputs || {};
      const raw = tnode.inputs.toggle_trigger_words;
      const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.__value__) ? raw.__value__ : []);

      if (customWords) {
        // ★ 必须摘掉 LoRA 节点连过来的那条线：TriggerWordToggleLM 只要拿到非空、
        //   且词集与 orinalMessage 不同的串，就直接返回它，分组开关一律不看。
        //   `trigger_words` 是 optional 输入（FlexibleOptionalInputType），可以不给。
        delete tnode.inputs.trigger_words;
        const groups = [];
        let wordsAll = 0;
        let wordsOff = 0;
        for (const e of out) {
          const rec = wordsByKey.get(looseKey(e.name));
          if (!rec || !rec.words.length) continue;
          const on = e.active === true;
          if (t.groupMode) {
            const items = rec.words.map((w) => {
              const wOn = !rec.off.has(w);
              if (!wOn) wordsOff += 1;
              wordsAll += 1;
              return { text: w, active: on && wOn, highlighted: false };
            });
            groups.push({ text: rec.words.join(', '), active: on, highlighted: false, items });
          } else {
            for (const w of rec.words) {
              const wOn = !rec.off.has(w);
              if (!wOn) wordsOff += 1;
              wordsAll += 1;
              groups.push({ text: w, active: on && wOn, highlighted: false });
            }
          }
        }
        if (Array.isArray(raw)) tnode.inputs.toggle_trigger_words = groups;
        else tnode.inputs.toggle_trigger_words = { ...(raw && typeof raw === 'object' ? raw : {}), __value__: groups };
        tnode.inputs.orinalMessage = '';
        report.toggles.push({
          nodeId: t.nodeId,
          title: t.title,
          mode: 'custom',
          linkRemoved: true,
          groups: groups.length,
          words: wordsAll,
          wordsOff,
          groupsCleared: 0,
        });
        continue;
      }

      for (const g of arr) {
        if (g && typeof g === 'object') g.active = false;
        if (g && Array.isArray(g.items)) for (const it of g.items) if (it && typeof it === 'object') it.active = false;
      }
      if (Array.isArray(raw)) tnode.inputs.toggle_trigger_words = arr;
      else if (raw && typeof raw === 'object') tnode.inputs.toggle_trigger_words = { ...raw, __value__: arr };
      tnode.inputs.orinalMessage = '';
      report.toggles.push({ nodeId: t.nodeId, title: t.title, mode: 'passthrough', groupsCleared: arr.length });
    }

    report.stacks.push({
      nodeId: st.nodeId,
      title: st.title,
      kind: st.kind,
      entries: out.map((e) => ({ name: e.name, on: e.active === true, strength: e.strength })),
      on: out.filter((e) => e.active).length,
      off: out.filter((e) => !e.active).length,
    });
    report.applied = true;
  }

  // 3) 「选哪一堆生效」
  const swState = loraState.switches && typeof loraState.switches === 'object' ? loraState.switches : {};
  for (const sw of switches) {
    if (!sw.controlNodeId) {
      report.warnings.push(`开关 #${sw.nodeIds.join('/')} 的布尔量是写死的（不是节点连线），跳过`);
      continue;
    }
    if (!(sw.controlNodeId in swState)) continue;
    const want = swState[sw.controlNodeId] === true;
    const ctl = wf[sw.controlNodeId];
    if (!ctl) {
      report.warnings.push(`布尔量节点 #${sw.controlNodeId} 不存在（它可能是 rgthree 的组节点）`);
      continue;
    }
    ctl.inputs = ctl.inputs || {};
    ctl.inputs.value = want;
    report.switches.push({ controlNodeId: sw.controlNodeId, value: want, nodeIds: sw.nodeIds });
    report.applied = true;
  }

  return { workflow: wf, report };
}

/* --------------------------- LoRA 目录（走 ComfyUI 接口） --------------------------- */

let catalogCache = { at: 0, baseUrl: '', items: [] };
const CATALOG_TTL_MS = 120000;

function normalizeCatalogItem(it) {
  const name = normalizeLoraName(it?.file_name || it?.model_name || it?.name || '');
  const tw = it?.civitai?.trainedWords;
  return {
    name,
    modelName: String(it?.model_name || ''),
    baseModel: String(it?.base_model || ''),
    folder: String(it?.folder || ''),
    tags: Array.isArray(it?.tags) ? it.tags.filter((t) => typeof t === 'string') : [],
    trainedWords: Array.isArray(tw) ? tw.filter((t) => typeof t === 'string' && t.trim()) : [],
    previewUrl: typeof it?.preview_url === 'string' ? it.preview_url : '',
    fileSize: num(it?.file_size, 0),
    usageCount: num(it?.usage_count, 0),
    favorite: it?.favorite === true,
    civitaiUrl: it?.civitai?.modelId ? `https://civitai.com/models/${it.civitai.modelId}` : '',
  };
}

async function httpGetJson(url, timeoutMs, signal) {
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * 拿 LoRA 目录。优先走 LoraManager 的 REST 接口（有 base model / 触发词 / 预览图），
 * 装不了就退回 ComfyUI 自带的 `/object_info/LoraLoader`（只有名字）。
 */
export async function fetchLoraCatalog(baseUrl, { timeoutMs = 15000, signal, refresh = false } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { items: [], source: 'none', error: '没配 ComfyUI 地址' };
  if (!refresh && catalogCache.items.length && catalogCache.baseUrl === base && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return { items: catalogCache.items, source: catalogCache.source, cached: true };
  }

  let source = 'lora-manager';
  let items = [];
  let error = '';
  try {
    const data = await httpGetJson(`${base}/api/lm/loras/list?page=1&page_size=500&sort=name`, timeoutMs, signal);
    items = (Array.isArray(data?.items) ? data.items : []).map(normalizeCatalogItem).filter((x) => x.name);
  } catch (e) {
    error = String(e?.message || e);
    source = 'object_info';
    try {
      const info = await httpGetJson(`${base}/object_info/LoraLoader`, timeoutMs, signal);
      const vals = info?.LoraLoader?.input?.required?.lora_name?.[0];
      items = (Array.isArray(vals) ? vals : []).map((n) => normalizeCatalogItem({ file_name: n }));
      error = '';
    } catch (e2) {
      return { items: [], source: 'none', error: `${error}；退回 /object_info 也失败：${String(e2?.message || e2)}` };
    }
  }

  catalogCache = { at: Date.now(), baseUrl: base, items, source };
  return { items, source };
}

export function clearLoraCatalogCache() {
  catalogCache = { at: 0, baseUrl: '', items: [] };
}

/* --------------------------- 中文名映射 --------------------------- */

/** 数据目录由宿主在 apply() 里注入（和 store 用同一个目录）。 */
let loraDataDir = '';
const NAMES_FILE = () => path.join(loraDataDir || defaultDataDir(), 'lora-names.json');

/** 出厂的中文名。文件 `data/lora-names.json` 里的同名键会覆盖这里 —— 你随时可以改。 */
export const DEFAULT_LORA_NAMES = {
  'Turbo-ANIMA-v4': '加速 ANIMA v4（少步数）',
  'deep_penetration_v0.0.1_1100': '深度贯穿',
  'afterimage_(crotch)_v0.0.2_1100': '残影·胯部',
  'ass_pose_anima': '臀部姿势',
  'cum_beam_anima': '射精光柱',
  'disgusted_face_anima_goofy': '嫌弃脸（滑稽）',
  'leg lock_anima_V1.0': '锁腿',
  'arched_back_kiss_anima_anima_3263769': '弓背接吻',
  'xipaearly2026_A2.9B_v01': 'XIPA 画风·早期2026',
  'xipa202601-mid03_Krea2_v01': 'XIPA 画风·202601',
  'turisasuStyleV2.0': 'TuriSasu 画风 v2.0',
  'TuriSasu Style v1.0': 'TuriSasu 画风 v1.0',
  '[Oden Ohgan (TuriSasu)] Bitches With Dicks ~Otokonoko Report~ 2 Doujin Style Anima': 'Oden Ohgan 同人画风（男娘报告2）',
  '@ga-chan_(kokonattusoul)_v0.0.0_0900': 'Ga酱画风',
  'refusal_reduction_v2': '抗拒削弱 v2（Krea2）',
  'silhouette_sex_epoch_10': '剪影性爱',
  'mating_press_v0.2-pony': '交配压制（Pony）',
  'Femboy_Dom': '男娘攻',
  'kanzarin_v1_step1500': 'カンザリン 画风',
  'alisa_mikhailovna_kujou-roshidere_s1-ana-anime-soralz': '艾莉莎·米哈伊罗芙娜·九条',
};

let namesCache = null;

/** 宿主 apply() 时调用一次；之后 readLoraNames() 从同一个数据目录读。 */
export function configureLoraDataDir(dir) {
  loraDataDir = String(dir || '');
  namesCache = null;
}

export function readLoraNames() {
  if (namesCache) return namesCache;
  let custom = {};
  try {
    if (fs.existsSync(NAMES_FILE())) {
      const raw = JSON.parse(fs.readFileSync(NAMES_FILE(), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) custom = raw;
    }
  } catch {
    /* 文件坏了就用出厂的，不因为一个名字文件炸掉整个页面 */
  }
  namesCache = { ...DEFAULT_LORA_NAMES, ...custom };
  return namesCache;
}

/** 首次调用时把出厂中文名落一份到磁盘，方便你直接改那个文件。 */
export function ensureLoraNamesFile() {
  try {
    fs.mkdirSync(path.dirname(NAMES_FILE()), { recursive: true });
    if (!fs.existsSync(NAMES_FILE())) {
      fs.writeFileSync(NAMES_FILE(), JSON.stringify(DEFAULT_LORA_NAMES, null, 2), 'utf8');
      return true;
    }
  } catch {
    /* 写不了就算了，不影响功能 */
  }
  return false;
}

/** 给一个 LoRA 起中文名：映射表 → 英文 model_name → 文件名。 */
export function loraLabel(name, names = null, item = null) {
  const map = names || readLoraNames();
  const n = normalizeLoraName(name);
  if (map[n]) return map[n];
  const hit = Object.keys(map).find((k) => looseKey(k) === looseKey(n));
  if (hit) return map[hit];
  if (item && item.modelName) return item.modelName;
  return n;
}
