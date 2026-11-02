/**
 * 匹配规则离线自检：node tools/test-rule.mjs
 * 只测 lib/rule.js，不启动 DSH、不碰 ComfyUI。
 */
import fs from 'node:fs';
import { parseByRule, previewSets, ruleList } from '../lib/rule.js';
import { VERSION } from '../lib/meta.js';

let pass = 0;
const fails = [];
function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fails.push(label); console.log(`  ✘ ${label}${extra ? `  ${extra}` : ''}`); }
}
function eq(got, want, label) {
  ok(Object.is(got, want), label, Object.is(got, want) ? '' : `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}
function section(t) { console.log(`\n--- ${t} ---`); }

const v2 = (title, size, tags, nl) =>
  `${title}\nsize: ${size}\n\`\`\`text\n${tags}\n\n${nl}\n\`\`\`\n`;

console.log('\n== ComfyRP · 匹配规则 ==');

section('规则注册表');
const rules = ruleList();
eq(rules.length, 3, '注册了内置 / 全部 / 自定义三套规则');
eq(rules[0].id, 'contract_v2', '第一条是内置规则');
eq(rules[1].id, 'all_text', '第二条是全部匹配');
eq(rules[2].id, 'custom_tags', '第三条是自定义标签');
ok(/标题/.test(rules[0].description) && /围栏/.test(rules[0].description), '内置说明写清了标题/围栏');
ok(/整条助手回复/.test(rules[1].description), '全部匹配说明写清了整条助手回复');
ok(/最多 3 套/.test(rules[2].description), '自定义说明写清了最多 3 套');

section('标准两套');
const two =
  v2('①掐腰警告·慢磨', '1216x832',
    '1boy, 1girl, hetero, sex from behind, blush, sweat',
    'The girl is held from behind. Her eyes are wet. The room is quiet.')
  + '\n'
  + v2('②高潮失神·弓背翻眼', '832x1216',
    '1boy, 1girl, hetero, ahegao, arched back, tears',
    'She arches her back. Her eyes roll up. The light stays low.');
const r1 = parseByRule('contract_v2', two);
eq(r1.ok, true, '两套被采纳');
eq(r1.sets.length, 2, '组数是 2');
eq(r1.sets[0].title, '掐腰警告·慢磨', '标题一去掉圈码');
eq(r1.sets[1].title, '高潮失神·弓背翻眼', '标题二去掉圈码');
eq(r1.sets[0].size.w, 1216, '第一套宽 1216');
eq(r1.sets[0].size.h, 832, '第一套高 832');
eq(r1.sets[1].size.w, 832, '第二套宽 832');
ok(r1.sets[0].positive.startsWith('1boy, 1girl, hetero, sex from behind, blush, sweat. The girl'),
  '正面 = tag 行 + ". " + NL');
eq(r1.sets[0].negative, '', '负面恒为空');
eq(r1.sets[0].strict, true, '标准写法没有 issue');
eq(r1.issues.length, 0, '整条没有 issue');

section('实际会话的写法：① 后有空格 + size 后多一个空行');
const real = `① 门外换了个人
size: 832x1216

\`\`\`text
anime, 1girl, solo, light brown hair, blush, holding box, doorway
The pale-skinned girl stands outside the doorway. She holds a small box. The afternoon light comes in.
\`\`\`

② 一盏一盏地斟
size: 832x1216

\`\`\`text
anime, 1boy, solo, maid, holding teapot, sitting, indoors
The black-haired boy sits on the couch. He tips the teapot. The curtains move.
\`\`\``;
const r2 = parseByRule('contract_v2', real);
eq(r2.ok, true, '这种写法也能采纳（不再整组丢掉）');
eq(r2.sets.length, 2, '两套都在');
eq(r2.sets[0].title, '门外换了个人', '标题正确（不再变成 size 行）');
eq(r2.sets[0].size.w, 832, 'size 正确取到');
eq(r2.sets[1].title, '一盏一盏地斟', '第二套标题正确');
ok(r2.issues.some((s) => /圈码后面不能有空格/.test(s)), '圈码后空格被记 issue');
ok(r2.issues.some((s) => /开围栏之间有空行/.test(s)), '元数据后空行被记 issue');
ok(r2.sets[0].strict === false, '这组不算 strict');

section('非交付消息');
const chat = '上一段正文我已经切好三幕，就差交给你：① 撑臂回头 ② 仰头朝空处 ③ 一句很轻的坦白。要我直接发吗？';
const r3 = parseByRule('contract_v2', chat);
eq(r3.ok, false, '闲聊不出图');
eq(r3.nonDelivery, true, '判为非交付消息');
eq(r3.sets.length, 0, '没有套');

section('只有标题、没有围栏');
const broken = '①门外换了个人\nsize: 832x1216\n这里忘了写围栏。';
const r4 = parseByRule('contract_v2', broken);
eq(r4.ok, false, '没有围栏不算成功');
eq(r4.nonDelivery, false, '有标题 → 不是「非交付」，是格式坏了');
ok(r4.issues.some((s) => /后面不是开围栏/.test(s)), '报出「标题后不是开围栏」');

section('只有围栏、没有标题（兜底）');
const fenceOnly = '这是一段漏了标题的交付：\n```text\ntag one, tag two\n\nA short sentence. Another one.\n```';
const r5 = parseByRule('contract_v2', fenceOnly);
eq(r5.ok, true, '按围栏兜底取出');
eq(r5.sets.length, 1, '一套');
eq(r5.sets[0].title, '这是一段漏了标题的交付：', '标题取围栏上一行（去掉冒号）');
ok(r5.issues.some((s) => /没有以圈码/.test(s)), '报出缺标题');
ok(/tag one/.test(r5.sets[0].positive) && /A short sentence/.test(r5.sets[0].positive), 'tag 与 NL 都在');

section('宽容：全角冒号 / × / 写歪的围栏');
const loose = '①幕名\nsize：1024×1024\ntok: 3/8\nseed: 42\n```json\na, b, c\n\nD e f.\n```';
const r6 = parseByRule('contract_v2', loose);
eq(r6.ok, true, '认下来');
eq(r6.sets[0].size.w, 1024, '全角冒号 + × 也认');
eq(r6.sets[0].tok, '3/8', 'tok 读到了');
eq(r6.sets[0].seed, 42, 'seed 读到了');
ok(r6.sets[0].issues.some((s) => /全角冒号/.test(s)), '全角冒号记 issue');
ok(r6.sets[0].issues.some((s) => /开围栏写成了/.test(s)), '```json 记 issue');

section('块外多余文字');
const extra = v2('①幕名', '1024x1024', 'a, b', 'Sentence one.') + '\n这一行不该出现。\n';
const r7 = parseByRule('contract_v2', extra);
ok(r7.issues.some((s) => /块外还有多余文字/.test(s)), '块外文字被报出来');

section('全部匹配');
const all = parseByRule('all_text', '1girl, solo, white dress\n\nA girl stands by the window.');
eq(all.ok, true, '全部匹配直接采纳');
eq(all.sets.length, 1, '只出 1 套');
eq(all.sets[0].positive, '1girl, solo, white dress\n\nA girl stands by the window.', '整条回复原样作为正面');
eq(all.sets[0].negative, '', '负面留空');
eq(parseByRule('all_text', '   ').nonDelivery, true, '空回复不算可用提示词');

section('自定义闭合标签（默认）');
const custom = [
  '<标题>窗边读书</标题>',
  '<尺寸>1024x1024</尺寸>',
  '<正面>1girl, solo, reading book</正面>',
  '<负面>bad hands</负面>',
  '',
  '<标题>第二套</标题>',
  '<尺寸>832x1216</尺寸>',
  '<正面>1boy, solo, standing</正面>',
  '<负面></负面>',
].join('\n');
const rc = parseByRule('custom_tags', custom);
eq(rc.ok, true, '自定义标签能采纳');
eq(rc.sets.length, 2, '切出 2 套');
eq(rc.sets[0].title, '窗边读书', '标题去掉标签');
eq(rc.sets[0].size.w, 1024, '尺寸读到了');
eq(rc.sets[0].positive, '1girl, solo, reading book', '正面读到了');
eq(rc.sets[0].negative, 'bad hands', '负面读到了');
eq(rc.sets[1].size.h, 1216, '第二套尺寸读到了');
eq(rc.sets[1].negative, '', '空负面是合法的');
eq(rc.issues.length, 0, '标准自定义写法没有 issue');

section('原文锚点（自定义标签 / 内置元数据）');
const anchored = [
  '<标题>窗边读书</标题>',
  '<原文>她推开门，雨声一下子涌进来。</原文>',
  '<尺寸>1024x1024</尺寸>',
  '<正面>1girl, solo, reading book</正面>',
  '<负面>bad hands</负面>',
].join('\n');
const ra = parseByRule('custom_tags', anchored);
eq(ra.sets[0].anchor, '她推开门，雨声一下子涌进来。', '自定义标签读到原文锚点');
ok(!ra.issues.some((s) => /原文/.test(s)), '原文锚点不产生 issue');

const anchoredAfterSize = [
  '<标题>窗边读书</标题>',
  '<尺寸>1024x1024</尺寸>',
  '<原文>她推开门，雨声一下子涌进来。</原文>',
  '<正面>1girl, solo, reading book</正面>',
  '<负面>bad hands</负面>',
].join('\n');
const raAfter = parseByRule('custom_tags', anchoredAfterSize);
eq(raAfter.sets[0].anchor, '她推开门，雨声一下子涌进来。', '原文锚点写在尺寸后面也能读到');
eq(raAfter.sets[0].size.w, 1024, '原文锚点写在尺寸后面不会挤掉尺寸');

const anchoredV2 = v2('①幕名', '1024x1024', 'a, b', 'Sentence one.').replace('size: 1024x1024', 'size: 1024x1024\nanchor: 她推开门，雨声一下子涌进来。');
const ra2 = parseByRule('contract_v2', anchoredV2);
eq(ra2.sets[0].anchor, '她推开门，雨声一下子涌进来。', 'contract_v2 的 anchor 元数据读到原文锚点');
const anchoredCn = v2('①幕名', '1024x1024', 'a, b', 'Sentence one.').replace('size: 1024x1024', 'size: 1024x1024\n原文：她推开门，雨声一下子涌进来。');
const raCn = parseByRule('contract_v2', anchoredCn);
eq(raCn.sets[0].anchor, '她推开门，雨声一下子涌进来。', 'contract_v2 认中文原文 + 全角冒号');
ok(!raCn.issues.some((s) => /全角冒号/.test(s)), '中文原文的全角冒号不产生 issue');
const anchoredCnAscii = v2('①幕名', '1024x1024', 'a, b', 'Sentence one.').replace('size: 1024x1024', 'size: 1024x1024\n原文: 她推开门，雨声一下子涌进来。');
const raCnAscii = parseByRule('contract_v2', anchoredCnAscii);
eq(raCnAscii.sets[0].anchor, '她推开门，雨声一下子涌进来。', 'contract_v2 认中文原文 + 半角冒号');
const anchoredUpper = v2('①幕名', '1024x1024', 'a, b', 'Sentence one.').replace('size: 1024x1024', 'size: 1024x1024\nANCHOR: 她推开门，雨声一下子涌进来。');
const raUpper = parseByRule('contract_v2', anchoredUpper);
eq(raUpper.sets[0].anchor, '她推开门，雨声一下子涌进来。', 'contract_v2 的 anchor 大小写也认');
const raPreview = previewSets(ra2.sets);
eq(raPreview[0].anchor, '她推开门，雨声一下子涌进来。', '规则预览也把原文锚点带回工作台');
eq(raPreview[0].title, '幕名', '规则预览保留标题');

section('自定义闭合标签（完全自定义 / 最多 3 套）');
const tagSet = { title: '[[/T]]', size: '[[/S]]', positive: '[[/P]]', negative: '[[/N]]' };
const custom4 = [1, 2, 3, 4].map((n) => [
  `[[T]]标题${n}[[/T]]`,
  `[[S]]832x1216[[/S]]`,
  `[[P]]pos ${n}[[/P]]`,
  `[[N]]neg ${n}[[/N]]`,
].join('\n')).join('\n\n');
const rc4 = parseByRule('custom_tags', custom4, { customTags: tagSet });
eq(rc4.ok, true, '完全自定义标签能采纳');
eq(rc4.sets.length, 3, '最多只取 3 套');
eq(rc4.sets[0].title, '标题1', '自定义开标签推出正确');
eq(rc4.sets[0].positive, 'pos 1', '自定义正面正确');
ok(rc4.issues.some((s) => /超过 3 套/.test(s)), '第四套被报出来');

section('自定义闭合标签（字面结束标记）');
const tagLiteral = { title: '标题结束', size: '尺寸结束', positive: '正面结束', negative: '负面结束' };
const literal = [
  '标题：字面标记', '标题结束',
  '尺寸：832x1216', '尺寸结束',
  '正面：a, b', '正面结束',
  '负面：blur', '负面结束',
].join('\n');
const rl = parseByRule('custom_tags', literal, { customTags: tagLiteral });
eq(rl.ok, true, '字面结束标记能采纳');
eq(rl.sets[0].title, '字面标记', '字面标记标题正确');
eq(rl.sets[0].positive, 'a, b', '字面标记正面正确');
eq(rl.sets[0].negative, 'blur', '字面标记负面正确');

section('自定义标签（非交付）');
const rn = parseByRule('custom_tags', '这是一段普通聊天，没有标签。');
eq(rn.ok, false, '没有标题标签不算成功');
eq(rn.nonDelivery, true, '判为非交付');

section('发布一致性');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
eq(pkg.version, VERSION, 'package.json 与 lib/meta.js 的版本号一致');
ok(pkg.private !== true, 'package.json 没有 private（否则发不了 npm）');
ok(Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'), 'files 里带了 lib 和 cordis.patch.yml');
ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 cordis.patch.yml');
ok(pkg.dsh && pkg.dsh.client && Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject 声明了席位包');
ok(typeof pkg.repository === 'object' && /^git\+https:\/\//.test(pkg.repository.url), 'repository 指向 git 仓库（市场卡片要读）');
ok(/^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), '包名可直接发到 npm');

section('结果');
console.log(`\n== ${pass} ✔ / ${fails.length} ✘ ==`);
if (fails.length) {
  console.log('失败：');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
