import fs from 'node:fs';
import path from 'node:path';
import { HttpError, joinUrl, num, sanitizeName, uid } from './util.js';
import { applyLoraState, scanLoraStacks } from './lora.js';

export const POSITIVE_TOKEN = '%prompt%';
export const NEGATIVE_TOKEN = '%negative_prompt%';
/**
 * 分辨率占位符：和正/负面占位符一样是**全局**替换的，不依赖「映射为」，
 * 只要工作流里写了 %width% / %height% 就会被换成当前这一套的宽高。
 * 典型用法：ResolutionPreset 的 resolution_json 写成
 *   {"version":1,"width":"%width%","height":"%height%"}
 * 或者 EmptyLatentImage 的 width/height 直接填 %width% / %height%（整格就是占位符时写进去的是数字）。
 */
export const WIDTH_TOKEN = '%width%';
export const HEIGHT_TOKEN = '%height%';
export const SIZE_TOKENS = [WIDTH_TOKEN, HEIGHT_TOKEN];
/** 节点里哪些输入键算「宽/高」——映射为「分辨率」时会被写成数字。 */
const SIZE_INPUT_KEYS = ['width', 'height'];

/**
 * 哪些节点算「采样/噪声节点」：只有这些节点上的 seed 会影响出图。
 * 例：KSampler / KSampler (Efficient) / SamplerCustom / RandomNoise / Noise 系。
 */
const SEED_NODE_RE = /sampler|noise/i;

/**
 * ComfyUI 前端「randomize」用的上限是 2^50。
 * 落在 u64 里，也是 JS 安全整数，不会出现精度丢失导致的两个节点拿到同一个值。
 */
const SEED_RANGE = 1125899906842624;

/** 生成一个新的随机种子。 */
export function randomSeedValue() {
  return Math.floor(Math.random() * SEED_RANGE);
}

/**
 * 把工作流里采样节点上**字面量**的种子读出来（不改动任何东西）。
 *
 * 用来把「这次到底用了什么种子」记进图片记录里 —— 图片列表要显示种子，
 * 而种子是在 applyOverrides 之后才落定的，只能从**准备好的那份工作流**里读。
 * 值是链接（数组）的那些不算：那是别的节点在提供种子，不归这里管。
 */
export function seedsOfWorkflow(workflow) {
  const out = [];
  if (!workflow || typeof workflow !== 'object') return out;
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    if (!SEED_NODE_RE.test(String(node.class_type || ''))) continue;
    for (const key of Object.keys(node.inputs)) {
      if (key !== 'seed' && key !== 'noise_seed' && key !== 'rand_seed') continue;
      const v = node.inputs[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out.push({
        nodeId,
        classType: node.class_type || '',
        title: node?._meta?.title || node?.title || '',
        inputKey: key,
        value: v,
      });
    }
  }
  return out;
}

/**
 * 把工作流里采样节点的种子**重新摇一遍**，其余参数一个字都不动。
 * 用来"一份提示词并行跑两次"：两次的提示词 / cfg / 步数 / 负面提示完全一样，
 * 只有噪声种子不同，所以出的是两张不同的图。
 */
export function rerollSeeds(workflow) {
  const wf = structuredClone(workflow);
  const seeds = [];
  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    if (!SEED_NODE_RE.test(String(node.class_type || ''))) continue;
    for (const key of Object.keys(node.inputs)) {
      if (key !== 'seed' && key !== 'noise_seed' && key !== 'rand_seed') continue;
      if (typeof node.inputs[key] !== 'number' || !Number.isFinite(node.inputs[key])) continue;
      node.inputs[key] = randomSeedValue();
      seeds.push({ nodeId, inputKey: key, after: node.inputs[key] });
    }
  }
  return { workflow: wf, seeds };
}

const TEXT_INPUT_KEYS = [
  'text',
  'text_g',
  'text_l',
  'prompt',
  'positive',
  'negative',
  'string',
  'value',
  'wildcard_text',
  'content',
];

function isWorkflow(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const entries = Object.entries(obj);
  if (!entries.length) return false;
  return entries.every(([, v]) => v && typeof v === 'object' && typeof v.class_type === 'string');
}

export function parseWorkflowJson(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new HttpError(400, `工作流 JSON 解析失败: ${e.message}`);
    }
  }
  // 兼容 {"prompt": {...}} / {"workflow": {...}} 包装
  if (obj && !isWorkflow(obj)) {
    if (isWorkflow(obj.prompt)) obj = obj.prompt;
    else if (isWorkflow(obj.workflow)) obj = obj.workflow;
  }
  if (!isWorkflow(obj)) {
    throw new HttpError(400, '这不是 ComfyUI 的 API 格式工作流（应为 { "3": { "class_type": "...", "inputs": {...} }, ... }）。请用「导出(API)」得到的 JSON，而不是普通的 workflow.json。');
  }
  return obj;
}

/**
 * 递归找出一段 JSON 里所有「数字类型的 width / height」字段，返回它们的路径。
 * 用来识别 ResolutionPreset 那条 `resolution_json`（一整个 JSON 字符串）。
 */
function jsonSizePaths(obj, prefix = '') {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (SIZE_INPUT_KEYS.includes(k) && typeof v === 'number' && Number.isFinite(v)) {
      out.push({ path: p, key: k, value: v });
    } else if (v && typeof v === 'object') {
      out.push(...jsonSizePaths(v, p));
    }
  }
  return out;
}

