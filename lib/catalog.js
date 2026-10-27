/**
 * 模型目录、倍率与推理档位查询。
 *
 * 三件事：
 *
 * 1. **倍率**。渠道把倍率拼在模型显示名里，而不是放在独立字段上。形如
 *    `Deepseek-V4.1-Flash · x0.00→免费`，分隔符是 U+00B7（`·`）加一个空格。
 *    后缀一共五种形态：
 *
 *      · `x0.8`                 —— 普通倍率
 *      · `x0.2→x0.1`            —— 促销折扣（→ 是 U+2192）
 *      · `x0.00→免费`           —— 免费
 *      · `免费`                 —— 另一种渠道的免费写法（没有 x 前缀）
 *      · `x0.8 FOO`             —— 同名模型的消歧后缀（空格分隔）
 *
 *    所以解析时先按最后一个 ` · ` 切开，再用一条正则吃下整个后缀。
 *
 * 2. **推理档位**。宿主只在「这一站模型自己」的 `reasoning.efforts` 里校验档位，
 *    所以链上每一站支持哪些档位，得自己去问那个 provider。这里做懒加载 + 缓存：
 *    `resolveModelInfo` 可能触发上游刷新，不能每次都问。
 *
 * 3. **上下文长度**。链的上下文窗口取各站里**最小**的那个 —— 链上任何一站
 *    装不下，整条链就装不下。
 *
 * 这个文件刻意不 import 任何 DSH 内部包：插件目录被 Junction 链进 profile 的
 * node_modules，能否解析宿主包取决于宿主版本，刻意不 import 才稳。
 */

/**
 * 后缀形态：倍率（可带折扣箭头）或者「免费」，后面允许跟一个消歧后缀。
 *
 * @type {RegExp}
 */
const RATE_SUFFIX = /^(x[\d.]+(?:→(?:x[\d.]+|免费))?|免费)(?:\s+\S+)?$/;

/**
 * 缓存的存活时间。
 *
 * 上游换档位、改倍率都是罕见事件，但也不是不存在；给个上限，别让一份过期的
 * 目录一直留在面板里。
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 从模型显示名里解析倍率。
 *
 * @param {unknown} name 模型显示名（渠道原样透传的那一串）。
 * @returns {{rate: string, label: string}|null} 解析不出返回 null。
 */
export function parseRateLabel(name) {
  if (typeof name !== 'string') return null;
  const index = name.lastIndexOf(' · ');
  if (index < 0) return null;
  const suffix = name.slice(index + 3).trim();
  if (suffix === '') return null;
  const match = RATE_SUFFIX.exec(suffix);
  if (match === null) return null;
  return { rate: match[1], label: suffix };
}

/**
 * 造一个模型目录查询器。
 *
 * @param {object} options
 * @param {() => object|undefined} options.getRuntime 取宿主 llm 运行时（可能还没发布，所以是函数）。
 * @param {() => number} [options.now]
 */
