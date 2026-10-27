# dsh-channel-fallback

让 **DeepSeek V4.1 Flash 优先走国际版（WorkBuddy，免费额度）、用不了自动切国内版（CodeBuddy）**，
对上层完全透明：模型选择、计费、会话日志里看到的还是原来那个模型。

链是**可配置**的：不限于这两家渠道，任何 DSH 已注册的 provider 都能排进链里，
支持多级兜底（A → B → C → …）。带一个可视化面板：改链、调顺序、**一键连通测试**、看切换统计。

## 它解决什么问题

`workbuddy/deepseek-v4.1-flash` 在仓库网关的元数据里标着 **x0.00→免费**，
`buddy/deepseek-v4.1-flash` 标着 **x0.11**，两者能力完全一致
（contextWindow 1e6、支持图片、reasoningEfforts 都含 `high`）。
所以「先免费、后付费」是严格更优的顺序 —— 但 WorkBuddy 会时不时撞上
额度上限 / 频率限制 / 新加坡区额度耗尽。

本插件在宿主 `llm/stream` 这条 waterfall 上挂一个监听器：
请求命中链头就按链顺序试，**第一个真的吐出正文的候选胜出**。

## 为什么不用现成方案（逐条查过源码，2026-10-26）

| 方案 | 结论 |
|---|---|
| `dsh-our-free-model` 自带 combos（有 `fallback` 策略） | ❌ `buildComboCatalog` 只认 OFM 自己的 catalog；`buddy`/`workbuddy` 由 channel-pack 单独 `registerAdapterIdempotent` 注册成独立 provider，**不在 OFM catalog 里** |
| `@deepseek-ai/dsh-llm-retry` | ❌ 只做同一 provider 重试：`recover({provider, failure, ...})` 拿到的就是失败的那个，函数体内没有任何切换逻辑 |
| `dsh-llm-pi-ai` 的 `providers` | ❌ 配置面，每键一个路由名；文档全篇无「失败切另一个 provider」，只有单路由内重试 |
| `channel-pack` 的 `providerOrder` | ❌ 是「供应商开关」弹窗的拖拽排序，源码注释原文「纯展示偏好，可逆」 |
| `channel-pack` 的 `fallbackModels` | ❌ 是「远端拉不到模型清单时的静态兜底」，只用于 `listModels` 补目录 |
| `shouldFallbackToOtherChannel` | ❌ 是**同渠道切账号**（仅 429 + 1005/1113），不是切模型 |
| OFM aggregate | ❌ `providerModelId()` 要求模型 id 前缀必须是 `src/providers/registry.json` 里已注册的 provider，无法凭空造一个指向本地网关的 provider |

## 怎么实现的

宿主 `@deepseek-ai/dsh-llm` 的 `LlmRuntime.streamWithRegistration()`：

```js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
}
```

cordis 的 waterfall 语义（`events.ts:79-84` 原文）：
> Each listener wraps the rest of the chain: calling `next()` invokes the next listener
> (finally the built-in behavior); not calling it vetoes.

所以监听器里可以换掉 `options.provider` / `options.model`，再调一次 `ctx.llm.stream()`
发起备选调用。社区既有做法：`dsh-cost-meter` 的注释记录 modlens / vision-router
就是「在监听器体内（瀑布派发期）急切发起上游调用」的包装路由插件。

**递归保护**：用 `AsyncLocalStorage` 标记自己发起的调用，监听器见到标记立刻
`next()` 透传，交给真正的 adapter。

## 关键行为（都有测试锁定）

- **失败判定看 finish chunk**：宿主的 `adapterStream` 把 adapter 抛的错转成
  `{type:'finish', reason:{kind:'error'|'aborted', failure}}` 产出，**不 throw**。
  所以不能靠 try/catch 判失败。
- **思考阶段失败照样切**：`reasoning-delta` 不算「已提交」，思考内容整段丢弃
  —— 「想了半天才撞额度墙」正是最该切换的场景。
- **一旦吐出正文就不再切**：否则前言不搭后语。已提交后中途出错，异常**原样上抛**
  （对齐宿主「middleware / consumer failures remain thrown」的约定），绝不吞掉。