/**
 * 这个节点上哪些地方是「可以被分辨率改写」的：
 * - 任何输入里含 %width% / %height% 占位符（走全局替换）
 * - 字面量数字的 width / height 输入
 * - 本身是 JSON 的字符串输入里带数字 width / height（ResolutionPreset 的 resolution_json）
 * 连线的 width/height（如 EmptyLatentImage 的 ["76",0]）不算，它跟着上游走。
 */
function sizeFieldsOf(node) {
  const inputs = node?.inputs || {};
  const keys = [];
  const values = [];
  const jsonKeys = [];
  let hasToken = false;
  let sizeTokenCount = 0;
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'string') {
      for (const t of SIZE_TOKENS) {
        if (v.includes(t)) {
          hasToken = true;
          sizeTokenCount += v.split(t).length - 1;
        }
      }
    }
  }
  for (const k of SIZE_INPUT_KEYS) {
    const v = inputs[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      keys.push(k);
      values.push({ field: k, value: v });
    }
  }
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v !== 'string' || !v.trim().startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(v);
    } catch {
      continue;
    }
    const found = jsonSizePaths(parsed);
    if (found.length) {
      jsonKeys.push(k);
      for (const f of found) values.push({ field: `${k}.${f.path}`, value: f.value });
    }
  }
  return { keys, values, jsonKeys, hasToken, sizeTokenCount };
}

function firstTextKey(node) {
  const inputs = node?.inputs || {};
  for (const k of TEXT_INPUT_KEYS) {
    if (typeof inputs[k] === 'string') return k;
  }
  return null;
}

/**
 * 映射成正面 / 负面时要一起写的文本输入。
 * SDXL 的 CLIPTextEncodeSDXL 同时有 text_g / text_l，只写第一个会留下另一半旧词。
 */
function textKeysForMapping(node) {
  const inputs = node?.inputs || {};
  const keys = TEXT_INPUT_KEYS.filter((k) => typeof inputs[k] === 'string');
  const dual = keys.filter((k) => k === 'text_g' || k === 'text_l');
  if (dual.length >= 2) return dual.slice(0, 2);
  return keys.length ? [keys[0]] : [];
}

/* ---------------------- 从采样器连线反推正负面节点 ---------------------- */

const PROMPT_TEXT_KEYS = [
  'text', 'text_g', 'text_l', 'string', 'string_a', 'string_b',
  'prompt', 'content', 'value', 'wildcard_text', 'positive', 'negative',
];
const PROMPT_FOLLOW_KEYS = [
  'conditioning', 'positive', 'negative',
  'conditioning_1', 'conditioning_2', 'conditioning_to', 'conditioning_from',
  'conditioning_start', 'conditioning_end',
];

function isNodeLink(v) {
  return Array.isArray(v) && v.length >= 2
    && (typeof v[0] === 'string' || typeof v[0] === 'number')
    && String(v[0]).length > 0;
}

/** 顺着连线往回找真正写字的那一格；只收集字面量字符串，最多 12 跳并带环保护。 */
function resolvePromptTextTargets(nodes, startId, maxHop = 12) {
  const targets = [];
  const seen = new Set();
  const queue = [{ id: String(startId ?? ''), hop: 0 }];
  while (queue.length) {
    const { id, hop } = queue.shift();
    if (!id || !nodes[id] || seen.has(id) || hop > maxHop) continue;
    seen.add(id);
    const node = nodes[id];
    // 明确「把负面清空」的节点不再往上找，否则会误把正面词当成负面。
    const classType = String(node.class_type || '');
    if (/ConditioningZeroOut/i.test(classType)) continue;
    const inputs = node.inputs || {};
    // 拼接节点只跟第二路（正文）；第一路通常是固定前缀 / 画质词，不该被当成提示词主体。
    const textKeys = /StringConcatenate/i.test(classType) ? ['string_b'] : PROMPT_TEXT_KEYS;
    for (const key of textKeys) {
      const value = inputs[key];
      if (typeof value === 'string') targets.push({ node: id, input: key });
      else if (isNodeLink(value)) queue.push({ id: String(value[0]), hop: hop + 1 });
    }
    // 条件节点本身不写字，继续顺着 conditioning / positive / negative 往回找。
    for (const key of PROMPT_FOLLOW_KEYS) {
      const value = inputs[key];
      if (isNodeLink(value)) queue.push({ id: String(value[0]), hop: hop + 1 });
    }
  }
  return targets;
}

/**
 * 正/负面最可靠的判断：从采样器的 positive / negative 输入往回找文本节点。
 * 节点标题没写「正面 / 负面」时也照样能认出来（Text Multiline 这类上游文本节点）。
 */
function promptRolesFromGraph(workflow) {
  const nodes = workflow && typeof workflow === 'object' ? workflow : {};
  const roles = new Map();
  const conflicts = new Set();
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object') continue;
    const inputs = node.inputs || {};
    const classType = String(node.class_type || '');
    const sampler = /sampler/i.test(classType) || (isNodeLink(inputs.positive) && isNodeLink(inputs.negative));
    if (!sampler) continue;
    for (const role of ['positive', 'negative']) {
      const link = inputs[role];
      if (!isNodeLink(link)) continue;
      for (const target of resolvePromptTextTargets(nodes, String(link[0]))) {
        const prev = roles.get(String(target.node));
        if (prev && prev !== role) conflicts.add(String(target.node));
        else if (!prev) roles.set(String(target.node), role);
      }
    }
  }
  for (const id of conflicts) roles.delete(id);
  return roles;
}