export function createCatalog(options = {}) {
  const getRuntime = typeof options.getRuntime === 'function'
    ? options.getRuntime
    : () => options.runtime;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {Map<string, {at: number, value: any}>} */
  const modelsCache = new Map();
  /** @type {Map<string, {at: number, value: any}>} */
  const infoCache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  /**
   * 列出某 provider 的模型，并带上倍率。
   *
   * @param {string} provider
   * @returns {Promise<Array<{provider: string, model: string, name: string, rate: string|null, rateLabel: string|null}>>}
   */
  async function listModels(provider) {
    const runtime = getRuntime();
    if (runtime === undefined || runtime === null) return [];
    if (typeof runtime.listModels !== 'function') return [];
    const models = await runtime.listModels(provider);
    const out = [];
    for (const model of models ?? []) {
      const id = typeof model?.id === 'string' ? model.id : '';
      if (id === '') continue;
      const name = typeof model?.name === 'string' && model.name !== '' ? model.name : id;
      const rate = parseRateLabel(name);
      out.push({
        provider,
        model: id,
        name,
        rate: rate === null ? null : rate.rate,
        rateLabel: rate === null ? null : rate.label,
      });
    }
    modelsCache.set(provider, { at: now(), value: out });
    return out;
  }

  /**
   * 拿某 provider 的模型目录（带缓存）。
   *
   * @param {string} provider
   * @returns {Promise<Array<object>>}
   */
  async function modelsFor(provider) {
    const cached = modelsCache.get(provider);
    if (cached !== undefined && now() - cached.at < CACHE_TTL_MS) return cached.value;
    const key = `models:${provider}`;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const query = listModels(provider);
    inflight.set(key, query);
    try {
      return await query;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * 预热倍率缓存。
   *
   * `ratesFor` 故意只读缓存（不值得为「几折」单独发一轮请求），代价是
   * **首次打开面板时缓存是空的、倍率一栏全空**。所以面板在返回快照之前
   * 先调这里，把链上涉及的 provider 目录拉一遍。失败静默 —— 倍率是锦上
   * 添花，拉不到就不显示，不能因此让面板打不开。
   *
   * @param {ReadonlyArray<{provider: string, model: string}>} candidates
   * @returns {Promise<void>}
   */
  async function warm(candidates) {
    const providers = new Set();
    for (const candidate of candidates ?? []) {
      const provider = typeof candidate?.provider === 'string' ? candidate.provider : '';
      if (provider !== '') providers.add(provider);
    }
    await Promise.all([...providers].map(async (provider) => {
      try {
        await modelsFor(provider);
      } catch {
        // 倍率是可选信息，拉不到就留空。
      }
    }));
  }

  /**
   * 从缓存里查一批候选的倍率。**不打上游** —— 只想显示「几折」不值得为它
   * 发一轮请求。查不到就是查不到，界面上留空。
   *
   * @param {ReadonlyArray<{provider: string, model: string}>} candidates
   * @returns {Record<string, {rate: string|null, rateLabel: string|null, name: string}>}
   */
  function ratesFor(candidates) {
    /** @type {Record<string, {rate: string|null, rateLabel: string|null, name: string}>} */
    const out = {};
    for (const candidate of candidates ?? []) {
      const provider = typeof candidate?.provider === 'string' ? candidate.provider : '';
      const model = typeof candidate?.model === 'string' ? candidate.model : '';
      if (provider === '' || model === '') continue;
      const cached = modelsCache.get(provider);
      if (cached === undefined) continue;
      const hit = cached.value.find((entry) => entry.model === model);
      if (hit === undefined) continue;
      out[`${provider}/${model}`] = {
        rate: hit.rate,
        rateLabel: hit.rateLabel,
        name: hit.name,
      };
    }
    return out;
  }

  /**
   * 某模型的完整元数据（宿主归一化后的）。
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{info: object|null, error?: string}>}
   */
  async function modelInfo(provider, model) {
    const key = `${provider}/${model}`;
    const cached = infoCache.get(key);
    if (cached !== undefined && now() - cached.at < CACHE_TTL_MS) return cached.value;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const query = queryModelInfo(provider, model);
    inflight.set(key, query);
    try {
      const value = await query;
      infoCache.set(key, { at: now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * 真去问宿主。
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{info: object|null, error?: string}>}
   */
  async function queryModelInfo(provider, model) {
    const runtime = getRuntime();
    if (runtime === undefined || runtime === null) {
      return { info: null, error: 'llm 服务不可用' };
    }
    if (typeof runtime.resolveModelInfo !== 'function') {
      return { info: null, error: 'llm 服务不支持查询模型详情' };
    }
    try {
      const info = await runtime.resolveModelInfo(provider, model);
      return { info: info ?? null };
    } catch (error) {
      return {
        info: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 某模型支持哪些推理档位。
   *
   * 查不到时返回空列表而不是抛错：档位是锦上添花，模型本身能不能用才是
   * 另一回事，缺档位不该让整条链不可用。
   *
   * `error` 有值表示**查不到**（不是「不支持」）—— 调用方要区分这两种情况：
   * 查不到时不该贸然把档位删掉（也许真实 provider 支持），不支持才可以删。
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{efforts: Array<{id: string, name: string}>, defaultEffort: string|null, error?: string}>}
   */
  async function effortsFor(provider, model) {
    const { info, error } = await modelInfo(provider, model);
    if (info === null) {
      return { efforts: [], defaultEffort: null, error: error ?? '查不到模型详情' };
    }
    const reasoning = info.reasoning;
    const efforts = [];
    for (const effort of reasoning?.efforts ?? []) {
      const id = typeof effort?.id === 'string' ? effort.id : '';
      if (id === '') continue;
      efforts.push({
        id,
        name: typeof effort?.name === 'string' && effort.name !== '' ? effort.name : id,
      });
    }
    const defaultEffort = typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : null;
    return { efforts, defaultEffort };
  }

  /**
   * 某模型的上下文窗口；查不到返回 null。
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<number|null>}
   */
  async function contextWindowFor(provider, model) {
    const { info } = await modelInfo(provider, model);
    const window = info?.context?.contextWindow;
    return Number.isInteger(window) && window > 0 ? window : null;
  }

  /**
   * 清缓存（宿主广播 adapter 变更时调）。
   */
  function invalidate() {
    modelsCache.clear();
    infoCache.clear();
    inflight.clear();
  }

  return {
    listModels,
    modelsFor,
    warm,
    ratesFor,
    modelInfo,
    effortsFor,
    contextWindowFor,
    invalidate,
  };
}
