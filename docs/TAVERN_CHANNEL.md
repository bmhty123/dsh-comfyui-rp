# 酒馆通道（tavern）

给「酒馆助手脚本」用的跨源入口。让运行在 `http://localhost:8080` 的 SillyTavern 页面
能把正文发给本插件，拿到桥会话写好的提示词。

## 为什么需要单独一条

现有接口有两个前提，跨源场景都不成立：

1. `requireSameOrigin()`（`lib/api.js`）要求 `Origin.host === Host`，跨站直接 403 `csrf`；
2. 响应没有 CORS 头，浏览器拿不到 JSON。

所以没有改动任何既有路由，只**新增** `/__airp_comfy/tavern/*`。

## 路由

前缀：`<ROUTE_PATH>/tavern/`（默认 `/__airp_comfy/tavern/`）

| 方法 | 路径 | 作用 | 鉴权 |
|---|---|---|---|
| OPTIONS | `*` | CORS 预检 | 无 |
| GET | `tavern/ping` | 探活，返回版本与 routePath | 无 |
| GET | `tavern/info` | DSH 侧默认 target / source 摘要（不参与酒馆投递） | 配了口令就验 |
| GET | `tavern/sessions` | 本机会话列表（给下拉选会话用） | 配了口令就验 |
| POST | `tavern/ask` | 投递正文 → 等桥会话回复 → 返回提示词 | `x-prompt-relay-token` |

### GET tavern/sessions

`?limit=1..500`（默认 200，超出会被夹回来）。只返回选会话需要的字段，不带图片 / 任务 / 正文：

```json
{
  "ok": true,
  "sessions": [
    {
      "sessionId": "session-…",
      "title": "沐白形象管理",
      "displayTitle": "沐白形象管理 · “小欣，别紧张…” · 83条",
      "updatedAt": 1762900000000,
      "running": false,
      "live": true,
      "firstText": "…",
      "userCount": 83
    }
  ],
  "total": 1,
  "activeSessionId": "session-…"
}
```

`displayTitle` 已经处理过同名会话（酒馆一个角色一个目录，会话标题都一样）；
`firstText` / `userCount` 只有标题重复的会话才带。**投递时用 `target.sessionId`**，见下。

### POST tavern/ask

请求体与原有 `/api/ask` 完全一致，因为内部直接复用 `handleAsk()`：

```json
{
  "sessionId": "桥会话 id（酒馆设置里选中的那个会话；不是 info 里的 defaultTarget）",
  "text": "要投递的正文",
  "timeoutMs": 300000
}
```

响应：

```json
{ "ok": true, "text": "桥会话返回的提示词", "sessionId": "...", "turn": 12 }
```

## 投递用哪个会话：请求体说了算

`POST tavern/ask` 的会话**只由请求体里的 `sessionId` 决定**——也就是酒馆设置里选中的那个
会话（提示词 / 桥会话）。缺了直接 `400 bad-request`，不会回退到 DSH 的配置。

`GET tavern/info` 里的 `defaultTarget` / `defaultSource`（以及兼容旧字段 `target` / `source`）
是 **DSH 前端自己用的默认值**，只影响：

- DSH 概览 / 工作台的「投递」按钮；
- DSH 侧的自动捕获（源会话 → 桥会话）。

它们**不参与**酒馆投递。`info.delivery === "request-session-id"` 就是这条约定的标记。

## 重要：`sessionId` 传「提示词会话」

`tavern/ask` 的语义是「往这个会话投递正文、等它回复、把它写的提示词返回」，所以传
**酒馆设置里选中的提示词 / 桥会话**（通常就是 DSH 里那个负责写提示词的会话）。
别传成正文来源会话——那样会把正文投回正文会话。

## 鉴权与 CORS

- 口令：复用已有的 `x-prompt-relay-token`，值取自 `config.source.token` 或 `config.target.token`
  之一（两边都可）。两个都没配时是本机旧行为：不校验。
- 来源（白名单）：
  - `config.tavern.origin` 为空（默认）→ **只认** `http://localhost:8080` 与 `http://127.0.0.1:8080`；
  - 填了值 → 只认填的（多条用逗号或空格分隔，例如 `http://localhost:8080, http://127.0.0.1:9091`）；
  - 其余来源一律 `403 {"code":"origin-denied"}`；
  - 非浏览器请求（没有 `Origin` 头）→ 不放 CORS 头，但也放行（方便 curl 调试）。
- 预检响应的头：

```
Access-Control-Allow-Origin: <来源>
Vary: Origin
Access-Control-Allow-Headers: content-type, x-prompt-relay-token
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Max-Age: 60
```

`Max-Age` 是 60 秒：改完白名单不用等 10 分钟才生效。

## 错误码

| 状态 | code | 含义 / 处理 |
|---|---|---|
| 400 | `bad-request` | 缺 `sessionId` / `text`，不要重试 |
| 401 | `unauthorized` | 口令不对，让用户改设置 |
| 403 | `origin-denied` | 来源不在白名单，检查 `tavern.origin` |
| 404 | `not-found` | 未知 action |
| 405 | `method` | 方法不对（`ping/info/sessions` 只认 GET，`ask` 只认 POST） |
| 409 | `opening-only` | 会话里只有人物卡开场，提示换会话 |
| 5xx | `internal` | 可有限重试 |

## 配置新增

`lib/config.js` 的 `defaultConfig()` 增加：

```js
tavern: { origin: '' }   // 空 = 只认酒馆默认端口的两个本机来源
```

`normalizeConfig()` 会逐条补协议、去尾斜杠，多条用 `, ` 拼回去。

## 调试

```bash
# 探活
curl http://127.0.0.1:3080/__airp_comfy/tavern/ping

# 会话列表
curl http://127.0.0.1:3080/__airp_comfy/tavern/sessions -H 'Origin: http://localhost:8080'

# 预检（模拟浏览器）
curl -i -X OPTIONS http://127.0.0.1:3080/__airp_comfy/tavern/ask \
  -H "Origin: http://localhost:8080" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,x-prompt-relay-token"

# 真实投递
curl -X POST http://127.0.0.1:3080/__airp_comfy/tavern/ask \
  -H "Origin: http://localhost:8080" \
  -H "Content-Type: application/json" \
  -H "x-prompt-relay-token: <口令>" \
  -d '{"sessionId":"<target.sessionId>","text":"正文……"}'
```

## 已知边界

- 这条通道只做「投递正文 → 返回回复」；图片、工作流、图库仍然只走同源接口。
- `ask` 会一直等到桥会话回复或超时（默认 300s），调用方自己设超时并用 `AbortController` 中止；
  客户端断开时服务端会 abort 投递。
- 只监听本机时风险很小；把 DSH 暴露到公网必须配 `tavern.origin` + 口令。
- 改了 `tavern.origin` 之后，浏览器最多还有 60 秒的预检缓存。
- 改动在 Host 半区，**要重启 DSH 才生效**。