/**
 * 扫描节点给前端做映射。只列「可映射节点」：
 *   · 带字符串文本输入的（正 / 负面 / 未知）
 *   · 带分辨率参数或 %width%/%height% 占位符的（分辨率）
 *   · LoraManager 的 inputs.loras 堆（lora堆）
 *   · 标准 LoraLoader 的单 LoRA（lora）
 * 每个节点带 kind / label / hint，前端不再自己猜。
 */
export function scanPromptNodes(workflow) {
  const out = [];
  const stacks = scanLoraStacks(workflow).stacks || [];
  const stackById = new Map(stacks.map((s) => [String(s.nodeId), s]));
  const graphRoles = promptRolesFromGraph(workflow);
  const loraLoaderRe = /lora\s*loader/i;
  const UNKNOWN_HINT = '插件未能识别，请自行判断映射与否，映射会将整段原有内容替换';

  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue;
    const key = firstTextKey(node);
    const size = sizeFieldsOf(node);
    const isSizeNode = size.hasToken || size.keys.length > 0 || size.jsonKeys.length > 0;
    const classType = String(node.class_type || '');
    const stack = stackById.get(String(id)) || null;
    const loraStack = stack && stack.kind !== 'single' ? stack : null;
    const inputs = node.inputs || {};
    const singleLora = !loraStack && (stack?.kind === 'single'
      || (loraLoaderRe.test(classType)
        && (Object.prototype.hasOwnProperty.call(inputs, 'lora_name')
          || Object.prototype.hasOwnProperty.call(inputs, 'lora')
          || Object.prototype.hasOwnProperty.call(inputs, 'loras'))));
    if (!key && !isSizeNode && !loraStack && !singleLora) continue;

    const raw = key ? String(node.inputs[key]) : '';
    const title = node?._meta?.title || node?.title || '';
    const hay = `${title} ${classType} ${raw}`.toLowerCase();
    let guess = 'positive';
    if (/negat|负面|反相|反向/.test(hay)) guess = 'negative';
    if (!key && isSizeNode) guess = 'size';

    const firstTok = raw.includes(POSITIVE_TOKEN)
      ? POSITIVE_TOKEN
      : raw.includes(NEGATIVE_TOKEN)
        ? NEGATIVE_TOKEN
        : null;
    const tokIdx = firstTok ? raw.indexOf(firstTok) : -1;
    const tokenRole = firstTok === POSITIVE_TOKEN
      ? '正面提示词'
      : firstTok === NEGATIVE_TOKEN ? '负面提示词' : '';
    // 占位符本身已经能说明角色，只有没有占位符的纯文本节点才用采样器连线兜底。
    const graphRole = firstTok ? '' : (graphRoles.get(String(id)) || '');
    if (graphRole) guess = graphRole;

    let kind = 'unknown';
    let label = '未知';
    let hint = UNKNOWN_HINT;
    let tone = null;
    let suggestRole = '';
    let loraCount = 0;

    if (loraStack) {
      kind = 'loraStack';
      label = 'lora堆';
      hint = '建议保留原内容';
      tone = 'warn';
      loraCount = Array.isArray(loraStack.entries) ? loraStack.entries.length : 0;
    } else if (singleLora) {
      kind = 'lora';
      label = 'lora';
      hint = '建议保留原内容';
      tone = 'warn';
    } else if (firstTok) {
      kind = 'token';
      label = '占位符' + firstTok;
      hint = '建议映射为' + tokenRole;
      tone = 'ok';
      suggestRole = firstTok === POSITIVE_TOKEN ? 'positive' : 'negative';
    } else if (key) {
      if (guess === 'negative') {
        kind = 'negative';
        label = '负面提示词';
        hint = '若想保留原工作流的负面提示词，选择保留原内容';
        tone = 'warn';
        suggestRole = 'negative';
      } else if (guess === 'positive') {
        // 没有任何正面线索的文本节点归“未知”，避免把工具节点误标成正面。
        const positiveClue = /posit|正面|positive/.test(hay) || graphRole === 'positive';
        if (positiveClue) {
          kind = 'positive';
          label = '正面提示词';
          hint = '建议映射为正面提示词';
          tone = 'ok';
          suggestRole = 'positive';
        }
      }
    } else if (isSizeNode) {
      kind = 'size';
      label = '分辨率';
      hint = '建议映射为分辨率';
      tone = 'acc';
      suggestRole = 'size';
    }

    out.push({
      id,
      classType,
      title,
      inputKey: key || '',
      inputKeys: textKeysForMapping(node),
      value: raw.slice(0, 240),
      valueLength: raw.length,
      guess,
      hasPositiveToken: raw.includes(POSITIVE_TOKEN),
      hasNegativeToken: raw.includes(NEGATIVE_TOKEN),
      // 覆盖方式：token = 只替换占位符（前后缀保留）；whole = 节点内无占位符，映射会整段替换
      mode: loraStack || singleLora ? 'lora' : firstTok ? 'token' : key ? 'whole' : 'size',
      tokenName: firstTok,
      prefix: tokIdx >= 0 ? raw.slice(0, tokIdx) : '',
      suffix: tokIdx >= 0 ? raw.slice(tokIdx + firstTok.length) : '',
      kind,
      label,
      hint,
      tone,
      suggestRole,
      loraCount,
      // ── 分辨率相关 ──
      sizeNode: isSizeNode,
      sizeKeys: size.keys,
      sizeJsonKeys: size.jsonKeys,
      sizeValues: size.values.slice(0, 6),
      hasSizeToken: size.hasToken,
      sizeTokenCount: size.sizeTokenCount,
    });
  }
  return out;
}

