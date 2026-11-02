/**
 * 真机 ComfyUI 冒烟：node tools/comfy-smoke.mjs [--workflow <api.json>] [--prompt "…"] [--size 832x1216]
 *
 * 默认拿旧桥（../comfy-llm-bridge/data）当前启用的那份工作流，覆盖提示词/分辨率/种子后真出图。
 * 会真的占用 GPU 和 ComfyUI 队列；只在你想验证链路时跑。
 *
 *   node tools/comfy-smoke.mjs --dry          # 只干跑，不提交
 *   node tools/comfy-smoke.mjs --prompt "1girl, solo, white dress, standing, window" --size 832x1216
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  applyOverrides,
  comfyStatus,
  detectTokens,
  fetchImage,
  parseWorkflowJson,
  queuePrompt,
  saveImageToDisk,
  seedsOfWorkflow,
  waitForResult,
} from '../lib/comfy.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_ROOT = path.resolve(ROOT, '..', '_dev-airp-comfy');
const OLD_DATA = path.resolve(ROOT, '..', 'comfy-llm-bridge', 'data');
const argv = process.argv.slice(2);

function arg(name, dflt = '') {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const BASE = arg('--base', process.env.COMFY_BASE || 'http://127.0.0.1:8188');
const SIZE = arg('--size', '832x1216');
const PROMPT = arg('--prompt', '1girl, solo, white dress, standing, window, looking outside, soft light');
const NEG = arg('--negative', 'lowres, bad quality, bad anatomy, watermark');
const DRY = argv.includes('--dry');
const OUT = path.resolve(arg('--out', path.join(DEV_ROOT, 'scratch', 'comfy-smoke')));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadWorkflow() {
  const given = arg('--workflow');
  if (given) {
    const p = path.resolve(given);
    return { name: path.basename(p), json: parseWorkflowJson(fs.readFileSync(p, 'utf8')), mapping: {}, size: null, sizeMode: 'manual' };
  }
  const cfg = readJson(path.join(OLD_DATA, 'config.json'), {});
  const list = readJson(path.join(OLD_DATA, 'workflows.json'), []);
  const activeId = cfg?.generation?.workflowId;
  const wf = (Array.isArray(list) ? list : []).find((w) => w.id === activeId) || (Array.isArray(list) ? list[0] : null);
  if (!wf) throw new Error(`旧桥里没有工作流：${OLD_DATA}\n用 --workflow 指定一份 API JSON。`);
  return {
    name: wf.name,
    json: parseWorkflowJson(wf.json),
    mapping: wf.mapping || {},
    size: wf.size || null,
    sizeMode: wf.sizeMode || 'manual',
    loraState: wf.loraState || null,
  };
}

function parseSize(s) {
  const m = String(s || '').match(/^(\d{3,4})\s*[xX×]\s*(\d{3,4})$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 832, h: 1216 };
}

async function main() {
  console.log('\n== ComfyRP · ComfyUI 冒烟 ==');
  console.log(`ComfyUI: ${BASE}`);
  const status = await comfyStatus(BASE).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (!status || status.ok === false || !status.system) {
    console.log(`✘ 连不上 ComfyUI：${status?.error || '没有 system 信息'}`);
    process.exit(1);
  }
  const dev = status.system?.devices?.[0] || null;
  console.log(`✔ 连通：v${status.system?.comfyuiVersion || '?'} · ${dev?.name || ''} · 显存空闲 ${Math.round((dev?.vramFree || 0) / 1048576)}MB`);
  const running = status.queue?.running || 0;
  const pending = status.queue?.pending || 0;
  console.log(`  队列：running ${running} / pending ${pending}`);
  if (running || pending) {
    console.log('⚠ 队列不是空的，等它跑完再测，别把用户的任务挤掉。');
    process.exit(2);
  }

  const wf = loadWorkflow();
  console.log(`工作流：${wf.name}（${Object.keys(wf.json).length} 节点）`);
  const tokens = detectTokens(wf.json);
  console.log(`占位符：prompt ${tokens.positive} / negative ${tokens.negative} / width ${tokens.width} / height ${tokens.height}`);

  const size = parseSize(SIZE);
  const { workflow, report } = applyOverrides(wf.json, {
    positive: PROMPT,
    negative: NEG,
    mapping: wf.mapping || {},
    tokenEmpty: 'blank',
    randomSeed: true,
    loraState: wf.loraState || null,
    size,
    sizeSource: 'smoke',
  });
  console.log(`覆盖：正面 ${report.positiveApplied ? '已注入' : '未注入'} / 负面 ${report.negativeApplied ? '已注入' : '未注入'} / 分辨率 ${report.size.applied ? '已写' : '未写'} / 种子 ${report.seeds.length} 个 / LoRA ${report.lora?.applied ? '已铺' : '未接管'}`);
  if (report.warning) console.log(`⚠ ${report.warning}`);
  if (report.size.leftover.length) console.log(`⚠ 还有 ${report.size.leftover.length} 处 %width%/%height% 没替换`);
  if (DRY) {
    console.log('\n--dry：没有提交。');
    return;
  }

  const clientId = `smoke_${Date.now()}`;
  const t0 = Date.now();
  const { promptId } = await queuePrompt(BASE, workflow, clientId);
  console.log(`已提交：promptId=${promptId}，等出图…`);
  const { images } = await waitForResult(BASE, promptId, { timeoutMs: 600000, pollIntervalMs: 1200 });
  console.log(`完成：${images.length} 张，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const img of images) {
    const { buffer } = await fetchImage(BASE, img);
    const full = saveImageToDisk({ buffer, dir: OUT, fileName: img.filename, prefix: 'smoke' });
    console.log(`  ${full}  (${(buffer.length / 1024).toFixed(0)}KB)`);
  }
  const seeds = seedsOfWorkflow(workflow);
  console.log(`种子：${seeds.map((s) => `${s.nodeId}.${s.inputKey}=${s.value}`).join(', ') || '(无)'}`);
}

main().catch((e) => {
  console.error('\n✘', e?.message || e);
  process.exit(1);
});
