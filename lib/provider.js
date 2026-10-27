// 虚拟 provider「渠道链」。
//
// 为什么是「虚拟 provider」而不是在 `llm/stream` 监听器里拦截：
//
//   · 监听器拦截 = 装上插件就自动接管请求（用户明确要求过：**链要自己在模型
//     选择器里选用，不是装上插件就固定使用这条链**）；
//   · 注册成 provider = 模型选择器里多出一组「渠道链」，每条链是一个可点选的
//     条目，**用户主动选它才走链**，不选就完全不影响原来的模型。
//
// 宿主侧的契约（`@deepseek-ai/dsh-llm` 的 `LlmRuntime`）：
//   · `registerAdapter(providers, adapter)` —— provider id 不能与既有 provider
//     冲突，否则抛 `DUPLICATE_ADAPTER`；`providerInfo().name` 必须非空。
//   · `listModels(provider)` 的返回会被宿主校验：`{provider, id, name, description?}`，
//     `provider` 必须等于请求的 provider，`id`/`name` 非空，`id` 不重复。
//   · `resolveModel(provider, model)` 的返回会被 `normalizeModelInfo` 校验：
//     `provider`/`id` 必须与请求一致、`name` 非空；`reasoning.efforts` 非空且
//     每项 `{id, name}`、`id` 不重复；`reasoning.defaultEffort` 必须在 efforts 里。
//   · 模型选择器（`buildModelCatalog`）会**过滤掉没有模型的 provider 组**，
//     所以 `listModels` 必须真的返回链，不能返回空数组。
//   · `resolveCallWithInfo` 会拿请求里的 `reasoningEffort` 去 `reasoning.efforts`
//     里查 —— 查不到就抛 `UNSUPPORTED_REASONING_EFFORT`。所以**链的档位集合
//     必须是链上各站的并集**，否则用户在选择器里挑一个档位就能把整条链弄死。
//
// 档位（reasoning effort）的优先级（用户 m04534 拍板）：
// **候选固定 > 链级 > 调用方**。规则实现在 `chain.js` 的 `pickEffort`，
// 这里只负责把「这一站支持哪些档位」查出来喂给它。
//
// 同样刻意不 import 任何 DSH 内部包：插件目录被 Junction 链进 profile 的
// node_modules，能否解析宿主包取决于宿主版本。

import {
  candidateOptions,
  describeFinish,
  failureFinish,
  findChainById,
  isFailureFinish,
  pickEffort,
  shouldCommit,
  supportedEfforts,
} from './chain.js';

/**
 * 虚拟 provider 的 id。
 *
 * 刻意不叫 `chain` —— 那是太常见的名字，将来宿主或别的插件想用就撞了。
 * 带 `dsh-` 前缀是为了在模型选择器里一眼看出是本插件的条目。
 */
export const CHAIN_PROVIDER_ID = 'dsh-channel-chain';

/** 虚拟 provider 在模型选择器里的显示名。 */
export const CHAIN_PROVIDER_NAME = '渠道链';

/**
 * 档位名 → 展示名。
 *
 * 宿主的选择器会显示档位的 `name`，所以这里给个像样的名字，而不是裸的
 * `high`。没收录的档位直接用原 id 兜底。
 */
const EFFORT_NAMES = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/**
 * 造一个虚拟 provider 的 adapter。
 *
 * @param {object} options
 * @param {() => ReadonlyArray<object>} options.getChains
 *   取当前生效的链。**每次调用都现读** —— 面板保存后原地换掉链，下一个请求
 *   就走新链，不需要重注册 adapter（链是纯数据）。
 * @param {(chain: object, options: object) => AsyncIterable<any>} options.runChain
 *   链的执行器（在 `index.js` 里实现，共享那里的记录层与失败处理）。
 * @param {(provider: string, model: string) => Promise<{efforts: Array<{id: string, name: string}>, defaultEffort: string|null}>} options.effortsFor
 *   查某模型的推理档位（懒加载 + 缓存，见 `lib/catalog.js`）。
 * @param {(provider: string, model: string) => Promise<number|null>} [options.contextWindowFor]
 *   查某模型的上下文窗口。链上任何一站装不下，整条链就装不下。
 * @param {(chain: object) => string} [options.describeChain]
 *   链的一句话描述，用在链的 `description` 上。
 */