export function detectTokens(workflow) {
  const json = JSON.stringify(workflow);
  return {
    positive: (json.match(/%prompt%/g) || []).length,
    negative: (json.match(/%negative_prompt%/g) || []).length,
    width: (json.match(/%width%/g) || []).length,
    height: (json.match(/%height%/g) || []).length,
  };
}

/**
 * 找出所有「会写出图片文件」的节点。
 * 判定：有 images 输入（连线），且 类名像保存/预览 或 有 filename_prefix 参数。
 * 这样可以把 AaaliceImagePicker 之类的交互选择器排除掉（它也有 images 输入但不写文件）。
 */
const OUTPUT_CLASS_RE = /(save|preview|export|write|dump)/i;

export function scanOutputNodes(workflow) {
  const out = [];
  for (const [id, node] of Object.entries(workflow || {})) {
    const inputs = node?.inputs || {};
    if (!Array.isArray(inputs.images)) continue;
    const cls = node.class_type || '';
    if (!OUTPUT_CLASS_RE.test(cls) && !('filename_prefix' in inputs)) continue;
    const isPreview = /preview/i.test(cls);
    out.push({
      id,
      classType: cls,
      title: node?._meta?.title || node?.title || '',
      prefix: inputs.filename_prefix ?? '(默认)',
      isPreview,
      enabled: typeof inputs.enabled === 'boolean' ? inputs.enabled : null,
      hint: isPreview ? '预览图（写到 ComfyUI 临时目录）' : '保存到 ComfyUI 输出目录',
    });
  }
  // 真正的保存节点排前面，预览节点排后面，方便「只保留第一个」
  return out.sort((a, b) => Number(a.isPreview) - Number(b.isPreview));
}

/**
 * 默认勾选哪一个输出节点：优先标准 SaveImage，其次任意保存节点，最后才退回预览节点。
 * 只返回一个 id；保存/预览节点都没有时返回空数组。
 */
function pickDefaultOutputIds(outputs) {
  if (!outputs || !outputs.length) return [];
  const pick = outputs.find((o) => /^saveimage$/i.test(String(o.classType || '')))
    || outputs.find((o) => !o.isPreview)
    || outputs[0];
  return pick ? [String(pick.id)] : [];
}

export function defaultOutputIds(workflow) {
  return pickDefaultOutputIds(scanOutputNodes(workflow));
}

/**
 * 分析输出节点，并算出「保留哪一个能删掉最多其它输出节点」。
 * 例如某工作流有 [预览→保存, 条件保存] 时，保留「条件保存」可以把另外两个一起删掉，就只出一张。
 */
export function analyzeOutputs(workflow) {
  const outputs = scanOutputNodes(workflow);
  let suggested = null;
  if (outputs.length > 1) {
    for (const o of outputs) {
      if (o.isPreview && outputs.some((x) => !x.isPreview)) continue; // 优先选真正的保存节点
      const drop = outputs.map((x) => x.id).filter((id) => id !== o.id);
      const { removed, blocked } = pruneNodes(workflow, drop);
      const score = removed.length;
      if (!suggested || score > suggested.score) {
        suggested = { id: o.id, score, removable: removed, blocked: blocked.map((b) => b.id) };
      }
    }
    for (const o of outputs) {
      const drop = outputs.map((x) => x.id).filter((id) => id !== o.id);
      const { removed } = pruneNodes(workflow, drop);
      o.pruneScore = removed.length;
    }
  }
  return { outputs, suggestedKeep: suggested, defaultOutputIds: pickDefaultOutputIds(outputs) };
}

/** sourceId -> Set(依赖它的节点 id) */
function buildDependents(workflow) {
  const deps = new Map();
  const add = (src, nodeId) => {
    if (!deps.has(src)) deps.set(src, new Set());
    deps.get(src).add(nodeId);
  };
  const walk = (v, nodeId) => {
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') {
        add(v[0], nodeId);
        return;
      }
      v.forEach((x) => walk(x, nodeId));
      return;
    }
    if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, nodeId));
  };
  for (const [nodeId, node] of Object.entries(workflow || {})) walk(node?.inputs, nodeId);
  return deps;
}

/**
 * 只保留从输出节点沿输入连线能走到的节点。
 * ComfyUI 会校验 prompt 里的所有节点，像导出的 UI 图里常见的孤立 KSampler
 * （没有 model/positive/negative/latent 连线）会让整张工作流被拒；
 * 这些节点本来就不会出图，提交前删掉最安全。
 */
export function pruneUnreachable(workflow, keepIds = []) {
  const wf = structuredClone(workflow);
  const keep = (keepIds || []).map(String).filter((id) => wf[id]);
  if (!keep.length) return { workflow: wf, removed: [] };
  const reachable = new Set();
  const stack = [...keep];
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id) || !wf[id]) continue;
    reachable.add(id);
    for (const value of Object.values(wf[id].inputs || {})) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const src = String(value[0]);
      if (wf[src] && !reachable.has(src)) stack.push(src);
    }
  }
  const removed = Object.keys(wf).filter((id) => !reachable.has(id));
  for (const id of removed) delete wf[id];
  return { workflow: wf, removed };
}

/**
 * 从工作流里删掉指定节点。
 * 只会真删「删掉之后在剩余图里没有任何下游依赖」的节点；有下游的会被跳过并记进 blocked。
 * 保存/预览类节点通常是终点，可以安全删除。
 */
