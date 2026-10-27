# dsh-channel-fallback

把「**优先 A、A 用不了自动切 B**」的模型链，注册成 DSH 模型选择器里的**一个条目**。

选中它，请求就按链上的顺序走；前一个失败，自动换下一个，对上层完全透明。
不选它，什么都不会变 —— 装上插件不等于接管你的请求。

支持任意多级兜底（A → B → C → …）、任意多条链、每站独立推理档位，
带一个可视化面板：新建/改名/删除链、加减模型、调顺序、**一键连通测试**、看切换统计。

## 它解决什么问题

`workbuddy/deepseek-v4.1-flash` 在仓库网关的元数据里标着 **x0.00→免费**，
`buddy/deepseek-v4.1-flash` 标着 **x0.11**，两者能力完全一致
（contextWindow 1e6、支持图片、reasoningEfforts 都含 `high`）。
所以「先免费、后付费」是严格更优的顺序 —— 但 WorkBuddy 会时不时撞上
额度上限 / 频率限制 / 新加坡区额度耗尽。

## 为什么是「注册一个 provider」而不是「拦 llm/stream」

v0.4.0 用的是在宿主 `llm/stream` waterfall 上挂监听器的做法（命中链头就接管）。
它有个根本问题：**装上插件就自动生效**，用户没有任何办法在界面上表达
「这次我不想用链」。而且链头被硬编码在配置里，换一条链要改配置文件。

v0.5.0 改成**注册一个虚拟 provider** `dsh-channel-chain`（显示名「渠道链」），
每条链是它下面的一个 model（model id 就是链 id）。这样：

- 链出现在**模型选择器**里，和真实渠道并列 —— 用户主动选才走链；
- 会话的默认模型、模型切换、子 agent、后台任务**全部自动支持**，
  因为它们本来就走同一套 `provider`/`model` 选择机制；
- 不需要在宿主里加任何新概念，宿主也不知道「链」是什么。

宿主契约（读 `@deepseek-ai/dsh-llm` 源码确认，2026-10-27）：

```js
llm.registerAdapter([providerId], { providerInfo, providerRetryPolicy, listModels, resolveModel, prepareCall, stream })
```

`listModels` 返回的每个 model 必须能被 `resolveModel` 解析出来，
且 `provider`/`id`/`name` 必须对得上（否则 `INVALID_CATALOG` / `INVALID_MODEL_INFO`）。
**`listModels` 返回空数组时整组会从选择器里消失**（宿主
`buildModelCatalog` 有 `.filter(group => group.models.length > 0)`）—— 这正是
「没有链时不该出现一个点了就报错的空组」的期望行为。

`prepareCall` 返回的 `stream` 里，我们用**真实 provider** 再调一次
`ctx.llm.stream({...options, provider: candidate.provider, model: candidate.model})`。
这不是递归：宿主按 `options.provider` 查 adapter，此时查到的已经是真实渠道的 adapter。

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

## 关键行为（都有测试锁定）

- **失败判定看 finish chunk**：宿主的 `adapterStream` 把 adapter 抛的错转成
  `{type:'finish', reason:{kind:'error'|'aborted', failure}}` 产出，**不 throw**。
  所以不能靠 try/catch 判失败。
- **思考阶段失败照样切**：`reasoning-delta` 不算「已提交」，思考内容整段丢弃
  —— 「想了半天才撞额度墙」正是最该切换的场景。
- **一旦吐出正文就不再切**：否则前言不搭后语。已提交后中途出错，失败**如实透传**
  （不吞掉，也不偷偷换站）。
- **调用方取消不切备选**：`aborted` 不是故障，不再拿别的候选去打扰上游。
- **空流视为失败**：正常结束却一个字正文都没有，对用户就是失败。
- **不修改入参对象**：宿主可能把 `options` 冻结，一律返回新对象。
- **提前退出会关掉上游迭代器**：否则 HTTP 流跑完、socket 泄漏。
  这里有个易错点：消费方可能**就在「提交第一个正文块」那一刻** `break`，
  此时 `restOf()` 还没被创建 —— 所以要一个独立的 `handedOff` 标志，
  在进入 `restOf` **之前**置位，`finally` 里判它。