- **调用方取消不切备选**：`aborted` 不是故障，不再拿别的候选去打扰上游。
- **空流视为失败**：正常结束却一个字正文都没有，对用户就是失败。
- **只匹配链头**：链上的备选（比如 buddy）被别处直接请求时不接管，避免成环。
- **不修改入参对象**：宿主可能把 `options` 冻结，一律返回新对象。
- **提前退出会关掉上游迭代器**：否则 HTTP 流跑完、socket 泄漏。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: channel-fallback
      name: dsh-channel-fallback
      config:
        enabled: true
        chains:
          - name: flash-free-first
            candidates:
              - provider: workbuddy
                model: deepseek-v4.1-flash
              - provider: buddy
                model: deepseek-v4.1-flash
```

可选字段：

| 字段 | 说明 |
|---|---|
| `enabled: false` | 整体关闭（不注册监听器） |
| `name` | 仅用于日志 |
| `head` | 显式指定链头；默认取 `candidates[0]`。写非法则整条链丢弃 |
| `candidates[].reasoningEffort` | 字符串 = 覆盖；`null` = 删掉该字段（跨 provider 档位不同时用） |
| `candidates[].maxTokens` | 正整数 = 覆盖；`null` = 删掉 |

配置非法时**静默不注册**，绝不让宿主起不来。

面板保存过的链会覆盖这里 —— 见下面「状态文件」一节。

## 可视化面板（可编辑）

设置页里多一个 **「渠道回退」** 分区（紧跟在「微信」后面），显示：

- **链**：每个候选一行，带序号、「优先」/「兜底」标签、渠道名，右侧是 `↑` `↓` `删除`；
- **计数**：请求 / 切换 / 成功 / 全挂 / 取消 / 直通 六格；
- **事件**：最近 60 条，倒序（新的在上），每条带时间、类型、候选与耗时 / 尝试次数、
  失败码与 HTTP 状态、失败消息。

### 能改什么

| 操作 | 行为 |
|---|---|
| `↑` / `↓` | 调整候选顺序 —— **第一个永远是优先尝试的那站** |
| `删除` | 从链里去掉一个候选；**只剩一个时按钮禁用**（删空等于没有回退） |
| `+ 添加模型` | 弹出模型清单，按渠道筛选，点一下加进链尾；已在链里的显示「已加入」且不可点 |
| `测试` | 向该模型发一次极小请求（`Reply with exactly: OK`，30 秒超时），**见到正文即成功**；徽章显示 `✓ 1.2s` 或 `✗ 错误码`，方便发现挂掉的候选随手删掉 |
| `保存` | `POST /api/channel-fallback/chains`，**写盘成功后才改内存**，下一个请求立即走新链 |
| `放弃修改` | 草稿回到快照的样子 |
| `恢复默认` | 先要确认，再 `POST {reset:true}` —— 删掉状态文件，链回到 `cordis.patch.yml` 的配置 |

改动只落在**草稿**上，点「保存」才落盘；没保存时标题栏会显示「有未保存的改动」。
保存失败会把后端给的原因（比如「第 1 条链至少有 1 个候选」）原样显示出来，
并且**同时**继续显示「有未保存的改动」—— 存失败不等于改动没了。

连通测试的几个设计点：

- 测试走**真的 adapter 流**（`llm.stream` 直调），不是只查目录 —— 「目录里有」
  不等于「现在能用」；
- 用 `AsyncLocalStorage` 标记自己发起的调用，测试流量**不会被路由接管、不写进
  事件流、不进计数**；
- 测试结果永远是 HTTP 200（`ok` 在 body 里），只有参数错（400）、同模型并发
  测试（409）、`llm` 服务缺失（503）才是非 200 —— 前端好渲染徽章。

`editable: false`（宿主没给编辑能力时）所有按钮一律禁用。

### 状态文件：为什么不是写回 `cordis.patch.yml`

链存在 `~/.dsh/channel-fallback/chains.json`（可用 `DSH_CHANNEL_FALLBACK_STATE` 覆盖）。
**不写回 patch 配置**，原因三条：

1. patch 是用户手写的、带注释的，里面还夹着 qq-bridge 那段「会被整体替换，请勿手工编辑」的条目，
   机械回写会吃掉注释，还获得了破坏整份 profile 配置的能力；
2. 官方没有「插件写回自己 config」的机制 —— config 是启动时的只读输入
   （`ctx.settings.write` 另有一套 volatile schema 校验，不适合自存任意小 JSON）；
3. 本机两个先例都是自己在 `~/.dsh/<插件名>/` 存状态文件：
   `~/.dsh/channel-pack/state.json`、`~/.dsh/our-free-model/settings.json`。

**规则：配置文件是默认值，状态文件是用户覆盖；删掉状态文件即回到配置文件的样子**
（面板「恢复默认」就是干这个的）。

写盘是原子的（`mkdir` → 写 `tmp-${pid}-…` → `rename`），失败会清掉临时文件并**抛出**，
不会假装保存成功。

### 后端接口

| 方法与路径 | 说明 |
|---|---|
| `GET /api/channel-fallback/state` | 快照：链、计数、事件，外加 `editable` / `source` / `savedAt` / `revision` / `defaults` / `providers` / `file` |
| `POST /api/channel-fallback/chains` | 保存整份链；`{reset:true}` 恢复默认。body 上限 64KB，超限 413，坏 JSON 400 |
| `GET /api/channel-fallback/models` | 列出可选模型（懒加载，`?provider=buddy` 可过滤）。单个渠道查不到不影响其它，进 `failed` |
| `POST /api/channel-fallback/test` | 连通测试。body 写 `{provider, model}`（可测没进链的模型）或 `{chainIndex, candidateIndex}`（测链上第几站）；返回 `{ok, totalMs, ttft?}` 或 `{ok:false, error, code, status?}` |

`/chains` 只收 POST、`/models` 只收 GET/HEAD，其余方法回 405 且带 `allow` 头。
列模型走的是宿主的 `llm.listProviders()` + 逐 provider `llm.listModels()` —— 宿主
**没有**聚合的 `catalog()`，只能这样拼；某个渠道拉取失败不该让整页空白。

### 安全栅栏（必须有，不是可选）

宿主 `webServer` 的分发规则是 **最长前缀优先**（`dsh-host-webserver` 原文：
*"Longest-prefix-wins over the prefix table after an exact-table miss"*），而我们注册的
`/api/channel-fallback` 比内核认证用的 `/api` **更长** —— 于是我们的 handler 会**先于**
`connection` 服务的准入检查执行。不加栅栏，任何能连 127.0.0.1 的进程、以及被 DNS
rebinding 骗进环回的网页，都能读到这页数据。

（OFM 踩过同一个坑并把边界写进了 `src/trust.js` 的注释里，本插件按同样的思路封口。）

`lib/trust.js` 两层：

1. **优先问内核**：拿得到 `connection` 服务就用 `connection.admit(req)`，拒绝码原样
   透出（内核给 401 就回 401，不统一改写成 403）。服务**已挂载但抛错 → 503 fail-closed**，
   绝不放行 —— 放行等于把浏览器认证关掉。
2. **内核缺席时自己复刻结构规则**：Host 必须环回 → 拒 `sec-fetch-site: cross-site` →
   若带 `Origin`/`Referer`，scheme/hostname/port 必须与 Host 完全一致
   （`dsh-app://app` 是桌面壳的唯一例外，且它不能同时带 `origin`/`sec-fetch-site`）。