export function pruneNodes(workflow, removeIds = []) {
  const wf = structuredClone(workflow);
  const pending = new Set((removeIds || []).filter((id) => wf[id]));
  const removed = [];
  let changed = true;
  while (changed) {
    changed = false;
    const deps = buildDependents(wf);
    for (const id of [...pending]) {
      if (!wf[id]) {
        pending.delete(id);
        continue;
      }
      const live = [...(deps.get(id) || [])].filter((x) => !pending.has(x) && wf[x]);
      if (!live.length) {
        delete wf[id];
        pending.delete(id);
        removed.push(id);
        changed = true;
      }
    }
  }
  const deps = buildDependents(wf);
  const blocked = [...pending]
    .filter((id) => wf[id])
    .map((id) => ({
      id,
      classType: wf[id]?.class_type || '',
      dependents: [...(deps.get(id) || [])],
    }));
  return { workflow: wf, removed, blocked };
}

/** 递归遍历任意 JSON 结构里的字符串 */
function walkStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn);
    return out;
  }
  return value;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  return String(hay).split(needle).length - 1;
}

/**
 * 生成真正提交给 ComfyUI 的工作流。
 *
 * ★ 统一规则（只有这一条，不会打架）：
 *
 *   占位符是唯一的分割点。
 *   - 节点文本里写了 %prompt% / %negative_prompt%  →  **只替换这个 token 本身**，
 *     它前后的一切文字原样保留，天然可以当前缀 / 后缀。
 *         例： "masterpiece, %prompt%, best quality"
 *          →   "masterpiece, 1girl silver hair, best quality"
 *     token 出现几次就替换几次。
 *   - 节点文本里没有任何 token  →  该节点归「节点映射」管：
 *         映射为正面/负面且值非空  →  整段文本替换（因为节点里没有分割点可用）
 *         映射为正面/负面但值为空  →  该节点原封不动，保留工作流原有参数
 *
 *   ★ 同一个节点既有 token 又被映射时：token 优先，映射不再整段覆盖。
 *     （这正是为了修掉「明明插了 %prompt% 却被整段替换、前后缀丢失」的问题）
 *
 * tokenEmpty = 'blank'（默认）：值为空时把 token 替换成空字符串
 * tokenEmpty = 'keep'        ：值为空时 token 原样保留，该节点完全不动
 */
