/**
 * 把 ComfyRP Bridge 装进某个 DSH profile。
 *
 *   node tools/install.mjs                    # 预演（只看，不写）
 *   node tools/install.mjs --apply            # 装进默认 profile（web）
 *   node tools/install.mjs --profile airp-test --apply
 *   node tools/install.mjs --profile airp-test --uninstall
 *
 * 做三件事（全部可逆）：
 *   1. <profile>/node_modules/<包名> 建目录联接，指向本仓库；
 *   2. <profile>/package.json 的 dependencies 加 "link:<本仓库绝对路径>"；
 *   3. 把包名加进 dsh.profile.bundles。
 * 改动前留一份 package.json.airp-backup，--uninstall 直接还原。
 *
 * 装完要**重启 DSH**（或让 profile 的 patchReload 重新组合）才会加载 Host 半区；
 * 客户端半区由 dsh-client-modules 从 package.json 的 dsh.client 拾取。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PKG_NAME = PKG.name;
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const UNINSTALL = argv.includes('--uninstall');
const DRY = !APPLY && !UNINSTALL;

function argValue(name) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return '';
}

const HOME = path.resolve(argValue('--dsh-home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const PROFILE_NAME = argValue('--profile') || 'web';
const PROFILE_DIR = argValue('--profile-dir')
  ? path.resolve(argValue('--profile-dir'))
  : path.join(HOME, 'profiles', PROFILE_NAME);
const PKG_JSON = path.join(PROFILE_DIR, 'package.json');
const BACKUP = path.join(PROFILE_DIR, 'package.json.airp-backup');
const LINK = path.join(PROFILE_DIR, 'node_modules', PKG_NAME);

const log = (...a) => console.log(...a);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function linkTarget() {
  try { return fs.readlinkSync(LINK); } catch { return ''; }
}
function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}
function removeLink() {
  const st = fs.lstatSync(LINK);
  if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(LINK, { force: true });
}

function plan() {
  if (!exists(PKG_JSON)) {
    throw new Error(`找不到 profile：${PROFILE_DIR}\n（先启动一次该 profile，或用 --profile-dir 直接指定目录）`);
  }
  const pkg = readJson(PKG_JSON);
  const deps = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  return {
    profileDir: PROFILE_DIR,
    pkgName: PKG_NAME,
    link: LINK,
    linkTarget: ROOT,
    currentLink: exists(LINK) ? linkTarget() : '',
    hasDep: !!deps[PKG_NAME],
    depValue: deps[PKG_NAME] || '',
    inBundles: bundles.includes(PKG_NAME),
    bundles,
    pkg,
  };
}

function printPlan(p) {
  log('== ComfyRP Bridge 安装器 ==');
  log(`profile : ${p.profileDir}`);
  log(`包名    : ${p.pkgName}`);
  log(`源目录  : ${p.linkTarget}`);
  log(`目录联接: ${p.link}${p.currentLink ? `（当前 -> ${p.currentLink}）` : '（还没有）'}`);
  log(`依赖项  : ${p.hasDep ? p.depValue : '（还没有）'}`);
  log(`bundles : ${p.inBundles ? '已包含' : '（还没有）'}`);
  if (DRY) log('\n这是预演：没有写任何东西。确认后加 --apply。');
}

function install() {
  const p = plan();
  printPlan(p);
  if (DRY) return;

  fs.mkdirSync(path.dirname(LINK), { recursive: true });
  if (!exists(LINK)) {
    fs.symlinkSync(path.resolve(ROOT), LINK, process.platform === 'win32' ? 'junction' : 'dir');
    log(`✔ 已建目录联接：${LINK}`);
  } else if (path.resolve(String(linkTarget())) !== path.resolve(ROOT)) {
    log(`⚠ 目录联接已存在，指向 ${linkTarget()}；没有覆盖。要换指向请先 --uninstall。`);
  } else {
    log('✔ 目录联接已存在且指向本仓库');
  }

  if (!exists(BACKUP)) {
    fs.copyFileSync(PKG_JSON, BACKUP);
    log(`✔ 已备份原 package.json → ${path.basename(BACKUP)}`);
  }

  const pkg = readJson(PKG_JSON);
  pkg.dependencies = pkg.dependencies || {};
  const linkValue = `link:${ROOT.replace(/\\/g, '/')}`;
  if (pkg.dependencies[PKG_NAME] !== linkValue) {
    pkg.dependencies[PKG_NAME] = linkValue;
    log(`✔ dependencies["${PKG_NAME}"] = ${linkValue}`);
  }
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(PKG_NAME)) {
    bundles.push(PKG_NAME);
    pkg.dsh.profile.bundles = bundles;
    log('✔ 已加入 dsh.profile.bundles');
  }
  writeJson(PKG_JSON, pkg);
  log('\n装好了。**重启 DSH** 后生效（Host 半区需要进程启动时加载；客户端半区刷新页面即可）。');
  log(`启动后检查日志里应出现：[airp-comfy] 路由已注册：${'/__airp_comfy'}/*`);
}

function uninstall() {
  const p = plan();
  printPlan(p);
  if (DRY) return;
  if (exists(LINK)) {
    removeLink();
    log(`✔ 已删除目录联接：${LINK}`);
  }
  if (exists(BACKUP)) {
    fs.copyFileSync(BACKUP, PKG_JSON);
    log(`✔ 已还原 package.json（来自 ${path.basename(BACKUP)}）`);
  } else {
    const pkg = readJson(PKG_JSON);
    if (pkg.dependencies) delete pkg.dependencies[PKG_NAME];
    const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG_NAME);
    writeJson(PKG_JSON, pkg);
    log('✔ 已从 dependencies / bundles 移除（没有备份可还原，就按条目删）');
  }
  log('\n卸载完成。重启 DSH 后插件消失。');
}

try {
  if (UNINSTALL) uninstall();
  else install();
} catch (e) {
  console.error(`\n✘ ${e.message}`);
  process.exit(1);
}