`connection` 用 **thunk 每次请求重新求值**，不能抓一次实例 —— 它可能比本插件晚发布，
缓存了就会永远停在「服务不存在」这个降级分支上。

为什么是「挂 `webServer`」而不是「注册 adapter」：`webServer` 必须通过
`ctx.inject(['webServer'], …)` 拿 —— 写进插件顶层 `inject` 会让 headless profile
（没有 Web 服务器）整个插件不 apply，**连路由一起陪葬**。同理，`ctx.inject`
缺失时也要守卫（probe / 单测 / 嵌入式宿主的最小 ctx 没有它）。

浏览器半侧是手写的 `client.js`，**不需要构建步骤**：

```js
window.__ModuleLoader__.load({
  // 必须是 package.json 的 name —— 宿主拿它当 boot graph 的 entry id
  id: 'dsh-channel-fallback',
  factory: (require) => { const React = require('react'); /* ... */ return { name, inject, apply } },
})
```

必须遵守的细节：

0. **注册 `id` 必须等于包名**（`package.json` 的 `name`），不是插件短名
   `channel-fallback`。宿主的 `client-modules` 只按 entry id 找工厂，写短名时
   脚本能正常执行，但会报
   `loaded without registering "dsh-channel-fallback"`，整块 client 不激活。