export function applyOverrides(
  workflow,
  { positive = '', negative = '', mapping = {}, tokenEmpty = 'blank', randomSeed = true, loraState = null, size = null, sizeSource = '' } = {},
) {
  let wf = structuredClone(workflow);
  const report = {
    positiveApplied: false,
    negativeApplied: false,
    positiveTokenCount: 0,
    negativeTokenCount: 0,
    tokenEmptyPolicy: tokenEmpty,
    nodes: [],
    seeds: [],
    skipped: [],
    lora: null,
    size: null,
    warning: null,
  };

  const pos = String(positive ?? '').trim();
  const neg = String(negative ?? '').trim();
  const valueOf = (role) => (role === 'positive' ? pos : neg);
  const labelOf = (role) => (role === 'positive' ? '正面提示词' : '负面提示词');
  const tokenRole = { [POSITIVE_TOKEN]: 'positive', [NEGATIVE_TOKEN]: 'negative' };
  const tokenized = new Set();

  /* ── 第 1 步：占位符（优先级最高，只动 token 本身） ── */
  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object') continue;
    const key = firstTextKey(node);
    const beforeText = key ? String(node.inputs[key]) : null;
    const present = [POSITIVE_TOKEN, NEGATIVE_TOKEN].filter((t) => JSON.stringify(node).includes(t));
    if (!present.length) continue;

    tokenized.add(nodeId);
    const firstRole = tokenRole[present[0]];

    const plan = {};
    for (const t of present) {
      const role = tokenRole[t];
      const value = valueOf(role);
      if (!value && tokenEmpty === 'keep') {
        plan[t] = null;
        report.skipped.push({ nodeId, role, token: t, reason: `${labelOf(role)}为空且策略为 keep → 占位符原样保留` });
      } else {
        plan[t] = value;
        if (!value) report.skipped.push({ nodeId, role, token: t, reason: `${labelOf(role)}为空 → 占位符被替换成空字符串` });
      }
    }

    const counted = {};
    const afterNode = walkStrings(node, (s) => {
      let r = s;
      for (const t of present) {
        if (plan[t] === null || !r.includes(t)) continue;
        counted[t] = (counted[t] || 0) + countOccurrences(r, t);
        r = r.split(t).join(plan[t]);
      }
      return r;
    });
    wf[nodeId] = afterNode;

    const posCount = counted[POSITIVE_TOKEN] || 0;
    const negCount = counted[NEGATIVE_TOKEN] || 0;
    report.positiveTokenCount += posCount;
    report.negativeTokenCount += negCount;
    if (posCount && pos) report.positiveApplied = true;
    if (negCount && neg) report.negativeApplied = true;

    let prefix = '';
    let suffix = '';
    if (beforeText !== null) {
      const idx = beforeText.indexOf(present[0]);
      if (idx >= 0) {
        prefix = beforeText.slice(0, idx);
        suffix = beforeText.slice(idx + present[0].length);
      }
    }

    report.nodes.push({
      nodeId,
      classType: node.class_type,
      title: node?._meta?.title || node?.title || '',
      inputKey: key,
      role: firstRole,
      mode: 'token',
      tokens: present,
      before: beforeText,
      after: key ? String(afterNode.inputs[key]) : null,
      prefix,
      suffix,
      applied: posCount + negCount > 0,
      reason: `只替换 ${present.join(' 和 ')}，前后文字保留`,
    });
  }

  /* ── 第 2 步：节点映射（只管没有占位符的节点） ── */
  for (const [nodeId, role] of Object.entries(mapping || {})) {
    if (role !== 'positive' && role !== 'negative') continue;
    const node = wf[nodeId];
    if (!node) {
      report.skipped.push({ nodeId, role, reason: `映射的节点 #${nodeId} 不存在于工作流里` });
      continue;
    }
    const keys = textKeysForMapping(node);
    if (!keys.length) {
      report.skipped.push({ nodeId, role, reason: `节点 #${nodeId} 没有可覆盖的文本输入` });
      continue;
    }
    if (tokenized.has(nodeId)) {
      report.skipped.push({
        nodeId,
        role,
        reason: `节点 #${nodeId} 含占位符 → 已按「只替换占位符、前后固定文字保留」处理；映射的整段替换自动让位（想整段替换请把该节点的占位符删掉）`,
      });
      continue;
    }

    const before = String(node.inputs[keys[0]]);
    const value = valueOf(role);
    if (!value) {
      report.skipped.push({ nodeId, role, reason: `节点 #${nodeId}：${labelOf(role)}为空 → 保留工作流原有文本` });
      report.nodes.push({
        nodeId,
        classType: node.class_type,
        title: node?._meta?.title || node?.title || '',
        inputKey: keys[0],
        inputKeys: keys,
        role,
        mode: 'keep',
        before,
        after: before,
        prefix: '',
        suffix: '',
        applied: false,
        reason: '覆盖值为空，节点原封不动',
      });
      continue;
    }

    for (const k of keys) node.inputs[k] = value;
    report.nodes.push({
      nodeId,
      classType: node.class_type,
      title: node?._meta?.title || node?.title || '',
      inputKey: keys[0],
      inputKeys: keys,
      role,
      mode: 'whole',
      before,
      after: value,
      prefix: '',
      suffix: '',
      applied: true,
      reason: keys.length > 1
        ? `节点内无占位符 → ${keys.join(' / ')} 一起被替换`
        : '节点内无占位符 → 整段文本被替换',
    });
    if (role === 'positive') report.positiveApplied = true;
    else report.negativeApplied = true;
  }

  /* ── 第 2.5 步：分辨率 ──
   * 两条路都走这里：
   *   ① 工作流里写了 %width% / %height%（和 %prompt% 一样是**全局**替换，不用映射）——
   *      整格只有这一个占位符时写进去的是**数字**（width/height 这类输入要 number，塞字符串 ComfyUI 会拒单）
   *   ② 节点被映射成「分辨率」：写 inputs.width/height，并把节点里 JSON 字符串中的
   *      width/height 一并改掉（正好覆盖 ResolutionPreset 的 resolution_json，工作流一个字都不用改）
   * 没有可用分辨率时占位符原样留着，记进 report.size.leftover，由调用方在提交前拦下来
   * （比等 ComfyUI 抛类型错清楚得多）。
   */
  const sizeW = size && Number(size.w) > 0 && Number.isFinite(Number(size.w)) ? Math.round(Number(size.w)) : null;
  const sizeH = size && Number(size.h) > 0 && Number.isFinite(Number(size.h)) ? Math.round(Number(size.h)) : null;
  const hasSize = sizeW !== null && sizeH !== null;
  report.size = {
    requested: hasSize ? { w: sizeW, h: sizeH } : null,
    source: sizeSource || '',
    applied: false,
    matched: 0,
    writes: [],
    tokens: { width: 0, height: 0 },
    leftover: [],
    skipped: [],
  };

  const tokenFieldsOf = (value, prefix = '') => {
    const out = [];
    if (typeof value === 'string') {
      for (const t of SIZE_TOKENS) if (value.includes(t)) out.push({ field: prefix || '(本身)', token: t });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => out.push(...tokenFieldsOf(v, `${prefix}[${i}]`)));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) out.push(...tokenFieldsOf(v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  };

  for (const [nodeId, role] of Object.entries(mapping || {})) {
    if (role === 'size' && !wf[nodeId]) {
      report.skipped.push({ nodeId, role, reason: `映射的节点 #${nodeId} 不存在于工作流里` });
      report.size.skipped.push({ nodeId, field: '', reason: '节点不存在' });
    }
  }

  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    const mapped = (mapping || {})[nodeId] === 'size';
    const beforeJson = JSON.stringify(node.inputs);
    const present = SIZE_TOKENS.filter((t) => beforeJson.includes(t));
    if (!present.length && !mapped) continue;

    const beforeW = countOccurrences(beforeJson, WIDTH_TOKEN);
    const beforeH = countOccurrences(beforeJson, HEIGHT_TOKEN);
    const title = node?._meta?.title || node?.title || '';
    let cur = node;

    // ① 占位符
    if (present.length) {
      const want = { [WIDTH_TOKEN]: sizeW, [HEIGHT_TOKEN]: sizeH };
      cur = walkStrings(node, (s) => {
        let r = s;
        for (const t of present) {
          const v = want[t];
          if (v === null || typeof r !== 'string') break;
          if (r.trim() === t) {
            r = v; // 整格就是占位符 → 写数字（width/height 这类输入要 number）
            continue;
          }
          if (!r.includes(t)) continue;
          // JSON 里写成 "width":"%width%" 的，替换成**裸数字**（否则节点拿到的是字符串）
          const quoted = `"${t}"`;
          if (r.includes(quoted)) r = r.split(quoted).join(String(v));
          r = r.split(t).join(String(v));
        }
        return r;
      });
      wf[nodeId] = cur;
    }

    // ② 「分辨率」映射：数值输入 + JSON 字符串里的 width/height
    if (mapped) {
      for (const k of SIZE_INPUT_KEYS) {
        const v = cur.inputs[k];
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          report.size.skipped.push({ nodeId, field: k, reason: '这一格是连线（跟着上游节点走），没有写' });
          continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          report.size.skipped.push({ nodeId, field: k, reason: '这一格不是数字，没有写' });
          continue;
        }
        const w2 = k === 'width' ? sizeW : sizeH;
        if (w2 === null) {
          report.size.skipped.push({ nodeId, field: k, reason: '没有可用分辨率 → 保持原值' });
          continue;
        }
        if (v !== w2) {
          cur.inputs[k] = w2;
          report.size.writes.push({ nodeId, field: k, before: v, after: w2 });
        } else {
          // 已经是目标值：没东西可写，但这说明分辨率**确实被接管了**
          report.size.matched += 1;
        }
      }
      for (const [fk, fv] of Object.entries(cur.inputs)) {
        if (typeof fv !== 'string' || !fv.trim().startsWith('{') || !hasSize) continue;
        let parsed;
        try {
          parsed = JSON.parse(fv);
        } catch {
          continue;
        }
        const hits = jsonSizePaths(parsed);
        if (!hits.length) continue;
        let changed = 0;
        const walk = (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (SIZE_INPUT_KEYS.includes(k) && typeof v === 'number' && Number.isFinite(v)) {
              const w2 = k === 'width' ? sizeW : sizeH;
              if (w2 !== null) {
                if (v !== w2) {
                  obj[k] = w2;
                  changed += 1;
                  report.size.writes.push({ nodeId, field: `${fk}.${k}`, before: v, after: w2 });
                } else {
                  report.size.matched += 1;
                }
              }
            } else if (v && typeof v === 'object') {
              walk(v);
            }
          }
        };
        walk(parsed);
        if (changed) cur.inputs[fk] = JSON.stringify(parsed);
      }
    }

    const afterJson = JSON.stringify(cur.inputs);
    const afterW = countOccurrences(afterJson, WIDTH_TOKEN);
    const afterH = countOccurrences(afterJson, HEIGHT_TOKEN);
    report.size.tokens.width += Math.max(0, beforeW - afterW);
    report.size.tokens.height += Math.max(0, beforeH - afterH);
    for (const l of tokenFieldsOf(cur.inputs)) {
      report.size.leftover.push({ nodeId, classType: cur.class_type || '', title, field: l.field, token: l.token });
    }
  }

  report.size.applied = report.size.writes.length > 0 || report.size.tokens.width + report.size.tokens.height > 0;
  // inEffect：分辨率这次**确实生效了**（写过，或者本来就已经是目标值）。
  // applied 只表示「改动了什么」，两者分开，免得「已经对了」被显示成「没有可用值」。
  report.size.inEffect = report.size.applied || report.size.matched > 0;
  if (report.size.leftover.length) {
    const where = [...new Set(report.size.leftover.map((l) => `#${l.nodeId}${l.field !== '(本身)' ? '.' + l.field : ''}`))].slice(0, 6);
    report.skipped.push({
      nodeId: report.size.leftover.map((l) => l.nodeId).join(', '),
      role: 'size',
      reason: `工作流里还有 ${report.size.leftover.length} 处 %width%/%height% 没被替换（这次没有可用分辨率）：${where.join('、')}`,
    });
  }

  /* ── 第 3 步：随机种子 ──
   * ComfyUI 的「control_after_generate」（随机/递增）只存在于 **UI 工作流格式**里，
   * API 格式没有这个概念 —— 走 /prompt 提交时 seed 就是原样使用。
   * 所以工作流里那个写死的 seed 会让同一提示词每次都出同一张图。
   * 这里只动「采样/噪声类节点上、值为字面量数字」的 seed / noise_seed；
   * 值是链接（数组，例如 [节点, 槽位]）时不动，那是别的节点在提供种子。
   */
  if (randomSeed) {
    for (const [nodeId, node] of Object.entries(wf)) {
      if (!node || typeof node !== 'object' || !node.inputs) continue;
      if (!SEED_NODE_RE.test(String(node.class_type || ''))) continue;
      for (const key of Object.keys(node.inputs)) {
        if (key !== 'seed' && key !== 'noise_seed' && key !== 'rand_seed') continue;
        const before = node.inputs[key];
        if (typeof before !== 'number' || !Number.isFinite(before)) continue;
        const after = randomSeedValue();
        node.inputs[key] = after;
        report.seeds.push({
          nodeId,
          classType: node.class_type,
          title: node?._meta?.title || node?.title || '',
          inputKey: key,
          before,
          after,
        });
      }
    }
  }

  /* ── 第 4 步：LoRA 开关 ──
   * 开关状态存在工作流记录的 loraState 里（不是写进工作流 JSON），出图这一刻才铺上去。
   * loraState 为 null / 没提到的 LoRA 堆 → 一个字节都不动。
   */
  if (loraState && typeof loraState === 'object') {
    const { workflow: withLora, report: loraReport } = applyLoraState(wf, loraState);
    wf = withLora;
    report.lora = loraReport;
    for (const w of loraReport.warnings || []) report.skipped.push({ nodeId: '', role: 'lora', reason: w });
  }

  report.warning =
    !report.positiveApplied && !report.negativeApplied
      ? '没有任何提示词被注入：工作流里既没有 %prompt% / %negative_prompt% 占位符，也没有有效的节点映射。'
      : null;

  return { workflow: wf, report };
}

