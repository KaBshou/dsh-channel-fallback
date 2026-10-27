// dsh-channel-fallback —— 让 DeepSeek V4.1 Flash 优先走国际版（免费额度），
// 用不了自动切国内版，对上层完全透明。
//
// 为什么是自己写而不是用现成的（能力盘点结论，2026-10-26，逐条查过源码）：
//
//   ① `dsh-our-free-model` 自带 combos 有 `fallback` 策略，语义正是想要的，
//      但 `buildComboCatalog` 只认 OFM 自己的 catalog；`buddy`/`workbuddy`
//      由 channel-pack 用 `registerAdapterIdempotent` 单独注册成 provider，
//      不在 OFM catalog 里 → **串不起来**。
//   ② `@deepseek-ai/dsh-llm-retry` 只做「同一 provider 重试」：
//      `recover({ provider, failure, ... })` 拿到的 provider 就是失败的那个，
//      函数体内没有任何切换 provider 的逻辑。
//   ③ `dsh-llm-pi-ai` 的 `providers` 是配置面（每键一个路由名），文档全篇
//      没有「失败切另一个 provider」的描述，只有单路由内重试。
//   ④ `channel-pack` 的 `providerOrder` 是「供应商开关」弹窗的拖拽排序，
//      纯展示偏好（源码注释原文：「纯展示偏好，可逆」）。
//   ⑤ OFM aggregate：`providerModelId()` / `parseProviderModelId()` 要求模型 id
//      前缀必须是 `src/providers/registry.json` 里已注册的 provider，
//      无法用「自定义 baseUrl + 自定义模型 id」凭空造一个指向本地网关的 provider。
//   ⑥ `channel-pack` 的 `fallbackModels` 是「远端拉不到模型清单时的静态兜底」，
//      只用于 listModels 补目录；`shouldFallbackToOtherChannel` 是**同渠道切账号**
//      （仅 429 + 1005/1113），都不是切模型。
//
// 于是走宿主自己的正式扩展点（`@deepseek-ai/dsh-llm` 的 `LlmRuntime`）：
//
//   `streamWithRegistration()` 里每一轮 `ctx.llm.stream()` 都是一次
//   `ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`。
//   waterfall 的语义是「每个监听器包住余下的链，调 next() 继续，返回值即最终流」
//   （cordis `events.ts:79-84` 原文）。因此监听器里可以：
//     · 把 options 换成链上另一个 provider/model；
//     · 再调一次 `ctx.llm.stream()` —— 这是我们**主动发起**的外层调用，
//       不会被当成递归（用 AsyncLocalStorage 标记自己发起的调用，见到标记就
//       立刻 `next()` 透传，交给真正的 adapter）。
//
//   社区既有做法：`dsh-cost-meter` 的注释记录 modlens / vision-router 就是
//   「在监听器体内（瀑布派发期）急切发起上游调用」的包装路由插件。
//
// 关键约束（踩过的坑，别改坏）：
//   · **必须先用 `next()` 拿到下游流**再决定怎么做 —— waterfall 里不调 next 等于
//     否决整条链。
//   · **失败只能看 finish chunk**：宿主的 `adapterStream` 把 adapter 抛的错转成
//     `{type:'finish', reason:{kind:'error'|'aborted', failure}}` 产出，不 throw。
//   · **`reasoning-delta` 不算已提交**：思考阶段撞额度墙正是最该切换的场景。
//   · **消费方提前退出（break / abort）必须显式关掉上游迭代器**，否则 HTTP 流会
//     跑完、socket 泄漏（照 `dsh-cost-meter/lib/billing-stream.js` 的写法）。
//   · **不接管链上备选自己发起的请求**（只匹配链头），否则会形成环。
//
// 诊断：`DSH_CHANNEL_FALLBACK_LOG=1` 时把每次切换写进
// `<系统临时目录>/dsh-channel-fallback.log`。
//
// 可视化面板（2026-10-26 加）：
//   · 宿主侧在 `/api/channel-fallback/state` 吐一份快照（链配置 + 累计计数 +
//     最近 60 条事件），由 `webServer.register` 以 prefix 方式挂载。
//   · 浏览器侧是 `client.js`（设置 → 渠道回退 一页）。
//   · 记录全部走 `lib/state.js` 的有界内存，**不参与路由决策** —— 记录层出问题
//     最坏是面板空白，绝不会让模型请求失败。
//
// 可编辑的链（2026-10-27 加）：
//   · `POST /api/channel-fallback/chains` 保存链配置，`POST …/reset` 恢复默认。
//   · 存进 `~/.dsh/channel-fallback/chains.json`（`lib/store.js`），**不回写
//     `cordis.patch.yml`** —— 那是用户手写带注释的文件，还夹着别的插件的条目。
//     规则是「配置文件给默认值，状态文件给用户覆盖」，删掉状态文件即回到默认。
//   · 热生效靠 `chainState.chains` 这个可变持有者：`apply()` 里建立一次，
//     `wrapChainStream` 每次请求都现读。写盘成功后下一个请求就走新链，无需重启。
//     这也是 subagent 查证的结论（Q3/Q4）：不用重注册 adapter，链是纯数据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  DEFAULT_CHAINS,
  candidateOptions,
  describeFinish,
  failureFinish,
  isFailureFinish,
  matchChain,
  normalizeChains,
  pickCandidate,
  shouldCommit,
} from './chain.js';
import { createRecorder } from './state.js';
import {
  MAX_BODY_BYTES,
  parseChainsPayload,
  readChainFile,
  removeChainFile,
  stateFilePath,
  writeChainFile,
} from './store.js';
import { rejectionFor } from './trust.js';