- **候选不能是「渠道链」自己**：`/models` 列表和保存时都会拦，否则成环。

## 推理档位怎么定

优先级：**候选固定 > 链级 > 调用方**。

| 层级 | 说明 |
|---|---|
| 候选固定 | 面板上每行一个下拉，写在这一站上。**这一站自己说了算** |
| 链级 | 面板上链标题旁的下拉，作用于链上所有没写固定档位的站 |
| 调用方 | 会话/选择器传进来的 `reasoningEffort` |

三个下拉都有同一个选项：**「自动」**（存成 `null`）。它的意思不是「没设置」，
而是「到这一层就停，别往下继承」—— 用户明确说了自动，插件就别自作主张。
这和「留空」不同：留空 = 字段不存在 = 继续往下继承。

为什么候选固定优先于链级：链上不同 provider 支持的档位可能根本不同
（`workbuddy` 只有 `high`，`buddy` 有 `low`/`high`/`max`）。链级选 `low` 切到
`workbuddy` 就会被宿主以 `UNSUPPORTED_REASONING_EFFORT` 拒掉。

链的**档位并集**由 `resolveModel` 上报给选择器（各站 efforts 求并集，
默认值取链头那站的）—— 用户在界面上看到的是全貌，具体哪站支持什么由运行时处理。

降级规则（`pickEffort`）：

- 候选写了 `null`（面板上的「自动」）→ 这一站不指定档位（让上游用默认），不再往下找；
- 链级写了 `null` → 整条链都用上游默认，**连调用方也不看**；
- 候选/链级/调用方给了档位，但**这一站明确不支持** → 继续往下退，
  最后都退不了就删掉字段；
- **查不到**这一站支持什么（provider 离线、目录里没这个模型）→ **不猜，放行**，
  让宿主抛准确的错误 —— 猜错比报错更糟。

## 切换前测速

链的顺序是**静态**的，上游的可用性和速度是**动态**的。链头挂了以后，
配置里的第二个不一定就是现在最快的那个。

打开链标题旁的「切换前测速」后：**真要换站的那一刻**，并发给剩下的每一站
发一个极小的探测请求（`maxTokens: 1`，问 `hi`），按实测首字延迟重排，
再按新顺序继续切。

- 探测**不继承**思考档位（否则测到的是「思考多久」而不是「多久能开口」）；
- 只探**剩下的**候选，已经试过的不重复探；
- 探不通的排最后，但**不剔除** —— 万一探测本身被限流，它还有机会；
- 探测失败（异常/超时）就按原顺序继续，探测不该拖垮这次调用；
- 一次调用**只测一次**（每站都重测会让一次失败变成 N 次探测，越切越慢）。

代价：每次切换多 1–3 秒 + 一点额度。所以**默认关**，只认显式 `speedProbe: true`。
面板事件流里会多一类「测速」事件，显示探通的那家和耗时。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: channel-fallback
      name: dsh-channel-fallback
      config:
        enabled: true
        chains:
          - id: flash-free-first
            name: flash-free-first
            reasoningEffort: auto        # 整条链都用上游默认档位
            speedProbe: true             # 切换前并发测速，按实测最快切
            candidates:
              - provider: workbuddy
                model: deepseek-v4.1-flash
              - provider: buddy
                model: deepseek-v4.1-flash
                reasoningEffort: high    # 这一站固定 high
