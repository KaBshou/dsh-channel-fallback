// dsh-channel-fallback —— 把「一组按顺序尝试的渠道」做成模型选择器里的一个条目。
//
// 用户要的形态（2026-10-27 定稿）：**链要自己在模型选择器里选用**，不是装上
// 插件就自动接管。所以本插件注册一个虚拟 provider（`dsh-channel-chain`，
// 显示名「渠道链」），每条链是它下面的一个 model。用户在选择器里选中
// 「渠道链 / flash-free-first」，这次请求才会按链顺序尝试。
//
// 为什么是这个形态而不是 `llm/stream` 监听器（v0.4.0 的做法）：
//   监听器拦的是「所有经过 llm 的请求」，装上即生效、无法在界面上表达「这次
//   不用链」。而注册成 provider 是宿主的一等公民：选择器、默认模型、会话级
//   切换、子 agent 指定模型全都自动支持，用户想用就用、不想用就不选。
//
// 为什么是自己写而不是用现成的（能力盘点结论，2026-10-26，逐条查过源码）：
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
// 关键约束（踩过的坑，别改坏）：
//   · **失败只能看 finish chunk**：宿主的 `adapterStream` 把 adapter 抛的错转成
//     `{type:'finish', reason:{kind:'error'|'aborted', failure}}` 产出，不 throw。
//   · **`reasoning-delta` 不算已提交**：思考阶段撞额度墙正是最该切换的场景，
//     而思考内容可以整段丢弃，用户完全无感。
//   · **消费方提前退出（break / abort）必须显式关掉上游迭代器**，否则 HTTP 流会
//     跑完、socket 泄漏（照 `dsh-cost-meter/lib/billing-stream.js` 的写法）。
//   · **`resolveModel` 的 efforts 必须是链上各站的并集**，否则用户在选择器里
//     选一个档位就会触发宿主 `UNSUPPORTED_REASONING_EFFORT`，整条链报废。
//   · **候选不能引用虚拟 provider 自己**，否则成环。面板与归一化两处都挡。
//
// 诊断：`DSH_CHANNEL_FALLBACK_LOG=1` 时把每次切换写进
// `<系统临时目录>/dsh-channel-fallback.log`。
//
// 可视化面板：
//   · 宿主侧在 `/api/channel-fallback/*` 吐快照 / 模型目录 / 档位 / 连通测试，
//     由 `webServer.register` 以 prefix 方式挂载。
//   · 浏览器侧是 `client.js`（设置 → 渠道回退 一页）。
//   · 记录全部走 `lib/state.js` 的有界内存，**不参与路由决策** —— 记录层出问题
//     最坏是面板空白，绝不会让模型请求失败。
//
// 可编辑的链：
//   · `POST /api/channel-fallback/chains` 保存链配置，`{reset:true}` 恢复默认。
//   · 存进 `~/.dsh/channel-fallback/chains.json`（`lib/store.js`），**不回写
//     `cordis.patch.yml`** —— 那是用户手写带注释的文件，还夹着别的插件的条目。
//     规则是「配置文件给默认值，状态文件给用户覆盖」，删掉状态文件即回到默认。
//   · 热生效靠 `chainState.chains` 这个可变持有者：`apply()` 里建立一次，
//     adapter 的 `listModels`/`resolveModel` 每次现读。写盘成功后调一次
//     `handle.replace()` 让宿主广播 `llm/adapters-updated`，选择器随即刷新。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CHAINS,
  candidateOptions,
  describeFinish,
  failureFinish,
  findChainById,
  isFailureFinish,
  normalizeChains,
  pickCandidate,
  shouldCommit,
  supportedEfforts,
} from './chain.js';
import { createCatalog } from './catalog.js';
import { closeQuietly, restOf } from './flow.js';
import { CHAIN_PROVIDER_ID, CHAIN_PROVIDER_NAME, createChainAdapter } from './provider.js';
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
 * 硬依赖，整个插件在 headless 下就不会 apply —— 链也就没了。面板是可选功能，
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
    diag('已禁用（config.enabled === false），未注册虚拟 provider');
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

  // 可变持有者：面板保存后原地换掉 `chains`，adapter 每次调用现读，
  // 于是下一个请求就走新链 —— 不需要重启，也不需要重注册 adapter。
  const chainState = {
    chains: active,
    defaults,
    source,
    file,
    savedAt,
    revision: 0,
  };

  /** @type {any} */
  let registration;

  const recorder = createRecorder();

  // 查真实渠道的模型目录 / 档位 / 上下文窗口。全部走缓存，只读不写上游。
  const catalog = createCatalog({ getRuntime: () => runtimeOf(ctx) });

  // 面板先挂 —— 它是观测面，也是用户修链的唯一入口，**不能跟着 adapter 一起
  // 陪葬**。llm 服务不可用时照样要能打开面板看清楚哪里不对（`/test` 会回 503，
  // `/models` 也会回 503，但快照、链编辑、信任栅栏都还能用）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      mountPanelApi(scoped, chainState, recorder, catalog, () => registration);
    });
  } else {
    diag('ctx.inject 不可用（非完整宿主上下文），跳过面板 API');
  }

  const llm = runtimeOf(ctx);
  if (typeof llm?.registerAdapter !== 'function' || typeof llm?.stream !== 'function') {
    diag('llm 服务不支持 registerAdapter/stream，虚拟 provider 无法注册（面板仍可用）');
    return;
  }

  // 一条链都没有时仍然要注册 adapter：面板（设置 → 渠道回退）是独立入口，
  // 用户删光了链也得能进去加回来。此时 `listModels` 返回空数组，宿主会把
  // 「渠道链」这一组从模型选择器里过滤掉（`buildModelCatalog` 的
  // `.filter(group => group.models.length > 0)`）—— 这正是期望行为：
  // 没有链可选时，选择器里不该出现一个点了就报错的空组。
  if (chainState.chains.length === 0) {
    diag('当前没有任何链：选择器里暂时看不到「渠道链」这一组，面板仍可访问');
  }

  const adapter = createChainAdapter({
    getChains: () => chainState.chains,
    runChain: (provider, model, options) =>
      runChain(ctx, chainState, catalog, recorder, provider, model, options),
    effortsFor: (provider, model) => catalog.effortsFor(provider, model),
    contextWindowFor: (provider, model) => catalog.contextWindowFor(provider, model),
    describeChain,
  });

  try {
    registration = llm.registerAdapter([CHAIN_PROVIDER_ID], adapter);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code === 'DUPLICATE_ADAPTER' || /\balready registered\b|\bduplicate (adapter|provider)\b/i.test(String(error?.message ?? ''))) {
      // 同一个宿主里被 apply 了两次（热重载 / 多 profile 共享）。保留既有路由，
      // 面板照样挂 —— 重新注册只会把用户正在用的选择项打散。
      diag(`虚拟 provider "${CHAIN_PROVIDER_ID}" 已存在，沿用既有注册`);
    } else {
      diag(`注册虚拟 provider 失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  if (registration !== undefined) {
    diag(`虚拟 provider "${CHAIN_PROVIDER_ID}"（${CHAIN_PROVIDER_NAME}）已注册，${chainState.chains.length} 条链`);
  }
}

/**
 * 从 ctx 里取 llm 运行时。
 *
 * 宿主的 `llm` 服务本身就是 `LlmRuntime`，但别的插件可能把服务包了一层
 * （`llm.llm` / `llm.runtime`），三种形态都试一下最稳。
 *
 * @param {object} ctx
 */
function runtimeOf(ctx) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    return llm?.llm ?? llm?.runtime ?? llm;
  } catch {
    return undefined;
  }
}

/**
 * 挂载面板 API。
 *
 * 路由（都以 `API_PREFIX` 开头）：
 *   · `GET  /state`    —— 快照（链 + 计数 + 事件）。
 *   · `POST /chains`   —— 保存链。body `{chains:[…]}` 或 `{reset:true}`。
 *   · `GET  /models`   —— 模型目录（懒加载，`?provider=` 过滤）。
 *   · `GET  /efforts`  —— 某站支持的档位（`?provider=&model=`）。
 *   · `POST /test`     —— 连通测试。body `{provider, model}` 或 `{chainIndex, candidateIndex}`。
 *
 * 用 `prefix` 而不是 `exact`，这样几条路由共用一次注册；同时 prefix 的匹配优先级
 * 低于 exact，不会抢别的插件的精确路由。
 *
 * @param {object} scoped - 已注入 `webServer` 的作用域上下文。
 * @param {object} chainState - 可变持有者，见 `apply`。
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {() => ({replace?: (providers: string[]) => void}|undefined)} registration
 *   - **传 thunk**：面板比 adapter 先挂（llm 不可用时面板也得能用），所以挂载
 *   那一刻 registration 还可能不存在，每次保存时现取。
 */
function mountPanelApi(scoped, chainState, recorder, catalog, registration) {
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
    const handler = createPanelHandler(scoped, connection, chainState, recorder, catalog, registration);
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'channel-fallback: panel api',
    );
    diag(`面板 API 已挂载：${API_PREFIX}`);
  } catch (error) {
    // 面板挂不上不能连累链。
    diag(`面板 API 挂载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 面板 API 的请求处理器。
 *
 * **每一个请求都先过信任栅栏**（`rejectionFor`），理由见 `lib/trust.js` 开头：
 * 我们注册的前缀比内核自己的 `/api` 更长，webServer 是「最长前缀优先」，
 * 所以这些路由会在内核的准入检查**之前**跑。不自己拦一道，等于把快照暴露给
 * 任何能连上环回端口的进程 —— 现在还能改链配置，更不能漏。
 *
 * @param {object} scoped - 用于 `scoped.get('llm')` 列模型。
 * @param {() => (object|undefined)} connection - 每次请求求值一次的服务 thunk。
 * @param {object} chainState 见 `apply`。
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {() => ({replace?: (providers: string[]) => void}|undefined)} registration
 *   - thunk，见 `mountPanelApi`。
 */
function createPanelHandler(scoped, connection, chainState, recorder, catalog, registration) {
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
      void handleSaveChains(scoped, chainState, recorder, catalog, registration, req, res);
      return;
    }

    if (pathname.endsWith('/models')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return;
      }
      void handleListModels(scoped, catalog, req, res, method === 'HEAD');
      return;
    }

    if (pathname.endsWith('/efforts')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return;
      }
      void handleListEfforts(catalog, req, res, method === 'HEAD');
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

    void sendSnapshot(scoped, chainState, recorder, catalog, res, method === 'HEAD');
    return;
  };
}