/** Cordis 插件名。 */
export const name = 'channel-fallback';

/**
 * 只硬性依赖 `llm`。
 *
 * `webServer` **不能**写进这里：headless profile 没有 Web 服务器，若把它列为
 * 硬依赖，整个插件在 headless 下就不会 apply —— 路由也就没了。面板是可选功能，
 * 用 `ctx.inject(['webServer'], ...)` 按需等它就绪（OFM 的 `index.js:1394` 同款写法）。
 */
export const inject = ['llm'];

const LOG_PATH = path.join(os.tmpdir(), 'dsh-channel-fallback.log');

/** 面板 API 的路径前缀。 */
const API_PREFIX = '/api/channel-fallback';

/**
 * 单次连通测试的最长等待。
 *
 * 30 秒是「慢渠道也能答完一句 OK」和「用户不至于盯着转圈太久」之间的折中；
 * 超时后 AbortController 会掐断上游流，测试按失败处理。
 */
const TEST_TIMEOUT_MS = 30_000;

/** 正在进行的连通测试（`provider/model` → true），防止同一候选被并发测试。 */
export const testInflight = new Set();

/**
 * 标记「这条流是我们自己为了尝试下一个候选而发起的」。
 *
 * 见到标记就立刻 `next()` 透传，不再包装 —— 否则链上最后一个候选失败时，
 * 监听器会再去尝试一次，无限递归。
 */
const innerCall = new AsyncLocalStorage();

/** 是否开启诊断日志。 */
function loggingEnabled() {
  const flag = process.env.DSH_CHANNEL_FALLBACK_LOG;
  return flag === '1' || flag === 'true';
}

/**
 * @param {string} message
 */