async function comfyFetch(baseUrl, endpoint, options = {}, timeoutMs = 30000) {
  const url = joinUrl(baseUrl, endpoint);
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    return res;
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new HttpError(504, `ComfyUI 请求超时: ${url}`);
    }
    throw new HttpError(502, `无法连接 ComfyUI (${url}): ${e.message}`);
  }
}

export async function comfyStatus(baseUrl) {
  const out = { ok: false, baseUrl, error: null, system: null, queue: null };
  try {
    const res = await comfyFetch(baseUrl, 'system_stats', {}, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sys = await res.json();
    out.system = {
      comfyuiVersion: sys?.system?.comfyui_version || sys?.system?.comfyui_version_str || null,
      pythonVersion: sys?.system?.python_version || null,
      devices: (sys?.devices || []).map((d) => ({
        name: d.name,
        type: d.type,
        vramTotal: d.vram_total,
        vramFree: d.vram_free,
      })),
    };
    const q = await (await comfyFetch(baseUrl, 'queue', {}, 8000)).json();
    out.queue = {
      running: (q?.queue_running || []).length,
      pending: (q?.queue_pending || []).length,
    };
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

export async function queuePrompt(baseUrl, workflow, clientId) {
  const res = await comfyFetch(
    baseUrl,
    'prompt',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    },
    60000,
  );
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, `ComfyUI /prompt 返回非 JSON: ${text.slice(0, 400)}`);
  }
  if (!res.ok || data.error) {
    const err = data.error || {};
    const nodeErrors = data.node_errors || {};
    const detail = Object.entries(nodeErrors)
      .map(([id, v]) => `节点#${id} ${v?.class_type || ''}: ${(v?.errors || []).map((e) => `${e.message}${e.details ? ` (${e.details})` : ''}`).join('; ')}`)
      .join(' | ');
    throw new HttpError(
      502,
      `ComfyUI 拒绝该工作流: ${err.message || res.status}${err.details ? ` - ${err.details}` : ''}${detail ? ` | ${detail}` : ''}`,
    );
  }
  return { promptId: data.prompt_id, number: data.number, nodeErrors: data.node_errors || null };
}