/**
 * 返回面板快照。
 *
 * 先预热倍率缓存再取快照 —— `ratesFor` 只读缓存（不为「几折」单独打上游），
 * 不预热的话**首次打开面板倍率一栏全空**，用户会以为插件没实现这个功能。
 * 预热失败不影响返回（`catalog.warm` 内部吞掉所有错误）。
 *
 * @param {object} scoped
 * @param {object} chainState
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} headOnly
 */
async function sendSnapshot(scoped, chainState, recorder, catalog, res, headOnly) {
  try {
    await catalog.warm(chainState.chains.flatMap((chain) => chain.candidates));
  } catch {
    // 倍率是可选信息，预热失败不该挡住面板。
  }
  let body;
  try {
    body = JSON.stringify(snapshotPayload(scoped, chainState, recorder, catalog));
  } catch (error) {
    sendText(res, 500, `snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (headOnly === true) {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * 列出「可以加到链里的模型」。
 *
 * 为什么要单独一个懒加载路由，而不是塞进 `state` 快照里：
 * `llm.listModels(provider)` 没有聚合入口，而本机有 14 个账号渠道，每个都要打
 * 一次上游 —— 面板每刷新一次就全列一遍，等于每刷一次页面就发十几条请求出去。
 * 所以默认不列，只有用户真去点「添加模型」时才问。
 *
 * 单个 provider 失败**不影响整体**：渠道离线很常见，此时其它 provider 的模型
 * 照样该能加进链里。失败的 provider 会在 `failed` 里如实报出来。
 *
 * **虚拟 provider 自己要从清单里剔掉**：把「渠道链」加进「渠道链」就是成环，
 * 宿主会在第一次调用时栈溢出。
 *
 * @param {object} scoped
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} headOnly
 */
async function handleListModels(scoped, catalog, req, res, headOnly) {
  const llm = runtimeOf(scoped);
  if (typeof llm?.listProviders !== 'function') {
    sendJson(res, 503, { error: 'llm 服务不可用，暂时列不出模型' });
    return;
  }

  const only = queryParam(req, 'provider');
  const failed = [];
  let providers;
  try {
    providers = llm.listProviders()
      .map((provider) => String(provider?.id ?? ''))
      .filter((id) => id !== '' && id !== CHAIN_PROVIDER_ID);
  } catch (error) {
    sendJson(res, 500, { error: `列 provider 失败：${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  const targets = only === undefined ? providers : providers.filter((id) => id === only);

  const models = [];
  for (const provider of targets) {
    try {
      const list = await catalog.listModels(provider);
      for (const model of list) models.push(model);
    } catch (error) {
      failed.push({ provider, error: error instanceof Error ? error.message : String(error) });
    }
  }
  models.sort((a, b) => (a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider)));

  const payload = JSON.stringify({ models, failed, providers: targets });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(payload);
}

/**
 * 某一站支持哪些推理档位 —— 面板的档位下拉用它填充。
 *
 * `error` 有值表示**查不到**（渠道离线 / 目录里没这个模型），与「这一站确实
 * 没有档位概念」（`efforts: []` 且无 error）是两件事，面板要分开显示。
 *
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} [headOnly]
 */
async function handleListEfforts(catalog, req, res, headOnly = false) {
  const provider = queryParam(req, 'provider');
  const model = queryParam(req, 'model');
  if (provider === undefined || model === undefined) {
    sendJson(res, 400, { error: '需要 provider 与 model 两个查询参数' });
    return;
  }
  if (provider === CHAIN_PROVIDER_ID) {
    sendJson(res, 400, { error: '渠道链自己不是候选，不能嵌套' });
    return;
  }
  /** @type {Record<string, any>} */
  let payload;
  try {
    const info = await catalog.effortsFor(provider, model);
    payload = {
      provider,
      model,
      efforts: Array.isArray(info?.efforts) ? info.efforts : [],
      ...(info?.defaultEffort === undefined || info?.defaultEffort === null ? {} : { defaultEffort: info.defaultEffort }),
      ...(typeof info?.error === 'string' && info.error !== '' ? { error: info.error } : {}),
    };
  } catch (error) {
    payload = {
      provider,
      model,
      efforts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const body = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
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
 * 写盘成功后调 `registration.replace()`：宿主会广播 `llm/adapters-updated`，
 * 模型选择器随即重拉目录 —— 否则用户新建的链要等下次重连才出现。
 *
 * @param {object} scoped
 * @param {object} chainState
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {{replace?: (providers: string[]) => void}|undefined} registration
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleSaveChains(scoped, chainState, recorder, catalog, registration, req, res) {
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

  const next = parsed.reset === true ? chainState.defaults : parsed.chains;
  // 归一化后仍可能夹着「候选引用了渠道链自己」的环，这里再挡一道。
  if (next.some((chain) => chain.candidates.some((candidate) => candidate.provider === CHAIN_PROVIDER_ID))) {
    sendJson(res, 400, { error: `候选不能是「${CHAIN_PROVIDER_NAME}」自己，否则会成环` });
    return;
  }

  try {
    if (parsed.reset === true) {
      removeChainFile(chainState.file);
      chainState.chains = next;
      chainState.source = 'config';
      chainState.savedAt = undefined;
    } else {
      const savedAt = writeChainFile(chainState.file, next);
      chainState.chains = next;
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
  catalog.invalidate();
  diag(`链已更新（revision ${chainState.revision}）：${chainState.chains.map(describeChain).join(' | ')}`);

  // 让模型选择器重拉目录。失败不影响保存结果 —— 最坏是用户重连一次才看到。
  try {
    registration()?.replace?.([CHAIN_PROVIDER_ID]);
  } catch (error) {
    diag(`广播 adapters-updated 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  sendJson(res, 200, snapshotPayload(scoped, chainState, recorder, catalog));
}

/**
 * 连通测试：真的向 `provider/model` 发一次极小请求，看它能不能开始回答。
 *
 * 设计取舍（原型是 `dsh-our-free-model` 的 testModel）：
 *   · **走真的 adapter 流**而不是只查目录 —— 「目录里有」不等于「现在能用」，
 *     用户要的是后者。
 *   · 测试提示词只要求一个词（`OK`），把花费压到最小。
 *   · 「提交」判据与链一致（`shouldCommit`：见到正文才算数）—— 只吐思考
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

  const runtime = runtimeOf(scoped);
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
    const stream = runtime.stream({
      provider,
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      sessionId: `channel-fallback:test:${Date.now().toString(36)}`,
      signal: controller.signal,
    });

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
      // 流正常结束却没见到正文：与链同口径，视为失败。
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
 * 候选上带的 `rate`/`rateLabel` 是**只读缓存**（`catalog.ratesFor` 不打上游）：
 * 用户要先看到「这一站多少钱」才好排顺序，而为了显示价格去逐个 provider 打
 * 上游是不能接受的。缓存没预热时这两个字段缺失，面板显示「—」。
 *
 * @param {object} scoped
 * @param {object} chainState
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {ReturnType<typeof createCatalog>} catalog
 */
function snapshotPayload(scoped, chainState, recorder, catalog) {
  return {
    ...recorder.snapshot({
      chains: publicChains(chainState.chains, catalog),
      enabled: true,
      logEnabled: loggingEnabled(),
    }),
    editable: true,
    providerId: CHAIN_PROVIDER_ID,
    providerName: CHAIN_PROVIDER_NAME,
    source: chainState.source,
    ...(chainState.savedAt === undefined ? {} : { savedAt: chainState.savedAt }),
    revision: chainState.revision,
    file: chainState.file,
    defaults: publicChains(chainState.defaults, catalog),
    providers: knownProviders(scoped),
  };
}

/**
 * 已注册的真实渠道清单（同步、便宜，直接从 adapter 表读）。
 *
 * 只用来给面板铺「选哪个渠道」那排按钮，所以不需要模型清单 —— 那才是贵的
 * （见 `handleListModels` 的注释）。**虚拟 provider 自己剔除**，否则面板会让
 * 用户把渠道链加进渠道链。
 *
 * @param {object} scoped
 * @returns {Array<{provider: string, name: string}>}
 */
function knownProviders(scoped) {
  try {
    const runtime = runtimeOf(scoped);
    if (typeof runtime?.listProviders !== 'function') return [];
    return runtime.listProviders().map((provider) => ({
      provider: String(provider?.id ?? ''),
      name: String(provider?.name ?? '') || String(provider?.id ?? ''),
    })).filter((entry) => entry.provider !== '' && entry.provider !== CHAIN_PROVIDER_ID);
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
 * **`id` 必须带出去**：它就是模型选择器里的 model id，面板改名/改档位都要靠它
 * 定位是哪条链（`name` 可以重名，`id` 不能）。
 *
 * @param {ReadonlyArray<object>} chains
 * @param {ReturnType<typeof createCatalog>} [catalog]
 */
function publicChains(chains, catalog) {
  const candidates = [];
  for (const chain of chains) {
    for (const candidate of chain.candidates) candidates.push(candidate);
  }
  const rates = catalog === undefined ? {} : catalog.ratesFor(candidates);
  return chains.map((chain) => ({
    id: chain.id,
    name: chain.name,
    ...(typeof chain.reasoningEffort === 'string' ? { reasoningEffort: chain.reasoningEffort } : {}),
    candidates: chain.candidates.map((candidate) => {
      const rate = rates[`${candidate.provider}/${candidate.model}`];
      // 只有真解析出倍率才带上这几个字段 —— 渠道显示名里没有倍率时留空比
      // 塞 `rate: null` 干净（面板据此决定显不显示那枚小标签）。
      const rateFields = rate === undefined || (rate.rate === null && rate.rateLabel === null)
        ? {}
        : {
          ...(rate.rate === null ? {} : { rate: rate.rate }),
          ...(rate.rateLabel === null ? {} : { rateLabel: rate.rateLabel }),
          displayName: rate.name,
        };
      return {
        provider: candidate.provider,
        model: candidate.model,
        ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
        ...(candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens }),
        ...rateFields,
      };
    }),
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
 * 顺序尝试链上的候选，第一个「真的开始回答」的胜出。
 *
 * 由虚拟 provider 的 `prepareCall().stream()` 调起。注意这里**没有** `next()`：
 * 我们不在 waterfall 里，宿主是直接把这条流当 adapter 输出来消费的。每一站都
 * 通过 `ctx.llm.stream()` 自己去要 —— 那是真实渠道的 adapter，不会再回到我们。
 *
 * @param {object} ctx
 * @param {object} chainState
 * @param {ReturnType<typeof createCatalog>} catalog
 * @param {ReturnType<typeof createRecorder>} recorder
 * @param {string} provider - 虚拟 provider id（`dsh-channel-chain`）。
 * @param {string} model - 链 id。
 * @param {object} options
 * @returns {AsyncGenerator<any>}
 */
async function* runChain(ctx, chainState, catalog, recorder, provider, model, options) {
  const chains = Array.isArray(chainState?.chains) ? chainState.chains : [];
  const chain = findChainById(chains, model);
  if (chain === undefined) {
    // 选择器里选中的链被面板删掉了（或另一个进程改了状态文件）。如实报错，
    // 让用户知道要重选模型，而不是静默回退到别的东西。
    yield failureFinish(new Error(`chain "${model}" is no longer configured`), options?.signal);
    return;
  }

  const started = recorder.begin(chain.name, `${provider}/${model}`);
  const tried = [];
  let attempts = 0;

  for (let index = 0; index < chain.candidates.length; index += 1) {
    const candidate = chain.candidates[index];
    const label = `${candidate.provider}/${candidate.model}`;
    const isLast = index === chain.candidates.length - 1;
    attempts += 1;

    if (options?.signal?.aborted === true) {
      recorder.aborted(chain.name);
      yield failureFinish(new Error('aborted before fallback'), options.signal);
      return;
    }

    // 这一站真支持哪些档位。查不到（null）就不降级 —— 让宿主抛准确的
    // `UNSUPPORTED_REASONING_EFFORT`，比我们猜一个档位更不容易掩盖问题。
    const supported = await supportedEfforts(candidate.provider, candidate.model, (p, m) => catalog.effortsFor(p, m));
    const routed = candidateOptions(options, candidate, chain, supported);

    const held = [];
    let committed = false;
    let handedOff = false;
    let failure;
    let iterator;

    try {
      iterator = ctx.llm.stream(routed)[Symbol.asyncIterator]();
      for (;;) {
        let step;
        try {
          step = await iterator.next();
        } catch (error) {
          failure = failureFinish(error, options?.signal);
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
          // `handedOff` 在**进入** restOf 之前置位 —— 消费方可能就在上面那个
          // `yield chunk` 处 break，那时 restOf 还没被创建，收尾责任仍在我们
          // 这个 finally 上（否则上游 HTTP 流会一路跑完、socket 泄漏）。
          handedOff = true;
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
      // 谁最后碰过这个迭代器，谁负责关：
      //   · 已交给 `restOf`（`handedOff`）→ 由它的 finally 关，这里不能再关
      //     （同一个 iterator 关两遍会和 `return()` 撞车）；
      //   · 其它所有情况（未提交就失败 / 消费方在提交那一刻 break）→ 这里关。
      if (!handedOff) await closeQuietly(iterator);
    }

    if (committed) return;

    if (failure === undefined) {
      // 流正常结束却一个字正文都没有 —— 对用户就是失败，值得换下一个。
      failure = failureFinish(new Error('stream ended without visible output'), options?.signal);
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