function diag(message) {
  if (!loggingEnabled()) return;
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 诊断写不进去不能影响主流程。
  }
}

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文，已注入 `llm`。
 * @param {{enabled?: boolean, chains?: unknown}} [config] - `cordis.patch.yml` 的 `config`。
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) {
    diag('已禁用（config.enabled === false），未注册任何监听器');
    return;
  }

  // 「配置文件给默认值，状态文件给用户覆盖」。
  //
  // 这里刻意**不**因为状态文件读坏就整体退出：读坏了最坏是回到配置文件的样子，
  // 而「插件静默不工作」比「用默认链工作」糟糕得多 —— 用户会以为是模型的问题。
  const defaults = normalizeChains(config?.chains ?? DEFAULT_CHAINS);
  const file = stateFilePath();
  const saved = readChainFile(file);
  let active = defaults;
  let source = 'config';
  let savedAt;
  if (saved.kind === 'ok') {
    const fromFile = normalizeChains(saved.chains, { minCandidates: 1 });
    if (fromFile.length > 0) {
      active = fromFile;
      source = 'file';
      savedAt = saved.updatedAt;
      diag(`链来自状态文件 ${file}`);
    } else {
      diag(`状态文件 ${file} 里的链都不成立，回退到配置文件`);
    }
  } else if (saved.kind === 'invalid') {
    diag(`状态文件 ${file} 读不懂（${saved.reason}），回退到配置文件`);
  }

  if (active.length === 0) {
    diag('没有可用的链（配置非法或候选不足），未注册任何监听器');
    return;
  }
  diag(`已装载 ${active.length} 条链：${active.map(describeChain).join(' | ')}`);

  // 可变持有者：面板保存后原地换掉 `chains`，`wrapChainStream` 每次请求现读，
  // 于是下一个请求就走新链 —— 不需要重启，也不需要重注册 adapter。
  const chainState = {
    chains: active,
    defaults,
    source,
    file,
    savedAt,
    revision: 0,
  };

  const recorder = createRecorder();

  // waterfall 语义：`(options, next) => iterable`。
  // 第一个参数是这次调用的 options，`next()` 返回内置行为（adapter 流）。
  ctx.on('llm/stream', (options, next) => wrapChainStream(ctx, chainState, recorder, options, next));

  // 面板只是观测面：Web 服务器没起来（headless / desktop 的 file:// 载入）就
  // 静默跳过，路由照常工作。用 ctx.inject 而不是硬依赖，理由见 `inject` 的注释。
  //
  // `typeof` 检查不是防御性编程的洁癖：`ctx.inject` 是 cordis 的方法，但插件在
  // 被别的东西（单测、probe、未来的嵌入式宿主）以最小 ctx 驱动时可能没有它，
  // 而「面板挂不上」绝不该连带把路由也弄挂 —— 那会让插件的核心功能为可选功能
  // 陪葬。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      mountPanelApi(scoped, chainState, recorder);
    });
  } else {
    diag('ctx.inject 不可用（非完整宿主上下文），跳过面板 API');
  }
}

/**
 * 挂载面板 API。
 *
 * 路由：
 *   · `GET  /api/channel-fallback/state`   —— 快照（链 + 计数 + 事件 + 可选模型）。
 *   · `POST /api/channel-fallback/chains`  —— 保存链。body `{chains:[…]}` 或 `{reset:true}`。
 *   · `GET  /api/channel-fallback/models`  —— 模型目录（懒加载，`?provider=` 过滤）。
 *   · `POST /api/channel-fallback/test`    —— 连通测试。body `{provider, model}` 或 `{chainIndex, candidateIndex}`。
 *
 * 用 `prefix` 而不是 `exact`，这样三个路由共用一次注册；同时 prefix 的匹配优先级
 * 低于 exact，不会抢别的插件的精确路由。
 *
 * @param {object} scoped - 已注入 `webServer` 的作用域上下文。
 * @param {object} chainState - 可变持有者，见 `apply`。
 * @param {ReturnType<typeof createRecorder>} recorder
 */