export function createChainAdapter(options) {
  const getChains = options.getChains;
  const runChain = options.runChain;
  const effortsFor = options.effortsFor;
  const contextWindowFor = typeof options.contextWindowFor === 'function'
    ? options.contextWindowFor
    : async () => null;
  const describeChain = typeof options.describeChain === 'function'
    ? options.describeChain
    : (chain) => chain.candidates.map((c) => `${c.provider}/${c.model}`).join(' → ');

  /** @returns {ReadonlyArray<object>} */
  function chains() {
    const value = getChains();
    return Array.isArray(value) ? value : [];
  }

  /**
   * 一条链在模型选择器里的名字。
   *
   * 带上链自己的名字与各站 provider/model，让用户在选择器里一眼分清
   * 「这是哪条链、它先走谁再走谁」—— 只有 id 的话，选择器里就是一个光秃秃的
   * 字符串，用户根本不知道选的是哪条。
   */
  function chainLabel(chain) {
    const steps = chain.candidates.map((c) => `${c.provider}/${c.model}`).join(' → ');
    return `${chain.name}（${steps}）`;
  }

  return {
    /**
     * provider 元数据。
     *
     * 宿主要求 `id` 与注册的 provider id 完全一致、`name` 非空。
     *
     * @param {string} provider
     */
    providerInfo(provider) {
      return { id: provider, name: CHAIN_PROVIDER_NAME };
    },

    /**
     * 重试策略。
     *
     * 链自己就是重试机制（换一站继续），所以**不额外重试**：宿主默认是
     * 5 次重试 + 指数退避，真叠上去会让「切站」被无谓的等待拖慢。
     * 留 0 次。
     */
    providerRetryPolicy() {
      return { mode: 'normal', maxRetries: 0 };
    },

    /**
     * 列出所有链 —— 每条链就是「一个模型」。
     *
     * @param {string} provider
     * @returns {Promise<Array<{provider: string, id: string, name: string, description: string}>>}
     */
    async listModels(provider) {
      const out = [];
      for (const chain of chains()) {
        if (typeof chain?.id !== 'string' || chain.id === '') continue;
        out.push({
          provider,
          id: chain.id,
          name: chainLabel(chain),
          description: describeChain(chain),
        });
      }
      return out;
    },

    /**
     * 某条链的详情：档位与上下文窗口。
     *
     * 档位取**链上各站支持的档位并集** —— 链可能换 provider，不同 provider
     * 支持的档位不一样（workbuddy 只有 high，buddy 有 low/high/max）。取并集
     * 是为了让用户在模型选择器里能看到所有可选档位；具体某一站不支持时，
     * 由 `pickEffort` 的降级规则兜住（这一站不支持就退到它支持的档位），
     * 而不是让整条链直接不可用。
     *
     * 查不到档位时**不返回 reasoning**（而不是返回空 efforts）—— 空数组会被
     * 宿主以 `INVALID_MODEL_REASONING` 拒掉，那会让整条链在选择器里消失。
     *
     * @param {string} provider
     * @param {string} model
     * @param {AbortSignal} [_signal]
     */
    async resolveModel(provider, model, _signal) {
      const chain = findChainById(chains(), model);
      if (chain === undefined) {
        // 模型不在目录里：宿主会拿这个结果去校验，name/id 必须与请求一致。
        // 直接报「这个模型不存在」比返回空元数据更诚实。
        const error = new Error(`chain "${model}" is not configured`);
        error.code = 'NO_SUCH_CHAIN';
        throw error;
      }

      const merged = await mergeEfforts(chain, effortsFor);
      const contextWindow = await mergeContextWindow(chain, contextWindowFor);
      return {
        provider,
        id: model,
        name: chainLabel(chain),
        description: describeChain(chain),
        ...(contextWindow === null ? {} : { context: { contextWindow } }),
        ...(merged.efforts.length === 0 ? {} : {
          reasoning: {
            efforts: merged.efforts,
            ...(merged.defaultEffort === null ? {} : { defaultEffort: merged.defaultEffort }),
          },
        }),
      };
    },

    /**
     * 准备一次调用。
     *
     * `stream` 由我们自己实现：链的执行逻辑在 `index.js` 的 `runChain` 里
     * （它要记录事件、要处理「已吐字就不能换候选」这类规则）。
     *
     * @param {string} provider
     * @param {string} model
     * @param {AbortSignal} [signal]
     */
    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: (options) => runChain(provider, model, options),
      };
    },
  };
}

/**
 * 合并链上各站的推理档位。
 *
 * @param {{candidates: ReadonlyArray<{provider: string, model: string}>}} chain
 * @param {(provider: string, model: string) => Promise<{efforts: Array<{id: string, name: string}>, defaultEffort: string|null}>} effortsFor
 * @returns {Promise<{efforts: Array<{id: string, name: string}>, defaultEffort: string|null}>}
 */