```

可选字段：

| 字段 | 说明 |
|---|---|
| `enabled: false` | 整体关闭（不注册 provider） |
| `id` | 链的 id = **模型选择器里的 model id**。不写则按 `name` 自动 slug |
| `name` | 显示名，也是选择器里那一行 |
| `reasoningEffort` | 链级档位：字符串 = 固定；`null` 或 `'auto'` = **整条链自动**（连调用方也不看） |
| `speedProbe` | `true` = 切换前并发测速、按实测速度重排。**只认显式 true**，缺省关 |
| `candidates[].reasoningEffort` | 字符串 = 固定该站档位；`null` 或 `'auto'` = 这一站自动（不再往下继承） |
| `candidates[].maxTokens` | 正整数 = 覆盖；`null` = 删掉该字段 |

配置非法时**静默不注册**，绝不让宿主起不来。

面板保存过的链会覆盖这里 —— 见下面「状态文件」一节。

## 可视化面板（可编辑）

设置页里多一个 **「渠道链」** 分区，显示：

- **链**：每条链一张卡片，链名可改、链级档位可选、带**「切换前测速」开关**与删除按钮；
  每个候选一行，带序号、「优先」/「兜底」标签、渠道名、**倍率**、
  **推理档位下拉**，右侧是 `测试` `↑` `↓` `删除`；
- **计数**：请求 / 切换 / 成功 / 全挂 / 取消 / 直通 六格；
- **事件**：最近 60 条，倒序（新的在上），每条带时间、类型、候选与耗时 / 尝试次数、
  失败码与 HTTP 状态、失败消息。

顶部有一行说明：**在会话的模型选择器里选「渠道链 · 链名」即可启用；不选就不影响任何请求。**

### 能改什么

| 操作 | 行为 |
|---|---|
| `+ 新建链` | 追加一条空链，名字自动编号，id 按名字 slug（冲突则加 `-2`） |
| 链名输入框 | 改名，**同时换新 id** —— 同名不同 id 会让选择器里出现两个看不出区别的条目 |
| 链级档位下拉 | 选项 = 链上各站档位的**并集**（具体降级由运行时处理）；第一项「跟随上游默认」，第二项「自动」 |
| 「切换前测速」 | 勾上后，链头失败要换站时会先并发探测剩下的站，按实测速度决定顺序（见上文「切换前测速」） |
| `删链` | 删掉整条链；**只剩一条时禁用** |
| 候选档位下拉 | 每站固定档位；选项顺序「跟随上游默认」→「自动」→ 该站真实支持的档位 |
| `↑` / `↓` | 调整候选顺序 —— **第一个永远是优先尝试的那站** |
| `删除` | 从链里去掉一个候选（链**允许没有候选**，面板会提示「先加一个」） |
| `+ 添加模型` | 弹出模型清单，按渠道筛选，点一下加进链尾；已在链里的显示「已加入」且不可点 |
| `测试` | 向该模型发一次极小请求（`Reply with exactly: OK`，30 秒超时），**见到正文即成功**；徽章显示 `✓ 1.2s` 或 `✗ 错误码`，方便发现挂掉的候选随手删掉 |
| `保存` | `POST /api/channel-fallback/chains`，**写盘成功后才改内存**，保存后立刻广播 `llm/adapters-updated`，选择器里的分组立即刷新 |
| `放弃修改` | 草稿回到快照的样子 |
| `恢复默认` | 先要确认，再 `POST {reset:true}` —— 删掉状态文件，链回到 `cordis.patch.yml` 的配置 |

改动只落在**草稿**上，点「保存」才落盘；没保存时标题栏会显示「有未保存的改动」。
保存失败会把后端给的原因原样显示出来，并且**同时**继续显示「有未保存的改动」
—— 存失败不等于改动没了。

**`id` 必须原样带回**：它是模型选择器里的 model id，也是会话里已经记住的选择。
草稿丢掉 id 再保存，等于把所有正在用这条链的会话换成新 id，用户的选择会突然失效。

连通测试的几个设计点：

- 测试走**真的 adapter 流**（`llm.stream` 直调），不是只查目录 —— 「目录里有」
  不等于「现在能用」；
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
| `GET /api/channel-fallback/state` | 快照：链（含 `id`、倍率）、计数、事件，外加 `editable` / `source` / `savedAt` / `revision` / `defaults` / `providers` / `file` / `providerId` / `providerName` |
| `POST /api/channel-fallback/chains` | 保存整份链；`{reset:true}` 恢复默认。body 上限 64KB，超限 413，坏 JSON 400，候选含渠道链自己 400 |
| `GET /api/channel-fallback/models` | 列出可选模型（懒加载，`?provider=buddy` 可过滤）。**已剔除渠道链自己**；单个渠道查不到不影响其它，进 `failed` |
| `GET /api/channel-fallback/efforts` | 查某站的推理档位，需要 `?provider=&model=`；查不到也回 200 并带 `error` |
| `POST /api/channel-fallback/test` | 连通测试。body 写 `{provider, model}`（可测没进链的模型）或 `{chainIndex, candidateIndex}`（测链上第几站）；返回 `{ok, totalMs}` 或 `{ok:false, error, code, status?}` |

`/chains` 和 `/test` 只收 POST，`/models` 和 `/efforts` 只收 GET/HEAD，
其余方法回 405 且带 `allow` 头。列模型走的是宿主的 `llm.listProviders()` +
逐 provider `llm.listModels()` —— 宿主**没有**聚合的 `catalog()`，只能这样拼；
某个渠道拉取失败不该让整页空白。

**倍率预热**：倍率是渠道拼在模型显示名里的（形如 `Deepseek-V4.1-Flash · x0.00→免费`），
从 `listModels` 的 `name` 里解析。`/state` 会先 `await catalog.warm(...)`
把链上各站的模型清单拉一遍（带 5 分钟 TTL 缓存）再出快照 —— 否则首次打开面板
倍率全是空的，用户会以为没实现。

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

**面板先挂、adapter 后注册**：`llm` 服务不可用时也要把面板挂上 ——
面板是观测面 + 用户修链的唯一入口，不能因为 adapter 注册失败就一起陪葬。
`registration` 因此用 thunk 传给面板 handler。

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

**重启 DSH 生效**（provider 是启动时注册的；面板也要重启后才出现）。

装好后打开设置页 →「渠道链」，配好链；再到任意会话的**模型选择器**里
选「渠道链」分组下的那条链即可。

要求：DSH `0.2.x`（peerDependencies 写的是 `>=0.2.0-rc.1 <0.3.0-0`）、Node `^22.19.0 || >=24.0.0`。

## 验证

```powershell
cd <本仓库检出目录>
npm test
```

等价于依次跑：

```powershell
node --test lib/chain.test.js lib/state.test.js lib/store.test.js lib/speed.test.js
                          # 59 项单测（链 24 + 记录 8 + 持久层 17 + 测速 11）