function mountPanelApi(scoped, chainState, recorder) {
  try {
    // `connection` 可能比本插件晚发布，所以传 thunk：每次请求重新求值。
    // `ctx.get()` 是「机会式查询」，服务不存在时答 `undefined` 而不是抛错。
    const connection = () => {
      try {
        return typeof scoped.get === 'function' ? scoped.get('connection') : undefined;
      } catch {
        return undefined;
      }
    };
    const handler = createPanelHandler(scoped, connection, chainState, recorder);
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'channel-fallback: panel api',
    );
    diag(`面板 API 已挂载：${API_PREFIX}`);
  } catch (error) {
    // 面板挂不上不能连累路由。
    diag(`面板 API 挂载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 面板 API 的请求处理器。
 *
 * **每一个请求都先过信任栅栏**（`rejectionFor`），理由见 `lib/trust.js` 开头：
 * 我们注册的前缀比内核自己的 `/api` 更长，webServer 是「最长前缀优先」，
 * 所以这些路由会在内核的准入检查**之前**跑。不自己拦一道，等于把快照暴露给
 * 任何能连上环回端口的进程 —— 现在还能改路由配置，更不能漏。
 *
 * @param {object} scoped - 用于 `scoped.get('llm')` 列模型。
 * @param {() => (object|undefined)} connection - 每次请求求值一次的服务 thunk。
 * @param {object} chainState 见 `apply`。
 * @param {ReturnType<typeof createRecorder>} recorder
 */
function createPanelHandler(scoped, connection, chainState, recorder) {
  return (req, res) => {
    const rejection = rejectionFor(connection(), req);
    if (rejection !== undefined) {
      diag(`面板 API 拒绝一个请求：HTTP ${rejection}`);
      sendText(res, rejection, 'rejected');
      return;
    }

    const method = String(req?.method ?? 'GET').toUpperCase();
    const pathname = pathnameOf(req);

    if (pathname.endsWith('/chains')) {
      if (method !== 'POST') {
        sendText(res, 405, 'method not allowed', { allow: 'POST' });
        return;
      }
      void handleSaveChains(scoped, chainState, recorder, req, res);
      return;
    }

    if (pathname.endsWith('/models')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return;
      }
      void handleListModels(scoped, req, res, method === 'HEAD');
      return;
    }

    if (pathname.endsWith('/test')) {
      if (method !== 'POST') {
        sendText(res, 405, 'method not allowed', { allow: 'POST' });
        return;
      }
      void handleTestCandidate(scoped, chainState, req, res);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      return;
    }

    let body;
    try {
      body = JSON.stringify(snapshotPayload(scoped, chainState, recorder));
    } catch (error) {
      sendText(res, 500, `snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  };
}

/**
 * 列出「可以加到链里的模型」。
 *
 * 为什么要单独一个懒加载路由，而不是塞进 `state` 快照里：
 * `ctx.llm.listModels(provider)` 没有聚合入口（subagent 查证 Q2：只有
 * `listProviders()` 和**逐 provider** 的 `listModels`），而本机有 14 个账号渠道，
 * 每个都要打一次上游 —— 面板每刷新一次就全列一遍，等于每刷一次页面就发十几条
 * 请求出去。所以默认不列，只有用户真去点「添加模型」时才问。
 *
 * 单个 provider 失败**不影响整体**：渠道离线很常见，此时其它 provider 的模型
 * 照样该能加进链里。失败的 provider 会在 `failed` 里如实报出来。
 *
 * @param {object} scoped
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} headOnly
 */