1. **整个文件包一层 IIFE**。外壳把 client 当 classic script 加载，HMR 重建会在同一
   realm 里再求值一次；顶层 `let/const/class` 会直接
   `Identifier '…' has already been declared`。
2. **`apply` 里拿不到 React**。`require('react')` 只在 factory 作用域内存在，所以
   factory 把组件挂到 `window.__channelFallback`，`apply` 注册的是转发它的薄壳。
3. **样式用 `getElementById` 去重**，重复 apply 不叠加；dispose 时把 `<style>` 删掉。

改了 `client.js` 之后，运行中的宿主会通过 `client-hmr`（500ms 轮询 + SSE）发现
bundle 变化并热重载；如果页面没反应，刷新一次即可。注意：`pnpm run dev:web` 是
DSH 自身前端的构建入口，与本插件无关。

## 安装

从 GitHub 装（推荐）：

```powershell
dsh plugin --profile web add github:KaBshou/dsh-channel-fallback
```

本地目录装（开发时）：

```powershell
dsh plugin --profile web add <本仓库检出的路径>
```

重启 DSH 生效（面板也要重启后才出现）。

要求：DSH `0.2.x`（peerDependencies 写的是 `>=0.2.0-rc.1 <0.3.0-0`）、Node `^22.19.0 || >=24.0.0`。

## 验证

```powershell
cd <本仓库检出目录>
npm test
```

等价于依次跑：

```powershell
node --test lib/chain.test.js lib/state.test.js lib/store.test.js   # 41 项单测（路由 16 + 记录 8 + 持久层 17）
node probe.mjs           # 15 项整链编排验证（假 ctx 复刻宿主瀑布语义）
node probe-panel.mjs     # 33 项宿主面板验证（路由、保存、列模型、热生效、413/写盘失败、信任栅栏 5 组、方法限制、连通测试 7 项）
node probe-client.mjs    # 28 项浏览器侧验证（mini React + 假 DOM + vm 求值真实 client.js，含增删改/保存/恢复默认/测试按钮）
node probe-redgreen.mjs  # 17 项红绿验证（内存里改坏 client.js，断言对应用例真的会红）
```

最后那个 `probe-redgreen.mjs` 是为了防止「测试全绿但其实什么都没测到」：它把
`client.js` 的源码在**内存里**改坏（不碰磁盘），让 probe-client 编译一份临时文件
去跑，断言「必须失败，而且失败的正是该失败的那条用例」。17 条突变全部被抓住。

`probe-client.mjs` 里两个替身细节值得记：`expand()` **必须递归进普通元素的 children**，
否则 `Page` 里的子组件节点不会被展开 —— 文字仍能渲出来（看起来一切正常），但一个按钮
都找不到，所有点击用例集体误报「按钮不存在」；`useEffect` 只能跑第一轮，
否则每次重渲都会重新 `load()`，把用户刚做的编辑冲掉。

### 真实宿主端到端（已通过）

用临时 profile（headless + 本插件）跑真实进程，
把默认模型与链头都指到 `workbuddy/no-such-model-xyz`（必然 400）：

```
[14:26:32.401Z] 已装载 1 条链：fb-test-proof: workbuddy/no-such-model-xyz → buddy/deepseek-v4.1-flash
[14:26:33.801Z] 链跳过 workbuddy/no-such-model-xyz：INVALID_REQUEST status=400 workbuddy: 当前模型不可用…
[14:26:35.724Z] 链跳过 buddy/deepseek-v4.1-flash：UNKNOWN session-title provider "session-title-first-prompt-llm" was disposed
```

最终模型输出 **「收到」** —— 第 1 站真失败、自动跳到第 2 站并成功。
（末尾那条 `session-title…was disposed` 是会话标题生成用的旁路小请求被插件接管后自行放弃，不影响主对话。）

诊断日志（每次切换写一行）：

```powershell
$env:DSH_CHANNEL_FALLBACK_LOG = '1'
# 日志：%TEMP%\dsh-channel-fallback.log
```