node probe.mjs           # 21 项整链编排验证（假 ctx 复刻宿主 adapter 语义，含测速与自动档）
node probe-panel.mjs     # 42 项宿主面板验证（路由、保存、列模型、档位查询、热生效、413/写盘失败、信任栅栏 5 组、方法限制、连通测试、自动档/测速落盘）
node probe-client.mjs    # 35 项浏览器侧验证（mini React + 假 DOM + vm 求值真实 client.js，含新建/改名/删链/档位/自动/测速开关/保存/恢复默认/测试按钮）
node probe-redgreen.mjs  # 25 项红绿验证（内存里改坏 client.js，断言对应用例真的会红）
```

最后那个 `probe-redgreen.mjs` 是为了防止「测试全绿但其实什么都没测到」：它把
`client.js` 的源码在**内存里**改坏（不碰磁盘），让 probe-client 编译一份临时文件
去跑，断言「必须失败，而且失败的正是该失败的那条用例」。25 条突变全部被抓住。

红绿验证抓到过一次**假绿**，值得记：断言 probe 事件行里有「测速」二字，
但链头复选框的文案「切换前**测速**」也含这两个字 —— 于是那条断言永远成立。
修法是让该用例的夹具用 `chains: []`（页面上没有复选框），断言才真正指向事件行。

`probe-client.mjs` 里两个替身细节值得记：`expand()` **必须递归进普通元素的 children**，
否则 `Page` 里的子组件节点不会被展开 —— 文字仍能渲出来（看起来一切正常），但一个按钮
都找不到，所有点击用例集体误报「按钮不存在」；`useEffect` 只能跑第一轮，
否则每次重渲都会重新 `load()`，把用户刚做的编辑冲掉。

探针还必须**隔离状态文件**：`probe.mjs` 在 import 之后设
`process.env.DSH_CHANNEL_FALLBACK_STATE = <tmp>`（`stateFilePath()` 每次调用现读
环境变量，所以 import 后设置也有效），否则会读到用户真实的
`~/.dsh/channel-fallback/chains.json` 并把它覆盖掉，所有断言都在测「用户当前的链」。

### 真实宿主端到端（已通过，2026-10-27）

临时 profile + 本插件跑真实进程（端口 3098），三件事全绿：

**1. 渠道链真的进了宿主的模型目录**（`session/modelCatalog` 远程调用）：

```
ok=true groups=14
 · deepseek-account — 2      · buddy — 3          · our-free-model — 4
 · agnes — 1                 · workbuddy — 4      · dsh-channel-chain ★ — 1
 · codearts — 1              · cline — 4          · loomy — 1  · raccoon — 1
 · minimax — 1               · gemini — 1         · modlens-* — 2