async function handleListModels(scoped, req, res, headOnly) {
  const llm = (() => {
    try {
      return typeof scoped.get === 'function' ? scoped.get('llm') : undefined;
    } catch {
      return undefined;
    }
  })();
  const runtime = llm?.llm ?? llm?.runtime ?? llm;
  if (typeof runtime?.listProviders !== 'function' || typeof runtime?.listModels !== 'function') {
    sendJson(res, 503, { error: 'llm 服务不可用，暂时列不出模型' });
    return;
  }

  const only = queryParam(req, 'provider');
  const entries = [];
  const failed = [];
  let providers;
  try {
    providers = runtime.listProviders().map((provider) => String(provider?.id ?? '')).filter((id) => id !== '');
  } catch (error) {
    sendJson(res, 500, { error: `列 provider 失败：${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  const targets = only === undefined ? providers : providers.filter((id) => id === only);

  for (const provider of targets) {
    try {
      const models = await runtime.listModels(provider);
      for (const model of Array.isArray(models) ? models : []) {
        const id = typeof model?.id === 'string' ? model.id : '';
        if (id === '') continue;
        entries.push({
          provider,
          model: id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        });
      }
    } catch (error) {
      failed.push({ provider, error: error instanceof Error ? error.message : String(error) });
    }
  }

  entries.sort((a, b) => (a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider)));
  const payload = JSON.stringify({ models: entries, failed, providers: targets });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(payload);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} key
 * @returns {string|undefined}
 */
function queryParam(req, key) {
  const raw = typeof req?.url === 'string' ? req.url : '';
  try {
    const value = new URL(raw, 'http://x').searchParams.get(key);
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * 保存链：读 body → 校验 → 写盘 → 换掉内存里的 `chains` → 回新快照。
 *
 * 顺序很重要：**先写盘成功，再改内存**。反过来会「面板显示已保存、重启后没了」。
 *
 * @param {object} scoped
 * @param {object} chainState
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleSaveChains(scoped, chainState, recorder, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 400;
    sendText(res, status, error instanceof Error ? error.message : String(error));
    return;
  }

  const parsed = parseChainsPayload(body, normalizeChains);
  if (parsed.ok === false) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  try {
    if (parsed.reset === true) {
      removeChainFile(chainState.file);
      chainState.chains = chainState.defaults;
      chainState.source = 'config';
      chainState.savedAt = undefined;
    } else {
      const savedAt = writeChainFile(chainState.file, parsed.chains);
      chainState.chains = parsed.chains;
      chainState.source = 'file';
      chainState.savedAt = savedAt;
    }
  } catch (error) {
    // 写盘失败必须如实报错：假装保存成功会让用户下次重启后莫名其妙回到旧链。
    diag(`保存链失败：${error instanceof Error ? error.message : String(error)}`);
    sendJson(res, 500, { error: `写入失败：${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  chainState.revision += 1;
  diag(`链已更新（revision ${chainState.revision}）：${chainState.chains.map(describeChain).join(' | ')}`);
  sendJson(res, 200, snapshotPayload(scoped, chainState, recorder));
}

/**
 * 连通测试：真的向 `provider/model` 发一次极小请求，看它能不能开始回答。
 *
 * 设计取舍（原型是 `dsh-our-free-model` 的 testModel）：
 *   · **走真的 adapter 流**（`llm.stream` 直调 + `innerCall` 标记绕过自己的
 *     包装）而不是只查目录 —— 「目录里有」不等于「现在能用」，用户要的是后者。
 *   · 测试提示词只要求一个词（`OK`），把花费压到最小。
 *   · 「提交」判据与路由一致（`shouldCommit`：见到正文才算数）—— 只吐思考
 *     不吐正文的渠道，对用户同样是不可用。
 *   · 30 秒超时（`TEST_TIMEOUT_MS`），超时掐断并按失败上报。
 *   · 同一个 `provider/model` 同时只允许一个测试在跑（`testInflight`）——
 *     结果还没回来时再点只会白白排队。
 *
 * 失败时尽量还原用户能看懂的东西：`code` + HTTP 状态 + 上游消息。
 *
 * @param {object} scoped
 * @param {object} chainState
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleTestCandidate(scoped, chainState, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 400;
    sendText(res, status, error instanceof Error ? error.message : String(error));
    return;
  }

  const picked = pickCandidate(body, chainState.chains);
  if (typeof picked === 'string') {
    sendJson(res, 400, { error: picked });
    return;
  }
  const { provider, model } = picked;
  const key = `${provider}/${model}`;

  const llm = (() => {
    try {
      return typeof scoped.get === 'function' ? scoped.get('llm') : undefined;
    } catch {
      return undefined;
    }
  })();
  const runtime = llm?.llm ?? llm?.runtime ?? llm;
  if (typeof runtime?.stream !== 'function') {
    sendJson(res, 503, { error: 'llm 服务不可用，暂时测不了模型' });
    return;
  }

  if (testInflight.has(key)) {
    sendJson(res, 409, { error: `${key} 已有一个测试在进行，等它结束再试` });
    return;
  }
  testInflight.add(key);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('测试超时')), TEST_TIMEOUT_MS);
  try {
    const stream = innerCall.run(true, () => runtime.stream({
      provider,
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      sessionId: `channel-fallback:test:${Date.now().toString(36)}`,
      signal: controller.signal,
    }));

    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        const chunk = step.value;
        // 见到正文就算成功，剩下的流不必读完 —— 测试只关心「能不能答」。
        if (shouldCommit(chunk)) {
          await closeQuietly(iterator);
          sendJson(res, 200, {
            ok: true,
            provider,
            model,
            totalMs: Date.now() - startedAt,
          });
          return;
        }
        if (isFailureFinish(chunk)) {
          await closeQuietly(iterator);
          sendJson(res, 200, { ok: false, provider, model, ...testFailureOf(chunk) });
          return;
        }
      }
      // 流正常结束却没见到正文：与路由同口径，视为失败。
      sendJson(res, 200, {
        ok: false,
        provider,
        model,
        error: '流结束但没有正文输出',
        code: 'NO_OUTPUT',
        totalMs: Date.now() - startedAt,
      });
    } finally {
      await closeQuietly(iterator);
    }
  } catch (error) {
    // `runtime.stream` 本身抛错（没这个 provider 之类）：如实上报。
    diag(`测试 ${key} 抛错：${error instanceof Error ? error.message : String(error)}`);
    sendJson(res, 200, {
      ok: false,
      provider,
      model,
      error: error instanceof Error ? error.message : String(error),
      code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      totalMs: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(timer);
    testInflight.delete(key);
  }
}

/**
 * 从失败 finish chunk 里提取给面板展示的字段。
 *
 * @param {unknown} chunk
 * @returns {{error?: string, code?: string, status?: number}}
 */
function testFailureOf(chunk) {
  const reason = /** @type {Record<string, any>} */ (chunk)?.reason;
  const failure = reason?.failure;
  const out = {};
  if (failure !== null && typeof failure === 'object') {
    if (typeof failure.message === 'string' && failure.message !== '') out.error = failure.message;
    if (typeof failure.code === 'string' && failure.code !== '') out.code = failure.code;
    if (Number.isInteger(failure.status)) out.status = failure.status;
  }
  if (out.error === undefined) out.error = '上游返回失败';
  if (out.code === undefined) out.code = 'UNKNOWN';
  return out;
}

/**
 * 面板快照。
 *
 * `available` 是「可添加的模型」—— 懒加载：只有面板真的展开「添加模型」时
 * 才会去问，因为 `listModels` 要逐 provider 打上游，全部列一遍并不便宜。
 *
 * @param {object} scoped
 * @param {object} chainState
 * @param {ReturnType<typeof createRecorder>} recorder
 */
function snapshotPayload(scoped, chainState, recorder) {
  return {
    ...recorder.snapshot({
      chains: publicChains(chainState.chains),
      enabled: true,
      logEnabled: loggingEnabled(),
    }),
    editable: true,
    source: chainState.source,
    ...(chainState.savedAt === undefined ? {} : { savedAt: chainState.savedAt }),
    revision: chainState.revision,
    file: chainState.file,
    defaults: publicChains(chainState.defaults),
    providers: knownProviders(scoped),
  };
}

/**
 * 已注册的 provider 清单（同步、便宜，直接从 adapter 表读）。
 *
 * 只用来给面板铺「选哪个渠道」那排按钮，所以不需要模型清单 —— 那才是贵的
 * （见 `handleListModels` 的注释）。
 *
 * @param {object} scoped
 * @returns {Array<{provider: string, name: string}>}
 */
function knownProviders(scoped) {
  try {
    const llm = typeof scoped.get === 'function' ? scoped.get('llm') : undefined;
    const runtime = llm?.llm ?? llm?.runtime ?? llm;
    if (typeof runtime?.listProviders !== 'function') return [];
    return runtime.listProviders().map((provider) => ({
      provider: String(provider?.id ?? ''),
      name: String(provider?.name ?? '') || String(provider?.id ?? ''),
    })).filter((entry) => entry.provider !== '');
  } catch {
    return [];
  }
}

/**
 * 读 JSON 请求体。
 *
 * 这三个错误分支都不是洁癖，是踩过的坑（照 `dsh-our-free-model/index.js:2020`）：
 *   · 有体积上限 —— 不设上限，过了栅栏的调用方就能让宿主无限缓冲；
 *   · 空 body 回 `{}` —— 无 body 的 POST 是真实存在的调用方式；
 *   · 发了 body 但不是 JSON 回 400 —— 回 `{}` 会让 POST 变成静默 200 空操作。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(400, `请求体不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/**
 * @param {number} statusCode
 * @param {string} message
 */
function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** 请求路径（不含 query）。拿不到就当空串，交给后续分支回 404。 */
function pathnameOf(req) {
  const raw = typeof req?.url === 'string' ? req.url : '';
  if (raw === '') return '';
  try {
    return new URL(raw, 'http://x').pathname;
  } catch {
    return '';
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendText(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * 给面板的链定义：只暴露它需要显示的字段。
 *
 * @param {ReadonlyArray<{name: string, candidates: Array<object>}>} chains
 */
function publicChains(chains) {
  return chains.map((chain) => ({
    name: chain.name,
    candidates: chain.candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
      ...(candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens }),
    })),
  }));
}

/**
 * @param {{name: string, candidates: Array<object>}} chain
 * @returns {string}
 */
function describeChain(chain) {
  const steps = chain.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`);
  return `${chain.name}: ${steps.join(' → ')}`;
}

/**
 * 真正的包装逻辑。
 *
 * `chainState.chains` 是**每次请求现读**的 —— 面板保存后会原地替换它，下一个
 * 请求就走新链。若在 `apply()` 里把 `chains` 值捕获进闭包，改配置就必须重启，
 * 那就白做这个面板了。
 *
 * @param {object} ctx
 * @param {{chains: ReadonlyArray<{name: string, candidates: Array<object>}>}} chainState
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {object} options
 * @param {() => AsyncIterable<any>} next
 * @returns {AsyncIterable<any>}
 */
function wrapChainStream(ctx, chainState, recorder, options, next) {
  // 我们为了尝试别的候选而亲自发出的调用：直接透传给真正的 adapter。
  if (innerCall.getStore() === true) return next();

  const chains = Array.isArray(chainState?.chains) ? chainState.chains : [];
  const chain = matchChain(chains, options);
  // 不归我们管：原样透传，一个字节都不碰。只计数，不记明细（这些请求里绝大多数
  // 是会话标题生成之类的小请求，记明细会把真正有价值的事件挤掉）。
  if (chain === undefined) {
    recorder.passthrough();
    return next();
  }

  return runChain(ctx, chain, recorder, options, next);
}

/**
 * 顺序尝试链上的候选，第一个「真的开始回答」的胜出。
 *
 * @param {object} ctx
 * @param {{name: string, candidates: Array<object>}} chain
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {object} options
 * @param {() => AsyncIterable<any>} next
 * @returns {AsyncIterable<any>}
 */
async function* runChain(ctx, chain, recorder, options, next) {
  const started = recorder.begin(chain.name, `${options.provider}/${options.model}`);
  const tried = [];
  let attempts = 0;
  for (let index = 0; index < chain.candidates.length; index += 1) {
    const candidate = chain.candidates[index];
    const label = `${candidate.provider}/${candidate.model}`;
    const isLast = index === chain.candidates.length - 1;
    attempts += 1;

    if (options.signal?.aborted === true) {
      recorder.aborted(chain.name);
      yield failureFinish(new Error('aborted before fallback'), options.signal);
      return;
    }

    // 链头那一站：调用方本来就想走它，用宿主的 `next()` 直连（保留任何其他
    // 监听器对这次调用的处理）；备选站才由我们自己发起。
    const stream = index === 0 && candidate.provider === options.provider && candidate.model === options.model
      ? next()
      : await startCandidate(ctx, options, candidate);

    const held = [];
    let committed = false;
    let failure;
    let iterator;

    try {
      iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        let step;
        try {
          step = await iterator.next();
        } catch (error) {
          failure = failureFinish(error, options.signal);
          break;
        }
        if (step.done === true) break;

        const chunk = step.value;
        if (shouldCommit(chunk)) {
          committed = true;
          recorder.win(chain.name, label, started.at, attempts);
          for (const pending of held) yield pending;
          held.length = 0;
          yield chunk;
          // 已开始回答：把剩下的流原样交出去，不再考虑切换。
          yield* restOf(iterator);
          return;
        }
        if (isFailureFinish(chunk)) {
          failure = chunk;
          break;
        }
        held.push(chunk);
      }
    } finally {
      // `committed` 为真时上游迭代器的收尾已经交给 `restOf` 的 finally，
      // 这里再关一次会和那边的 `return()` 撞车（同一个 iterator 被关两遍）。
      if (!committed) await closeQuietly(iterator);
    }

    if (committed) return;

    if (failure === undefined) {
      // 流正常结束却一个字正文都没有 —— 对用户就是失败，值得换下一个。
      failure = failureFinish(new Error('stream ended without visible output'), options.signal);
    }

    tried.push(`${label} (${describeFinish(failure)})`);
    diag(`链 "${chain.name}" 跳过 ${label}：${describeFinish(failure)}`);

    const reason = failure?.reason;
    if (reason?.kind === 'aborted') {
      // 调用方取消：如实上报，别再拿别的候选去打扰上游。
      recorder.aborted(chain.name);
      yield failure;
      return;
    }

    recorder.skip(chain.name, label, reason?.failure);
    if (isLast) {
      recorder.exhausted(chain.name, tried);
      diag(`链 "${chain.name}" 全部候选耗尽：${tried.join('; ')}`);
      yield failure;
      return;
    }
  }
}

/**
 * 亲自发起一次候选调用。
 *
 * 用 `innerCall.run(true, ...)` 标记，使监听器见到它时直接透传 —— 这条流的
 * 失败由我们自己处理，不需要再被包一层。
 *
 * @param {object} ctx
 * @param {object} options
 * @param {object} candidate
 * @returns {AsyncIterable<any>}
 */
function startCandidate(ctx, options, candidate) {
  const routed = candidateOptions(options, candidate);
  return innerCall.run(true, () => ctx.llm.stream(routed));
}

/**
 * 把迭代器剩下的内容原样吐出去。
 *
 * 显式 `for(;;)` 而不是 `for await`：`for await` 在调用方 break 时会自动
 * 调 `return()`，看起来更省事，但那样一来「调用方正常打断」和「上游报错」
 * 就走同一条路了，这里要自己控制收尾。
 *
 * **`finally` 是必须的**：一旦开始回答，`runChain` 的 `finally` 就不再接管
 * 上游迭代器（`committed === true`），收尾责任全部落到这里。消费方若提前
 * `break` / 抛错，这个 generator 会被 `return()`，`finally` 里的
 * `closeQuietly` 才是唯一能关掉上游 HTTP 流的地方 —— 少了它，socket 会一直
 * 跑到流自然结束。
 *
 * @param {AsyncIterator<any>} iterator
 * @returns {AsyncGenerator<any>}
 */
async function* restOf(iterator) {
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    await closeQuietly(iterator);
  }
}

/**
 * 关掉上游迭代器；关不掉也不该掩盖真正的失败。
 *
 * @param {AsyncIterator<any>|undefined} iterator
 */
async function closeQuietly(iterator) {
  const close = iterator?.return;
  if (typeof close !== 'function') return;
  try {
    await close.call(iterator);
  } catch {
    // 忽略：我们要么已经有更重要的失败要上报，要么已经成功返回。
  }
}
