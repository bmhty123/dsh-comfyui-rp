/**
 * 匹配规则（提示词格式解析）。
 *
 * ★ 三套匹配方式：
 *   · contract_v2 —— DSH 会话按「标题行 + size 行 + ```text 块」交付；
 *   · all_text    —— 整条助手回复原样作为正面提示词；
 *   · custom_tags —— 标题 / 原文 / 尺寸 / 正面 / 负面五个可配置闭合标签，顺序读最多 3 套。
 *
 * ★ 规则注册表是开放的：以后要加规则，只要在 RULES 里追加一条
 *   { id, label, description, parse(raw, options) }，前端下拉就会多一项。
 *
 * 规则应当返回统一的形状：
 *   {
 *     ruleId, ok, nonDelivery, hasFence, issues: string[],
 *     sets: [{ title, anchor, size:{w,h}|null, tok, seed, tags, nl, positive, negative, raw, issues }]
 *   }
 *   - nonDelivery = true 表示这压根不是一条交付消息（闲聊 / 提问 / 解释），调用方应报错而不是出图。
 *   - issues 是「写歪了但还认」的逐条提醒，不阻断出图。
 */

/* --------------------------- v2.0 的字符与行规则 --------------------------- */

/** 圈码序号 ①..⑳（U+2460..U+246F） */
const CIRCLE_RE = /^[\u2460-\u246f]/;
/** v2 标题行：整行 = 圈码 + 幕名，幕名里不许有空格 / 竖线 */
const TITLE_STRICT = /^([\u2460-\u246f])([^ \t｜|]+)$/;
/** 宽容标题行：容忍「① 幕名」这种圈码后带空格的写法（会记一条 issue） */
const TITLE_LOOSE = /^([\u2460-\u246f])[ \t\u3000]+(.+)$/;
/** 元数据行：`key: value`（半角/全角冒号都认；`原文` 是 anchor 的中文别名） */
const META_RE = /^([A-Za-z_][A-Za-z0-9_-]*|原文)\s*([:：])\s*(.+)$/;
/** v2 元数据白名单；anchor 是可选的「原文锚点」，用来在会话里定位这一套图。 */
const META_KEYS = ['size', 'tok', 'seed', 'anchor'];
/** size 的值：宽x高（半角小写 x 是契约写法，× 和大写 X 也认，记 issue） */
const SIZE_RE = /^(\d{3,4})\s*[xX×]\s*(\d{3,4})$/;
/** 开围栏：任意语言标记（严格应是 text） */
const FENCE_OPEN_RE = /^```([A-Za-z0-9_-]*)\s*$/;
/** 闭围栏：恰好三个反引号（允许行尾空白） */
const FENCE_CLOSE_RE = /^```\s*$/;
/** 空行（含只有空格 / 全角空格的） */
const BLANK_RE = /^[ \t\u3000]*$/;
/** 中日文字符，用来提示「tag / NL 里混了中文」 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const stripZeroWidth = (s) => String(s ?? '').replace(/[\u200b-\u200f\ufeff]/g, '');

/** 从一行里认出标题；认不出返回 null。 */
function readTitle(line) {
  const raw = stripZeroWidth(line).trim();
  if (!raw) return null;
  // 容忍 markdown 的加粗 / 标题 / 引用标记，但记 issue
  let s = raw.replace(/^[*#>\s]+/, '').replace(/[*\s]+$/, '');
  const strict = TITLE_STRICT.test(s);
  const m = strict ? s.match(TITLE_STRICT) : s.match(TITLE_LOOSE);
  if (!m) return null;
  const name = m[2]
    .replace(/^[*_`\s]+|[*_`\s]+$/g, '')
    .replace(/[：:。，,.;；]+$/g, '')
    .trim();
  return { raw, name, strict, circle: m[1] };
}

/** 一段文字是不是「元数据行」；是的话返回 { key, value, fullWidthColon }。 */
function readMeta(line) {
  const s = stripZeroWidth(line).trim();
  if (!s) return null;
  const m = s.match(META_RE);
  if (!m) return null;
  const rawKey = m[1];
  // `原文` 是 anchor 的中文别名；大小写也放宽（ANCHOR / Size 都认）。
  const key = rawKey === '原文' ? 'anchor' : rawKey.toLowerCase();
  return {
    key,
    value: m[3].trim(),
    // 中文「原文：」是刻意放宽的写法，不再提示全角冒号；其它字段仍提示。
    fullWidthColon: m[2] === '：' && rawKey !== '原文',
    raw: s,
  };
}

function isFenceOpen(line) {
  return FENCE_OPEN_RE.test(stripZeroWidth(line).trim());
}

function isFenceClose(line) {
  return FENCE_CLOSE_RE.test(stripZeroWidth(line).trim());
}

/** tag 段归一：分隔符恒为 ", "，去掉行尾句号/逗号。 */
function normalizeTags(text, issues) {
  let s = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  const out = s.replace(/[.,;，。；]+$/, '');
  if (out !== s) issues.push('tag 行末尾带了句号 / 逗号（契约：行尾不带）');
  s = out;
  if (CJK_RE.test(s)) issues.push('tag 行里混进了中文');
  return s;
}

/** 原文锚点：压成一行、去掉首尾空白；超过 200 字截断，避免把整段正文塞进图片记录。 */
function cleanAnchor(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 解析 size / tok / seed / anchor；只报警，不阻断。 */
function readMetaValues(meta, issues) {
  let size = null;
  if (meta.size === undefined) {
    issues.push('缺 size 行（契约 v2.0 必填；桥会退回到手填分辨率）');
  } else {
    const m = String(meta.size).match(SIZE_RE);
    if (!m) {
      issues.push(`size 的值「${meta.size}」不符合 \`宽x高\``);
    } else {
      const w = Number(m[1]);
      const h = Number(m[2]);
      size = { w, h };
      if (w % 8 || h % 8) issues.push(`size ${w}x${h} 的宽高不是 8 的倍数`);
      const mp = (w * h) / 1e6;
      if (mp < 0.9 || mp > 1.4) issues.push(`size ${w}x${h} 总像素 ${mp.toFixed(2)}MP 不在 0.9–1.4MP 内`);
      const ratio = w / h;
      if (ratio < 0.5 || ratio > 2) issues.push(`size ${w}x${h} 长宽比 ${ratio.toFixed(2)} 不在 0.5–2.0 内`);
    }
  }
  let tok = null;
  if (meta.tok !== undefined) {
    if (/^\d+\s*\/\s*\d+$/.test(String(meta.tok))) tok = String(meta.tok).replace(/\s+/g, '');
    else issues.push(`tok 的值「${meta.tok}」不符合 \`n/m\``);
  }
  let seed = null;
  if (meta.seed !== undefined) {
    if (/^\d{1,20}$/.test(String(meta.seed))) seed = Number(meta.seed);
    else issues.push(`seed 的值「${meta.seed}」不是 1–20 位正整数`);
  }
  const anchor = cleanAnchor(meta.anchor);
  return { size, tok, seed, anchor };
}

/** 块体 → { tags, nl, issues }。块内第一个空行是 tag / NL 的分界。 */
function splitBody(bodyLines, issues) {
  let lo = 0;
  let hi = bodyLines.length;
  while (lo < hi && BLANK_RE.test(bodyLines[lo])) lo += 1;
  while (hi > lo && BLANK_RE.test(bodyLines[hi - 1])) hi -= 1;
  const body = bodyLines.slice(lo, hi);
  const sep = body.findIndex((l) => BLANK_RE.test(l));
  if (sep < 0) {
    issues.push('块里没有「空行」把 tag 行和 NL 段分开（契约要求恰好一个空行）');
    return { tags: normalizeTags(body.join('\n'), issues), nl: '', body };
  }
  if (sep > 1) issues.push('tag 段占了不止一行（契约要求压成一行）');
  const tags = normalizeTags(body.slice(0, sep).join('\n'), issues);
  const nlLines = body.slice(sep + 1);
  const nl = nlLines.join('\n').trim();
  if (!nl) issues.push('空行后面没有 NL 段');
  if (nlLines.some((l) => BLANK_RE.test(l))) issues.push('NL 段里还有空行（契约要求段内不再出现空行）');
  if (nl && !/[.!?。！？]$/.test(nl)) issues.push('NL 段没有以英文句号收尾');
  if (nl && CJK_RE.test(nl)) issues.push('NL 段里混进了中文');
  return { tags, nl, body };
}

/** tags + ". " + NL（契约硬口径） */
function joinPositive(tags, nl) {
  const t = String(tags || '').replace(/[.,;]+$/, '').trim();
  const n = String(nl || '').trim();
  if (!t) return n;
  return n ? `${t}. ${n}` : t;
}

/* --------------------------- all_text / custom_tags --------------------------- */

/** 自定义标签的默认闭合写法；成对写法会自动推出开标签。 */
export const DEFAULT_CUSTOM_TAGS = Object.freeze({
  title: '</标题>',
  anchor: '</原文>',
  size: '</尺寸>',
  positive: '</正面>',
  negative: '</负面>',
});

// 顺序字段仍是标题 → 尺寸 → 正面 → 负面；原文锚点单独扫，放尺寸前 / 后都能认。
const CUSTOM_FIELDS = ['title', 'size', 'positive', 'negative'];
const CUSTOM_PAIR_FIELDS = ['title', 'anchor', 'size', 'positive', 'negative'];
const CUSTOM_LABELS = {
  title: ['标题', '幕名', 'title'],
  anchor: ['原文锚点', '原文', '锚点', 'anchor'],
  size: ['尺寸size', '尺寸', '分辨率', 'size'],
  positive: ['正面提示词', '正面', 'positive', 'prompt'],
  negative: ['负面提示词', '负面', 'negative'],
};
const CUSTOM_FIELD_NAMES = { title: '标题', anchor: '原文', size: '尺寸', positive: '正面提示词', negative: '负面提示词' };

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把用户填的「闭合标签」变成可搜索的开 / 闭标签。
 *   </标题>    → <标题>    + </标题>
 *   [/title]   → [title]   + [/title]
 *   【/尺寸】  → 【尺寸】  + 【/尺寸】
 *   {{/正面}}  → {{正面}}  + {{/正面}}
 * 其它写法（例如 `---` 或 `标题结束`）只当字面闭合标记，开标签仍用「标题：/尺寸：」这类字段名。
 */
function customTagPair(raw, field) {
  const value = String(raw ?? '').trim() || DEFAULT_CUSTOM_TAGS[field];
  const pairs = [
    [/^<\s*\/\s*([^<>]+?)\s*>$/, (name) => `<${name}>`, (name) => `</${name}>`],
    [/^\[\[\s*\/\s*([^\[\]]+?)\s*\]\]$/, (name) => `[[${name}]]`, (name) => `[[/${name}]]`],
    [/^\[\s*\/\s*([^\[\]]+?)\s*\]$/, (name) => `[${name}]`, (name) => `[/${name}]`],
    [/^【\s*\/\s*([^【】]+?)\s*】$/, (name) => `【${name}】`, (name) => `【/${name}】`],
    [/^\{\{\s*\/\s*([^{}]+?)\s*\}\}$/, (name) => `{{${name}}}`, (name) => `{{/${name}}}`],
  ];
  for (const [re, makeOpen, makeClose] of pairs) {
    const m = value.match(re);
    if (m) {
      const name = m[1].trim();
      if (name) return { open: makeOpen(name), close: makeClose(name) };
    }
  }
  return { open: '', close: value };
}

function customLabelRe(field) {
  const names = CUSTOM_LABELS[field]
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  // 行首（或换行后）允许 markdown / 中文括号包一层，字段名后允许冒号。
  return new RegExp(
    `(?:^|\\n)[ \\t>*#_\`~\\-—【\\[（(]*[ \\t]*(?:${names})(?:[ \\t*_\`】\\]）)]*)[ \\t]*(?:[:：][ \\t]*|[ \\t]+|(?=\\n|$))`,
    'gi',
  );
}

/** 找某个字段的开标签 / 字段名；找不到返回 null。 */
function findCustomOpen(src, lower, field, from, limit, pairs) {
  const lo = Math.max(0, Number(from) || 0);
  const hi = Math.min(src.length, Number.isFinite(limit) ? limit : src.length);
  let best = null;
  const pair = pairs[field];
  if (pair.open) {
    const at = lower.indexOf(pair.open.toLowerCase(), lo);
    if (at >= 0 && at < hi && at + pair.open.length <= hi) {
      best = { index: at, end: at + pair.open.length, kind: 'tag' };
    }
  }
  const re = customLabelRe(field);
  re.lastIndex = lo;
  let m;
  while ((m = re.exec(src))) {
    const at = m.index;
    if (at >= hi) break;
    if (!best || at < best.index) {
      best = { index: at, end: at + m[0].length, kind: 'label' };
    }
    if (re.lastIndex <= at) re.lastIndex = at + 1;
  }
  return best;
}

function findCustomClose(lower, field, from, limit, pairs) {
  const close = pairs[field].close;
  if (!close) return null;
  const lo = Math.max(0, Number(from) || 0);
  const hi = Math.min(lower.length, Number.isFinite(limit) ? limit : lower.length);
  const at = lower.indexOf(close.toLowerCase(), lo);
  return at >= 0 && at < hi ? { index: at, end: at + close.length } : null;
}

/** 读一个字段：开标签 → 内容 → 闭合标签；缺闭合时退到下一个字段 / 下一组。 */
function readCustomField(src, lower, field, from, limit, fieldIndex, pairs, openOverride) {
  const open = openOverride || findCustomOpen(src, lower, field, from, limit, pairs);
  if (!open) return { text: '', next: from, missing: true, closed: false };
  let close = findCustomClose(lower, field, open.end, limit, pairs);
  let end;
  let next;
  let closed = false;
  if (close) {
    end = close.index;
    next = close.end;
    closed = true;
  } else {
    let fallback = null;
    for (let k = fieldIndex + 1; k < CUSTOM_FIELDS.length; k += 1) {
      const o = findCustomOpen(src, lower, CUSTOM_FIELDS[k], open.end, limit, pairs);
      if (o && (!fallback || o.index < fallback.index)) fallback = o;
    }
    // 下一组的标题也可能是本组的边界，但 limit 已经就是下一个标题的位置，
    // 所以这里只需要退到 limit —— 不能越过下一组。
    end = fallback ? fallback.index : limit;
    next = fallback ? fallback.index : limit;
  }
  const text = src.slice(open.end, end).replace(/\r/g, '').trim();
  return { text, next, missing: false, closed };
}

function cleanCustomTitle(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[*_`#>\s:：]+|[*_`\s]+$/g, '')
    .replace(/[：:。，,.;；]+$/g, '')
    .trim();
}

function parseSizeText(text) {
  const m = String(text || '').match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * 全部匹配：不解析任何结构，整条助手回复就是正面提示词。
 * 适合让桥会话自由输出、用户自己承担格式的场景。
 */
export function parseAllText(raw) {
  const text = stripZeroWidth(raw).replace(/\r\n?/g, '\n').trim();
  const empty = {
    ruleId: 'all_text', ok: false, nonDelivery: true, hasFence: false,
    issues: text ? [] : ['回复是空的'], sets: [], leftover: text,
  };
  if (!text) return empty;
  return {
    ruleId: 'all_text',
    ok: true,
    nonDelivery: false,
    hasFence: false,
    issues: [],
    sets: [{
      title: '全部回复',
      anchor: '',
      size: null,
      tok: null,
      seed: null,
      tags: '',
      nl: '',
      positive: text,
      negative: '',
      raw: text,
      strict: true,
      issues: [],
    }],
    leftover: '',
  };
}

/**
 * 自定义闭合标签：主字段按「标题 → 尺寸 → 正面 → 负面」顺序读，原文锚点单独扫（前后都可），最多 3 套。
 *
 * 每个字段都可以单独配闭合标签；如果写成成对形式（</标题>、[/title]、【/尺寸】），
 * 开标签会自动按同名推出，因此默认配置下直接认：
 *
 *   <标题>窗边读书</标题>
 *   <尺寸>1024x1024</尺寸>
 *   <正面>...</正面>
 *   <负面>...</负面>
 *
 * 如果只写 `---` / `标题结束` 这类字面闭合标记，开标签仍用「标题：/尺寸：/正面：/负面：」。
 */
export function parseCustomTags(raw, options = {}) {
  const src = stripZeroWidth(raw).replace(/\r\n?/g, '\n');
  const pairs = {};
  for (const field of CUSTOM_PAIR_FIELDS) pairs[field] = customTagPair(options?.customTags?.[field], field);
  const empty = {
    ruleId: 'custom_tags', ok: false, nonDelivery: false, hasFence: false,
    issues: [], sets: [], leftover: '',
  };
  if (!src.trim()) return { ...empty, nonDelivery: true };

  const lower = src.toLowerCase();
  const issues = [];
  const sets = [];
  let cursor = 0;
  let sawTitle = false;
  let overflow = false;

  while (sets.length < 3) {
    const titleOpen = findCustomOpen(src, lower, 'title', cursor, src.length, pairs);
    if (!titleOpen) break;
    sawTitle = true;
    const nextTitle = findCustomOpen(src, lower, 'title', titleOpen.end, src.length, pairs);
    const limit = nextTitle ? nextTitle.index : src.length;
    const here = [];
    const values = {};

    let pos = titleOpen.end;
    for (let i = 0; i < CUSTOM_FIELDS.length; i += 1) {
      const field = CUSTOM_FIELDS[i];
      const got = readCustomField(
        src, lower, field, pos, limit, i, pairs,
        field === 'title' ? titleOpen : null,
      );
      values[field] = got.text;
      if (got.missing) {
        here.push(`没有找到${CUSTOM_FIELD_NAMES[field]}的开标签（字段名或成对开标签均可）`);
      } else if (!got.closed) {
        here.push(`${CUSTOM_FIELD_NAMES[field]}没找到闭合标签「${pairs[field].close}」，已按下一个字段 / 下一组截断`);
      }
      pos = Math.max(pos, got.next);
    }

    // 原文锚点单独扫：无论它写在尺寸前还是尺寸后，都不会把尺寸字段挤掉。
    const anchorOpen = findCustomOpen(src, lower, 'anchor', titleOpen.end, limit, pairs);
    let anchor = '';
    if (anchorOpen) {
      const anchorClose = findCustomClose(lower, 'anchor', anchorOpen.end, limit, pairs);
      const anchorEnd = anchorClose ? anchorClose.index : limit;
      anchor = cleanAnchor(src.slice(anchorOpen.end, anchorEnd));
      if (!anchorClose) here.push(`${CUSTOM_FIELD_NAMES.anchor}没找到闭合标签「${pairs.anchor.close}」，已按下一组截断`);
    }

    const title = cleanCustomTitle(values.title) || `第 ${sets.length + 1} 套`;
    const size = parseSizeText(values.size);
    const positive = String(values.positive || '').replace(/\r/g, '').trim();
    const negative = String(values.negative || '').replace(/\r/g, '').trim();
    if (values.size && !size) here.push(`尺寸「${values.size.slice(0, 40)}」里没有宽x高，已退回手填分辨率`);
    if (!positive) here.push('正面提示词是空的，这一套没被采纳');

    if (positive) {
      sets.push({
        title,
        anchor,
        size,
        tok: null,
        seed: null,
        tags: '',
        nl: '',
        positive,
        negative,
        raw: [values.title, anchor, values.size, positive, negative].filter(Boolean).join('\n'),
        strict: here.length === 0,
        issues: here,
      });
      for (const msg of here) issues.push(`第 ${sets.length} 组：${msg}`);
    } else {
      for (const msg of here) issues.push(`未采纳的一组：${msg}`);
    }

    const nextCursor = Math.max(pos, limit, titleOpen.end + 1);
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
    if (sets.length >= 3 && findCustomOpen(src, lower, 'title', cursor, src.length, pairs)) {
      overflow = true;
      break;
    }
  }

  if (overflow) issues.push('找到了超过 3 套，按上限只取前 3 套');
  if (!sawTitle) {
    return {
      ...empty,
      nonDelivery: true,
      issues: issues.concat([`没有找到标题开标签「${pairs.title.open || '标题'}」`]),
      leftover: src.trim(),
    };
  }
  return {
    ruleId: 'custom_tags',
    ok: sets.length > 0,
    nonDelivery: false,
    hasFence: false,
    issues,
    sets,
    leftover: '',
  };
}

/* ------------------------------- contract_v2 ------------------------------- */

/**
 * contract_v2 —— 宽容匹配 + 逐条报警。
 *
 * 严格形态（契约 v2.0）：
 *
 *   ①幕名
 *   size: 832x1216
 *   ```text
 *   <tag 行>
 *
 *   <NL 段>
 *   ```
 *
 * 匹配步骤：
 *   1. 逐行找「圈码 ①–⑳ 开头的标题行」（允许 `① 幕名` 的写法，记 issue）；
 *   2. 标题后允许 0~N 行元数据（size / tok / seed），**也容忍夹空行**（记 issue）；
 *      契约要求元数据最后一行的下一行正好是围栏 —— 这里不硬失败，因为实际会话经常多一个空行；
 *   3. 找开围栏 ```text（写成 ```json / 裸 ``` 也认，记 issue）；
 *   4. 往后找闭围栏 ```（找不到就吃到下一组标题 / 文末，记 issue）；
 *   5. 块内按第一个空行切成 tag 段 / NL 段；
 *   6. positive = tag 行（归一成 ", " 分隔、去掉行尾标点）+ ". " + NL；
 *   7. 负面恒为空（契约不从交付消息里传负词）。
 *
 * 硬失败（nonDelivery = true）：整条回复里既没有标题行、也没有围栏 ——
 *   按契约属于「非交付消息」（提问 / 闲聊 / 解释 / 排查），调用方应当报错而不是出图。
 */
export function parseContractV2(raw) {
  const src = stripZeroWidth(raw).replace(/\r\n?/g, '\n');
  const empty = {
    ruleId: 'contract_v2', ok: false, nonDelivery: false, hasFence: false,
    issues: [], sets: [],
  };
  if (!src.trim()) return { ...empty, nonDelivery: true };

  const lines = src.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const used = new Array(lines.length).fill(false);
  const issues = [];
  const sets = [];
  let hasFence = false;
  let sawTitle = false;

  for (let i = 0; i < lines.length; i += 1) {
    const t = readTitle(lines[i]);
    if (!t) continue;
    sawTitle = true;

    const here = [];
    if (!t.strict) here.push(`标题行「${t.raw}」不符合 v2.0（圈码后面不能有空格）`);

    // ① 元数据行：允许 0~N 行；标题和元数据之间、元数据和围栏之间的空行都容忍
    const meta = {};
    let j = i + 1;
    while (j < lines.length) {
      if (BLANK_RE.test(lines[j])) {
        // 空行只跳过，不结束；但记一条（只在真正采纳这组时才带上）
        j += 1;
        continue;
      }
      const m = readMeta(lines[j]);
      if (!m) break;
      if (!META_KEYS.includes(m.key)) {
        here.push(`第 ${j - i} 行是表外元数据行「${m.raw}」——契约白名单只有 size / tok / seed / anchor`);
      } else if (meta[m.key] !== undefined) {
        here.push(`「${m.key}:」写了两遍`);
      } else {
        meta[m.key] = m.value;
        if (m.fullWidthColon) here.push(`元数据行「${m.raw}」用了全角冒号`);
      }
      j += 1;
    }

    // ② 元数据之后应当紧跟开围栏；中间隔了空行也认，但要报出来
    if (j >= lines.length || !isFenceOpen(lines[j])) {
      // 这一组没被采纳：不把整条消息判死，继续找下一组
      issues.push(`标题行「${t.raw}」后面不是开围栏（下一行是「${String(lines[j] || '').slice(0, 40)}」），这一组没被采纳`);
      continue;
    }
    hasFence = true;
    const fenceLang = lines[j].trim().replace(/^```/, '');
    if (fenceLang !== 'text') {
      here.push(`开围栏写成了「${lines[j].trim()}」，契约要求精确等于 \`\`\`text`);
    }
    if (j > i + 1 && lines.slice(i + 1, j).some((l) => BLANK_RE.test(l))) {
      here.push('标题 / 元数据行与开围栏之间有空行（契约要求紧接）');
    }

    // ③ 闭围栏：优先裸 ```；找不到就吃到下一组标题 / 文末
    let nextTitle = lines.length;
    for (let x = j + 1; x < lines.length; x += 1) {
      if (readTitle(lines[x])) { nextTitle = x; break; }
    }
    let close = -1;
    let closeLoose = false;
    for (let x = j + 1; x < nextTitle; x += 1) {
      if (isFenceClose(lines[x])) { close = x; break; }
    }
    if (close < 0) {
      for (let x = nextTitle - 1; x > j; x -= 1) {
        if (isFenceOpen(lines[x])) { close = x; closeLoose = true; break; }
      }
    }
    if (close < 0) {
      close = nextTitle;
      closeLoose = true;
      here.push('闭围栏缺失（契约要求块以顶格的 ``` 收尾）——已按读到下一组标题行 / 文末处理');
    } else if (closeLoose) {
      here.push(`闭围栏写成了「${lines[close].trim()}」，契约要求精确等于 \`\`\``);
    }

    // ④ 块体
    const { tags, nl, body } = splitBody(lines.slice(j + 1, close), here);
    const { size, tok, seed, anchor } = readMetaValues(meta, here);
    const positive = joinPositive(tags, nl);
    if (!positive) {
      here.push('```text 块是空的，这一组没被采纳');
      for (let x = i; x <= Math.min(close, lines.length - 1); x += 1) used[x] = true;
      i = close >= nextTitle ? nextTitle - 1 : close;
      continue;
    }

    sets.push({
      title: t.name,
      anchor,
      size,
      tok,
      seed,
      tags,
      nl,
      positive,
      negative: '',
      raw: body.join('\n'),
      strict: here.length === 0,
      issues: here,
    });
    for (let x = i; x <= Math.min(close, lines.length - 1); x += 1) used[x] = true;
    for (const msg of here) issues.push(`第 ${sets.length} 组：${msg}`);
    i = close >= nextTitle ? nextTitle - 1 : close;
  }

  // 兜底：一条标题都没采纳，但回复里确实有围栏 → 交付方漏了标题，东西还在
  if (!sets.length) {
    for (let n = 0; n < lines.length; n += 1) {
      if (!isFenceOpen(lines[n])) continue;
      hasFence = true;
      let m = n + 1;
      while (m < lines.length && !isFenceClose(lines[m])) m += 1;
      const here = ['缺标题行'];
      const { tags, nl, body } = splitBody(lines.slice(n + 1, m), here);
      const positive = joinPositive(tags, nl);
      if (positive) {
        let p = n - 1;
        while (p >= 0 && BLANK_RE.test(lines[p])) p -= 1;
        const prev = p >= 0 ? stripZeroWidth(lines[p]).trim() : '';
        const looksMeta = !!readMeta(prev);
        const prevTitle = p >= 0 && prev && !looksMeta && !isFenceOpen(prev) && !isFenceClose(prev)
          ? prev.replace(CIRCLE_RE, '').replace(/^[*#>\s:：·]+/, '').trim()
          : '';
        sets.push({
          title: prevTitle,
          anchor: '',
          size: null,
          tok: null,
          seed: null,
          tags,
          nl,
          positive,
          negative: '',
          raw: body.join('\n'),
          strict: false,
          issues: here,
        });
        for (let x = n; x <= Math.min(m, lines.length - 1); x += 1) used[x] = true;
      }
      if (m >= lines.length) break;
      n = m;
    }
    if (sets.length) {
      issues.push(`整条回复里没有以圈码 ①–⑳ 开头的标题行 —— 按契约这属于「交付方跑偏」，已按围栏兜底取出 ${sets.length} 套，请核对。`);
    }
  }

  if (!sets.length) {
    // 契约第一节第 6 条：不含标题行、也不含围栏的消息 = 非交付（闲聊 / 解释 / 排查）
    // 只有标题没有围栏属于「交付写坏了」，不是闲聊 —— 让调用方按格式错误报出来。
    const nonDelivery = !hasFence && !sawTitle;
    return {
      ruleId: 'contract_v2',
      ok: false,
      nonDelivery,
      hasFence,
      issues,
      sets: [],
      leftover: src.trim(),
    };
  }

  // 块外多余文字：契约要求「块外无字」
  const leftover = lines.filter((l, idx) => !used[idx] && l.trim() !== '').join('\n').trim();
  if (leftover) issues.push('块外还有多余文字（契约要求「块外无字」）—— 这些内容没有进正面提示词。');

  return {
    ruleId: 'contract_v2',
    ok: true,
    nonDelivery: false,
    hasFence,
    issues,
    sets,
    leftover,
  };
}

/* ------------------------------ 规则注册表 ------------------------------ */

/**
 * 想加规则就照这个形状往数组里追加一条：
 *   {
 *     id: 'my_rule',             // 唯一 id，配置里 capture.matchRule 用它
 *     label: '我的规则',          // 前端下拉显示
 *     description: '……',         // 前端展示「这套规则怎么匹配」的说明
 *     parse(raw) => 统一形状,     // 见文件头
 *   }
 * 然后前端会自动多一个选项。
 */
export const RULES = [
  {
    id: 'contract_v2',
    label: '内置（标题 + size + ```text）',
    description:
      '一行「①幕名」→ 可选的 anchor:/size:/tok:/seed: 行 → ```text 块 → 块内「tag 行 + 空行 + NL 段」。'
      + '正面 = tag 行 + ". " + NL；负面留空。没有标题行也没有围栏的回复按「非交付消息」报错。'
      + 'anchor 是可选的原文锚点，用于跟随会话滚动切图。',
    parse: parseContractV2,
  },
  {
    id: 'all_text',
    label: '全部匹配（整条回复当正面）',
    description:
      '不解析标题、尺寸和代码块；抓到的整条助手回复原样作为正面提示词，负面留空，只出 1 套。',
    parse: parseAllText,
  },
  {
    id: 'custom_tags',
    label: '自定义（标题 / 原文 / 尺寸 / 正面 / 负面闭合标签）',
    description:
      '主字段按标题 → 尺寸 → 正面 → 负面顺序读，原文锚点单独扫（写在尺寸前后都可），最多 3 套。默认闭合标签是 </标题> / </原文> / </尺寸> / </正面> / </负面>；'
      + '成对标签会自动推出开标签，也可以只填字面结束标记。原文是可选锚点，用于跟随会话滚动切图。',
    parse: parseCustomTags,
  },
];

export function ruleList() {
  return RULES.map((r) => ({ id: r.id, label: r.label, description: r.description }));
}

export function getRule(id) {
  return RULES.find((r) => r.id === String(id || '')) || RULES[0];
}

/** 统一入口：`parseByRule(ruleId, raw, options)`；未知 id 退回第一条。 */
export function parseByRule(ruleId, raw, options = {}) {
  return getRule(ruleId).parse(raw, options);
}

/** 只给 UI 预览用：把每个 set 的正文压短一点，别的字段原样。 */
export function previewSets(sets) {
  return (sets || []).map((s) => ({
    title: s.title,
    // 工作台提取必须带上原文锚点，否则前端永远只能拿到空文本框。
    anchor: s.anchor || '',
    size: s.size,
    tok: s.tok,
    seed: s.seed,
    positive: s.positive,
    negative: s.negative,
    tags: s.tags,
    nl: s.nl,
    issues: s.issues || [],
  }));
}