export function extractImagesFromHistory(entry) {
  const images = [];
  for (const [nodeId, output] of Object.entries(entry?.outputs || {})) {
    for (const key of ['images', 'gifs']) {
      for (const img of output?.[key] || []) {
        if (!img?.filename) continue;
        images.push({
          nodeId,
          filename: img.filename,
          subfolder: img.subfolder || '',
          type: img.type || 'output',
          kind: key === 'gifs' ? 'gif' : 'image',
        });
      }
    }
  }
  return images;
}

function historyError(entry) {
  const st = entry?.status || {};
  if (st.status_str !== 'error' && st.completed !== false) {
    if (st.status_str !== 'error') return null;
  }
  if (st.status_str !== 'error') return null;
  const msgs = (st.messages || [])
    .map((m) => {
      const info = Array.isArray(m) ? m[1] : m;
      if (!info) return '';
      return [info.node_type && `[${info.node_type}#${info.node_id}]`, info.exception_type, info.exception_message, info.traceback?.[0]]
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean);
  return msgs.join(' | ') || 'ComfyUI 执行失败（无详细信息）';
}

export async function waitForResult(baseUrl, promptId, { timeoutMs = 300000, pollIntervalMs = 1200, onTick, signal } = {}) {
  const deadline = Date.now() + Math.max(5000, timeoutMs);
  let lastTick = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new HttpError(499, '请求已被终止');
    const res = await comfyFetch(baseUrl, `history/${encodeURIComponent(promptId)}`, {}, 20000);
    if (res.ok) {
      const data = await res.json();
      const entry = data?.[promptId];
      if (entry) {
        const err = historyError(entry);
        if (err) throw new HttpError(502, `ComfyUI 执行出错: ${err}`);
        const images = extractImagesFromHistory(entry);
        if (images.length) return { images, entry };
        // 执行完成但没有图片
        const st = entry?.status || {};
        if (st.completed === true || st.status_str === 'success') {
          throw new HttpError(502, 'ComfyUI 执行完成但没有产出图片，请检查工作流是否包含 SaveImage 节点。');
        }
      }
    }
    if (onTick && Date.now() - lastTick > 4000) {
      lastTick = Date.now();
      try {
        onTick();
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new HttpError(504, `等待 ComfyUI 出图超时（${Math.round(timeoutMs / 1000)}s），promptId=${promptId}`);
}

export function viewUrl(baseUrl, img) {
  const params = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || '',
    type: img.type || 'output',
  });
  return `${joinUrl(baseUrl, 'view')}?${params.toString()}`;
}

export async function fetchImage(baseUrl, img, { timeoutMs = 60000 } = {}) {
  const res = await comfyFetch(baseUrl, `view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' }).toString()}`, {}, timeoutMs);
  if (!res.ok) throw new HttpError(502, `下载图片失败 ${res.status}: ${img.filename}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || 'image/png' };
}

export function saveImageToDisk({ buffer, dir, fileName, prefix }) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(fileName) || '.png';
  const base = sanitizeName(path.basename(fileName, ext), 'image');
  const finalName = `${sanitizeName(prefix, 'art')}_${base}${ext}`;
  let full = path.join(dir, finalName);
  if (fs.existsSync(full)) {
    full = path.join(dir, `${sanitizeName(prefix, 'art')}_${base}_${uid().slice(0, 6)}${ext}`);
  }
  fs.writeFileSync(full, buffer);
  return full;
}

/** 打断 ComfyUI 当前正在跑的任务（「终止」用；对已结束的任务调用是安全的）。 */
export async function interrupt(baseUrl, { timeoutMs = 8000 } = {}) {
  try {
    const res = await comfyFetch(baseUrl, 'interrupt', { method: 'POST' }, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}
