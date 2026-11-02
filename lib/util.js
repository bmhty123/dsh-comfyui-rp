import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from './meta.js';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** 默认数据目录：环境变量 > $DSH_HOME/airp-comfy > ~/.dsh/airp-comfy。 */
export function defaultDataDir() {
  const env = String(process.env.AIRP_COMFY_DATA || '').trim();
  if (env) return path.resolve(env);
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'airp-comfy');
}

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export const nowIso = () => new Date().toISOString();

export function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(suffix || '').replace(/^\/+/, '');
  if (!b) return `/${s}`;
  return `${b}/${s}`;
}

export function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function bool(v, dflt = false) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return dflt;
}

export function str(v, dflt = '') {
  return v === undefined || v === null ? dflt : String(v);
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, num(v, lo)));
}

/** Windows 文件名清洗（ComfyUI 的文件名可能带路径分隔符）。 */
export function sanitizeName(s, dflt = 'file') {
  const out = String(s ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return out || dflt;
}

/**
 * 正文里的气泡包装：`@bubble:角色id|显示名||[台词]`。
 * 只去掉 `@bubble:角色id` 这一段，从第一个 `|` 开始的名字 / 台词全部保留：
 *   `@bubble:lin_xiaoman|林小满||[台词]` → `|林小满||[台词]`
 * 没带 `|` 的写坏指令才整段删掉。
 */
export function cleanBodyText(input) {
  const s = String(input ?? '');
  if (!s || !/@bubble/i.test(s)) return s;
  // 优先按「@bubble:角色id + 第一个 |」切：保留 |名字||[台词]。
  let out = s.replace(/@bubble[:：][^|\n｜]{0,200}?(?=[|｜])/gi, '');
  // 没有 | 的写坏残留：从 @bubble: 删到下一个空白 / 方括号 / 竖线。
  out = out.replace(/@bubble[:：][^\s\[\]【】|｜]*/gi, '');
  // 去掉包装后可能留下多余水平空格；不合并换行，保留正文段落。
  out = out.replace(/[ \t]+$/gm, '').replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

export function readJsonFile(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 原子写 JSON：先写 .tmp，再 rename 覆盖。
 * 桥的数据都在这几个 JSON 里，写到一半崩掉会整份丢，所以不能直接 writeFileSync 覆盖。
 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // 少数 Windows 场景 rename 会被占用；退回直接覆盖（至少不会留下半份 tmp）
    try {
      fs.writeFileSync(file, text, 'utf8');
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

export function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `请求体超过 ${limit} 字节`, 'body-too-large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => reject(new HttpError(400, `读取请求体失败：${e?.message || e}`, 'body-read')));
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!String(raw).trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, `请求体不是合法 JSON：${e?.message || e}`, 'bad-json');
  }
}

export function sendJson(res, status, data, extraHeaders = {}) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(data === undefined ? null : data), 'utf8');
  } catch (e) {
    body = Buffer.from(JSON.stringify({ ok: false, error: String(e?.message || e) }), 'utf8');
    status = 500;
  }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  } catch {
    /* 客户端已断开 */
  }
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  try {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  } catch {
    /* ignore */
  }
}

/** 看魔数，不信扩展名。 */
export function sniffMime(bytes, filePath = '') {
  if (bytes && bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
    const t4 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const t8 = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (t4 === 'RIFF' && t8 === 'WEBP') return 'image/webp';
    if (t4 === 'RIFF' && t8 === 'AVIF') return 'image/avif';
  }
  const m = String(filePath || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  };
  return (m && map[m[1]]) || 'application/octet-stream';
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只合并普通对象，数组整体替换（配置合并用）。 */
export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function truncate(s, n = 200) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