id   = flash-free-first
name = flash-free-first（workbuddy/deepseek-v4.1-flash → buddy/deepseek-v4.1-flash）
档位 = low/high/max  默认 = high      ← 各站并集
```

**2. 整条链能跑通**：`POST /test {provider:'dsh-channel-chain', model:'flash-free-first'}`
→ `{ok:true, totalMs:2766}`。

**3. 真失败真的会切**：存一条链头指向 `workbuddy/no-such-model-xyz`（必然 400）的链，
再测它：

```
事件: start(failover-probe)
      skip(workbuddy/no-such-model-xyz)
      win(buddy/deepseek-v4.1-flash)
计数: {requests:2, switches:1, wins:2, exhausted:0, aborted:0, passthrough:0}
```

`switches: 1` 就是自动切换的铁证。

### v0.5.1 真机验证（已通过，2026-10-27）

临时 profile（端口 3099）+ 隔离状态文件跑真实进程：

- **自动档落盘正确**：`POST /chains` 写 `reasoningEffort: null` / `'auto'`，读回都是
  `null`（链级与候选级都对），磁盘 JSON 也是 `null`；
- **测速开关落盘正确**：`speedProbe: true` 保存后原样读回；
- **成环防护**：候选写 `dsh-channel-chain` → 400；
- **`/efforts` 正常**：`buddy/deepseek-v4.1-flash` → `["low","high","max"]` 默认 `high`；
- **测速排序接真实上游跑通**（`lib/speed.js` 直连 8326 网关的 OpenAI 兼容流）：

  ```
  单站探测：buddy 4064ms / trae 2838ms / workbuddy 1978ms
  并发探测：buddy 1890ms, workbuddy 3236ms, trae 3237ms
  排序结果：buddy → workbuddy → trae      ← 按实测最快排，不是配置顺序
  ```

诊断日志（每次切换写一行）：

```powershell
$env:DSH_CHANNEL_FALLBACK_LOG = '1'
# 日志：%TEMP%\dsh-channel-fallback.log
```

## 版本

- **v0.5.1** — 档位「自动」（`null`/`'auto'`，到这一层就停，不再往下继承）+
  链级「切换前测速」（`speedProbe`，切换时并发探测剩余候选、按实测首字延迟重排，
  默认关）。59 单测 + 21 编排 + 42 面板 + 35 客户端 + 25 红绿全绿。
- **v0.5.0** — 架构转向：链从「llm/stream 拦截器」变成「模型选择器里的一个 provider」。
  新增多链（新建/改名/删除）、倍率显示、每站与链级推理档位、`/efforts` 接口、
  `warm()` 倍率预热、`handedOff` 修 socket 泄漏。41 单测 + 18 编排 + 40 面板 +
  28 客户端 + 17 红绿全绿。
- **v0.4.0** — 首个公开发布：可编辑链 + 可视化面板 + 连通测试。
- **v0.3.0** — 后端支持编辑链（`/chains` 保存、状态文件）。
- **v0.2.0** — 可视化面板（只读）。
- **v0.1.0** — 链式回退核心。

## 许可

MIT
