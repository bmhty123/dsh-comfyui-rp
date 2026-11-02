# 发布说明

面向要发版的人；用户侧的安装说明在 [README](../README.md)。

## 一次性准备

1. npm 账号（`bmhty123`）登录一次：

```powershell
npm login
npm whoami          # 应该回 bmhty123
```

2. GitHub 仓库 `https://github.com/bmhty123/dsh-airp-comfy-bridge` 建好（空仓库即可），本地接上：

```powershell
git init -b main
git remote add origin https://github.com/bmhty123/dsh-airp-comfy-bridge.git
```

3. 确认包名没被占：`npm view dsh-airp-comfy-bridge version` 应该是 404。

## 每次发版

版本号有两处，**必须同时改**（`tools/test-rule.mjs` 的「发布一致性」会拦下来）：

- `package.json` 的 `version`
- `lib/meta.js` 的 `VERSION`

```powershell
# 1. 改版本 + 测一遍
#    （prepack 也会自动跑 npm test，这里先跑是为了别在 publish 时才发现红）
npm test

# 2. 看清单：确认只有 lib / docs / README / LICENSE / cordis.patch.yml / tools/install.mjs
npm pack --dry-run

# 3. 提交并推
git add -A
git commit -m "release: 0.2.1"
git push -u origin main

# 4. 发布（prepack 会再跑一次 npm test）
npm publish

# 5. 打标签
git tag v0.2.1
git push --tags
```

发完验证：

```powershell
npm view dsh-airp-comfy-bridge version
npm view dsh-airp-comfy-bridge dist.tarball
```

## 装到自己的 DSH 上验证

```powershell
dsh plugin --profile web add dsh-airp-comfy-bridge
```

装完重启 DSH，日志里找 `[airp-comfy] 路由已注册`。本地目录那种装法（`node tools/install.mjs --apply`）和 npm 装法是互斥的，切过去之前先 `--uninstall`。

## 上社区市场

市场（dshmarket / awesome-dsh-plugin）不读 npm 的搜索，只读精选列表。**第一次**要手工提一条：

1. fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
2. 在列表里加一条，字段照 [`docs/awesome-entry.yml`](awesome-entry.yml)
3. 提 PR

之后发新版本不用再提 PR：列表里那条指向仓库，CI 每天从 npm / GitHub 刷版本号和 star。

要做卡片图标和截图，就把图片放进 `docs/images/`（文件名见 `_guide.md`），再把路径加到 README 和可选的 `screenshots.json`。

## 出问题时

- 发错了、还没到 24 小时：`npm unpublish dsh-airp-comfy-bridge@<版本> --force`
- 超过 24 小时：不能删了，只能 `npm deprecate dsh-airp-comfy-bridge@<版本> "原因"`，然后发新版本
- 想先试跑不发：`npm pack` 出 tgz，用 `dsh plugin --profile web add ./dsh-airp-comfy-bridge-0.2.1.tgz` 装本地包

## 包里有什么

由 `package.json` 的 `files` 决定，当前 28 个文件、约 1.0 MB（截图占 0.8 MB）：

- 进包：`lib/**`、`tools/install.mjs`、`cordis.patch.yml`、`screenshots.json`、README、CHANGELOG、LICENSE、第三方声明、提示词格式说明、`docs/images/*` 里的图片
- 不进包：`tools/test-*.mjs`、`tools/test-live.mjs`、`tools/comfy-smoke.mjs`、`tools/prep-images.ps1`、`docs/images/_guide.md`、`.gitignore`

## 截图和图片链接

- README 里一律写仓库相对路径（`docs/images/xxx.png`）：GitHub 网页能看，市场会自己补 GitHub 图床并走它自己的加速线路。
- 别改成 `raw.githubusercontent.com` 的绝对地址：这个域名在当前网络下直连不通（`curl` 直接 000），国内用户会看到一片裂图。
- npm 页面不解析相对路径，那边的 README 图是不显示的——市场才是主要入口，不值得为此把路径写成绝对地址。
- 换图直接用 `tools/prep-images.ps1`：在 `$srcDir` 里放原图（文件名按 `_guide.md`），改脚本里的输出名和尺寸后 `pwsh -File tools/prep-images.ps1` 重跑。