async function mergeEfforts(chain, effortsFor) {
  /** @type {Map<string, string>} */
  const byId = new Map();
  /** @type {string|null} */
  let defaultEffort = null;

  for (const candidate of chain.candidates) {
    let info;
    try {
      info = await effortsFor(candidate.provider, candidate.model);
    } catch {
      continue;
    }
    if (info === null || info === undefined) continue;
    for (const effort of info.efforts ?? []) {
      if (typeof effort?.id !== 'string' || effort.id === '') continue;
      if (!byId.has(effort.id)) {
        byId.set(effort.id, typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id);
      }
    }
    // 默认档位：取第一个候选自己的默认（链头的默认最符合直觉）。
    if (defaultEffort === null && typeof info.defaultEffort === 'string' && info.defaultEffort !== '') {
      defaultEffort = info.defaultEffort;
    }
  }

  const efforts = [...byId.entries()].map(([id, name]) => ({ id, name }));
  if (efforts.length === 0) return { efforts, defaultEffort: null };
  // 默认档位必须落在并集里（宿主会校验 `defaultEffort` ∈ efforts）。
  if (defaultEffort === null || !byId.has(defaultEffort)) {
    defaultEffort = efforts[0].id;
  }
  return { efforts, defaultEffort };
}

/**
 * 链的上下文窗口：取各站里**最小**的那个。
 *
 * 链上任何一站装不下，整条链就装不下 —— 报一个乐观的数字只会在跑到那一站时
 * 才炸，那时候用户已经等了很久了。
 *
 * @param {{candidates: ReadonlyArray<{provider: string, model: string}>}} chain
 * @param {(provider: string, model: string) => Promise<number|null>} contextWindowFor
 * @returns {Promise<number|null>}
 */
async function mergeContextWindow(chain, contextWindowFor) {
  /** @type {number|null} */
  let smallest = null;
  for (const candidate of chain.candidates) {
    let window;
    try {
      window = await contextWindowFor(candidate.provider, candidate.model);
    } catch {
      continue;
    }
    if (!Number.isInteger(window) || window <= 0) continue;
    if (smallest === null || window < smallest) smallest = window;
  }
  return smallest;
}

/**
 * 档位展示名。
 *
 * @param {string} id
 * @returns {string}
 */
export function effortDisplayName(id) {
  if (typeof id !== 'string') return '';
  return EFFORT_NAMES[id] ?? id;
}

/**
 * 把「链」当成一个可执行单元跑起来 —— 供 `index.js` 的记录层复用。
 *
 * 这里刻意不 import `chain.js` 的 `shouldCommit` 之外的东西：链内切换的
 * 判定规则都在 `index.js` 的 `runChain` 里（它还负责记事件）。
 *
 * @param {object} chain
 * @param {object} options
 * @param {AsyncIterable<any>} stream
 */
export function isChainCommitted(chunk) {
  return shouldCommit(chunk);
}

/**
 * 失败终止块。
 *
 * @param {unknown} error
 * @param {{aborted?: boolean}|undefined} [signal]
 */
export function chainFailureFinish(error, signal) {
  return failureFinish(error, signal);
}

/**
 * 失败描述。
 *
 * @param {unknown} finish
 */
export function chainDescribeFinish(finish) {
  return describeFinish(finish);
}

/**
 * 失败块判定。
 *
 * @param {unknown} chunk
 */
export function chainIsFailureFinish(chunk) {
  return isFailureFinish(chunk);
}

/**
 * 按候选改写 options（导出给 `index.js` 复用同一套优先级规则）。
 *
 * @param {object} options
 * @param {object} candidate
 * @param {object} [chain]
 * @param {ReadonlySet<string>|null} [supported] - 这一站真支持的档位；`null` 表示查不到（不猜）。
 */
export function chainCandidateOptions(options, candidate, chain, supported) {
  return candidateOptions(options, candidate, chain, supported);
}

/**
 * 查某一站支持的档位（导出给 `index.js` 的链执行器用）。
 *
 * @param {string} provider
 * @param {string} model
 * @param {(provider: string, model: string) => Promise<{efforts: ReadonlyArray<{id: string}>}>} effortsFor
 * @returns {Promise<ReadonlySet<string>|null>}
 */
export function chainSupportedEfforts(provider, model, effortsFor) {
  return supportedEfforts(provider, model, effortsFor);
}

/**
 * 挑这一站真能用的档位（导出给 `index.js` 的链执行器用）。
 *
 * @param {object} candidate
 * @param {object} [chain]
 * @param {string|undefined} callerEffort
 * @param {ReadonlySet<string>|null} supported
 */
export function chainPickEffort(candidate, chain, callerEffort, supported) {
  return pickEffort(candidate, chain, callerEffort, supported);
}
