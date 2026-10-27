// 纯函数层：链配置归一化、命中判定、chunk 判定、失败 chunk 构造。
//
// 这里刻意不 import 任何 DSH 内部包（`@deepseek-ai/dsh-llm` 等）：
//   · profile 的 node_modules 是扁平安装，插件被 Junction 链入后能否解析到
//     这些包取决于宿主版本，风险不值得；
//   · 本插件需要的东西（chunk 形状、finish 形状）都已在文档与实测里确定，
//     自己实现一份判据反而更好测。
//
// 所有函数都是纯函数，便于 `node --test` 直接覆盖。

/**
 * 默认链：先走国际版（用户观察到的免费额度），失败再切国内版。
 *
 * 为什么是这个顺序 —— 2026-10-26 的仓库网关 `/v1/models` 元数据：
 *   workbuddy/deepseek-v4.1-flash  name 里标「x0.00→免费」
 *   buddy/deepseek-v4.1-flash      name 里标「x0.11」
 * 两者能力一致（contextWindow 1e6、支持图片、reasoningEfforts 都含 high），
 * 所以先免费、后付费是严格更优的顺序。
 *
 * v0.5.0 起这条链不再是「装上就自动接管」的规则，而是模型选择器里的一个
 * 可点选条目（虚拟 provider `dsh-channel-chain` 下的一个 model）。
 *
 * @type {ReadonlyArray<object>}
 */
export const DEFAULT_CHAINS = Object.freeze([
  Object.freeze({
    id: 'flash-free-first',
    name: 'flash-free-first',
    candidates: Object.freeze([
      Object.freeze({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }),
      Object.freeze({ provider: 'buddy', model: 'deepseek-v4.1-flash' }),
    ]),
  }),
]);

/**
 * 链 id 的合法字符：字母、数字、连字符、下划线、点。
 *
 * 链 id 会直接当作模型选择器里的 **model id** 出现，所以必须短、唯一、
 * 且不掺任何宿主不认的字符。中文链名会被 slug 化成空串，那时退回
 * `chain-<序号>`（面板新建链时会给一个 `c-xxxxxx` 的稳定 id，所以中文名
 * 不会退化成序号）。
 */
const CHAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 把链名 slug 化成 id 候选。
 *
 * @param {unknown} name
 * @returns {string} 空串表示「这个名字 slug 不出来」。
 */
export function slugifyChainName(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 链 id 是否合法（面板创建链时用）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidChainId(value) {
  return typeof value === 'string' && CHAIN_ID_PATTERN.test(value);
}

/**
 * 按 id 找一条链。
 *
 * 链在模型选择器里就是「一个模型」，宿主只把 model id 交回来，得自己
 * 找回对应的链。
 *
 * @param {ReadonlyArray<{id?: string}>} chains
 * @param {unknown} id
 * @returns {object|undefined}
 */
export function findChainById(chains, id) {
  if (typeof id !== 'string' || id === '') return undefined;
  for (const chain of chains) {
    if (chain?.id === id) return chain;
  }
  return undefined;
}

/**
 * 把一个候选规格归一化；不合法返回 `undefined`。
 *
 * 允许的额外字段：
 *   · `reasoningEffort`：字符串 = 固定档位；`null` = 明确删掉这个字段
 *     （跨 provider 时两边支持的档位可能不同，删掉比传错更安全）；
 *     字段缺失 = 跟随链级/模型默认。
 *   · `maxTokens`：正整数 = 覆盖；`null` = 删掉。
 *
 * @param {unknown} value
 * @returns {{provider: string, model: string, reasoningEffort?: string|null, maxTokens?: number|null}|undefined}
 */
function normalizeCandidate(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (provider === '' || model === '') return undefined;

  const out = { provider, model };
  if (record.reasoningEffort === null) out.reasoningEffort = null;
  else if (typeof record.reasoningEffort === 'string' && record.reasoningEffort.length > 0) {
    out.reasoningEffort = record.reasoningEffort;
  }
  if (record.maxTokens === null) out.maxTokens = null;
  else if (Number.isSafeInteger(record.maxTokens) && record.maxTokens > 0) {
    out.maxTokens = /** @type {number} */ (record.maxTokens);
  }
  return out;
}

/**
 * 把配置里的 `chains` 归一化成可直接用的结构。
 *
 * 接受两种写法（`candidates` 与 `chain` 同义，前者优先）：
 * ```yaml
 * chains:
 *   - name: flash-free-first          # 可选，仅用于日志
 *     head: { provider: workbuddy, model: deepseek-v4.1-flash }   # 可选，默认取候选[0]
 *     candidates:
 *       - { provider: workbuddy, model: deepseek-v4.1-flash }
 *       - { provider: buddy,     model: deepseek-v4.1-flash }
 * ```
 *
 * 过滤规则（每条都会静默丢弃，不抛错 —— 插件配置错误不该让宿主起不来）：
 *   · 不是对象 / 没有候选数组 → 丢弃整条链；
 *   · 单个候选缺 provider 或 model → 丢弃该候选；
 *   · 相邻重复的候选 → 合并（后面的覆盖字段优先，避免无意义的重复请求）；
 *   · 归一化后候选少于 `minCandidates` 个 → 丢弃整条链（默认 2 个：1 个候选
 *     等于没有回退，白加一层包装）；
 *   · `head` 写了但归一化失败 → 丢弃整条链（宁可不动，也不要接错请求）。
 *
 * `minCandidates` 存在的理由：面板允许用户在链里删模型，删到只剩 1 个是**合法
 * 的中间状态**（「我只想先试这一个」）。配置文件仍按 2 个起算，面板保存时传 1，
 * 这样两个入口的严格程度可以不一样而不必各写一份归一化。
 *
 * @param {unknown} raw
 * @param {{minCandidates?: number}} [options]
 * @returns {Array<{id: string, name: string, head: {provider: string, model: string}, candidates: Array<object>}>}
 */
export function normalizeChains(raw, options = {}) {
  const minCandidates = Number.isSafeInteger(options.minCandidates) && options.minCandidates > 0
    ? options.minCandidates
    : 2;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (entry === null || typeof entry !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const list = Array.isArray(record.candidates)
      ? record.candidates
      : Array.isArray(record.chain)
        ? record.chain
        : undefined;
    if (list === undefined) continue;

    /** @type {Array<object>} */
    const candidates = [];
    for (const item of list) {
      const candidate = normalizeCandidate(item);
      if (candidate === undefined) continue;
      const previous = candidates[candidates.length - 1];
      if (
        previous !== undefined
        && previous.provider === candidate.provider
        && previous.model === candidate.model
      ) {
        candidates[candidates.length - 1] = { ...previous, ...candidate };
        continue;
      }
      candidates.push(candidate);
    }
    if (candidates.length < minCandidates) continue;

    const head = record.head === undefined ? candidates[0] : normalizeCandidate(record.head);
    if (head === undefined) continue;

    const name = typeof record.name === 'string' && record.name.length > 0
      ? record.name
      : `chain-${index + 1}`;
    const id = uniqueChainId(out, record.id, name, index);

    /** @type {{id: string, name: string, head: object, candidates: Array<object>, reasoningEffort?: string}} */
    const chain = { id, name, head, candidates };
    // 链级档位：用户在模型选择器里给整条链选一个档位时用。
    // 缺省表示「跟随各模型自己的默认」。
    if (typeof record.reasoningEffort === 'string' && record.reasoningEffort.length > 0) {
      chain.reasoningEffort = record.reasoningEffort;
    }
    out.push(chain);
  }
  return out;
}

/**
 * 给链挑一个在整份列表里唯一的 id。
 *
 * 优先级：配置里写的 `id` → 链名 slug → `chain-<序号>`。取到的 id 若已被
 * 别的链占用，就加 `-2`、`-3` 后缀 —— **id 是模型选择器里模型的唯一标识，
 * 撞了就会让两条链在选择器里长得一模一样，用户根本分不清选的是哪条**。
 *
 * @param {ReadonlyArray<{id: string}>} taken
 * @param {unknown} rawId
 * @param {string} name
 * @param {number} index
 * @returns {string}
 */
function uniqueChainId(taken, rawId, name, index) {
  const used = new Set(taken.map((chain) => chain.id));
  const preferred = typeof rawId === 'string' && isValidChainId(rawId)
    ? rawId
    : slugifyChainName(name) || `chain-${index + 1}`;
  if (!used.has(preferred)) return preferred;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${preferred}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${preferred}-${Date.now().toString(36)}`;
}

/**
 * 找出这次请求该走哪条链。
 *
 * 只按链头匹配：请求命中链头才接管。这样链上的备选（比如 buddy）被别处
 * 直接请求时不会被再次包装，避免「A→B→A」的环。
 *
 * @param {ReadonlyArray<{head: {provider: string, model?: string}}>} chains
 * @param {unknown} options - `llm/stream` 的 options。
 * @returns {object|undefined}
 */
export function matchChain(chains, options) {
  if (options === null || typeof options !== 'object') return undefined;
  const target = /** @type {Record<string, unknown>} */ (options);
  for (const chain of chains) {
    if (chain.head.provider !== target.provider) continue;
    if (chain.head.model !== undefined && chain.head.model !== target.model) continue;
    return chain;
  }
  return undefined;
}

/**
 * 按候选规格改写一次调用的 options。
 *
 * 一律返回**新对象**：宿主可能把 options 冻结（`Object.isFrozen(options)`），
 * 直接改会抛 TypeError。
 *
 * 档位合并规则（**候选固定档位 > 链级档位 > 调用方传的值**）：
 *   · 候选写了 `reasoningEffort: null` → **删掉**这个字段（明确表示这一站
 *     不指定档位，让上游用默认）；
 *   · 候选写了 `reasoningEffort`（字符串）→ 用它；
 *   · 候选没写 → 用链级档位；链级也没有 → 保留调用方传的值。
 *
 * 为什么候选固定档位优先于链级：链是「先走谁再走谁」的集合，链上不同
 * provider 支持的档位可能根本不同（workbuddy 只有 high，buddy 有
 * low/high/max）。用户在链级选了个 low，切到 workbuddy 就会被宿主以
 * `UNSUPPORTED_REASONING_EFFORT` 拒掉 —— 所以每一站自己说了算更安全。
 *
 * `supported` 是这一站**实际支持**的档位集合（`null` = 查不到，不知道）。
 * 知道的话就把「这一站不支持的档位」降级掉（见 `pickEffort`），否则宿主
 * 会以 `UNSUPPORTED_REASONING_EFFORT` 直接拒掉整个请求。
 *
 * @param {object} options
 * @param {{provider: string, model: string, reasoningEffort?: string|null, maxTokens?: number|null}} candidate
 * @param {{reasoningEffort?: string}} [chain] - 链级档位。
 * @param {ReadonlySet<string>|null} [supported] - 这一站支持的档位（`null` = 未知）。
 * @returns {object}
 */
export function candidateOptions(options, candidate, chain, supported) {
  const next = { ...options, provider: candidate.provider, model: candidate.model };
  const picked = pickEffort(candidate, chain, options.reasoningEffort, supported);
  if (picked.effort === null) delete next.reasoningEffort;
  else next.reasoningEffort = picked.effort;
  if (candidate.maxTokens === null) delete next.maxTokens;
  else if (Number.isSafeInteger(candidate.maxTokens)) next.maxTokens = candidate.maxTokens;
  return next;
}

/**
 * 某一站支持哪些推理档位 —— 链内降级时要用。
 *
 * 链上各站的档位可能完全不同（workbuddy 只有 high，buddy 有 low/high/max）。
 * 链级选了一个 low，切到只支持 high 的那一站时，宿主会直接以
 * `UNSUPPORTED_REASONING_EFFORT` 拒掉整次调用 —— 链就白配了。
 * 所以切站前要先问一句「这一站支不支持这个档位」，不支持就退回去。
 *
 * 两种「不知道」必须分清：
 *   · 返回 `null` —— **查不到**（provider 离线、目录里没这个模型、查询报错）。
 *     此时**不降级**：宁可让宿主报那个准确的错，也不要我们替用户瞎猜。
 *   · 返回空集合 —— **确定这一站没有档位概念**（模型压根不支持 reasoning）。
 *     此时必须把 `reasoningEffort` 删掉，否则宿主会以
 *     `UNSUPPORTED_REASONING_EFFORT` 拒掉整次调用。
 *
 * @param {string} provider
 * @param {string} model
 * @param {(provider: string, model: string) => Promise<{efforts?: ReadonlyArray<{id: string}>, error?: string}>} effortsFor
 * @returns {Promise<ReadonlySet<string>|null>} null 表示「查不到，不做判断」。
 */
export async function supportedEfforts(provider, model, effortsFor) {
  if (typeof effortsFor !== 'function') return null;
  let info;
  try {
    info = await effortsFor(provider, model);
  } catch {
    return null;
  }
  if (info === null || info === undefined) return null;
  if (typeof info.error === 'string' && info.error !== '') return null;
  if (!Array.isArray(info.efforts)) return null;
  const ids = new Set();
  for (const effort of info.efforts) {
    if (typeof effort?.id === 'string' && effort.id !== '') ids.add(effort.id);
  }
  return ids;
}

/**
 * 挑一个这一站真能用的档位。
 *
 * 优先级（用户 m04534 拍板，**候选固定 > 链级 > 调用方**）：
 *   1. **候选固定** —— 面板里给这一站单独设的档位。最具体，不商量。
 *   2. **链级** —— 面板里给整条链设的默认档位。
 *   3. **调用方** —— 用户在模型选择器里给「这条链」选的那一档。
 *   4. 都没有 → 删掉 `reasoningEffort`，让上游用它自己的默认。
 *
 * 链级压过调用方，是为了让「这条链」在面板里配好之后表现稳定：用户在
 * 选择器里随手拨一档，不会让整条链的档位行为乱跳。
 *
 * 每一步都要过「这一站支不支持」这一关（`supported`）：
 *   · 支持 → 用它；
 *   · 不支持 → 退到下一档（**候选固定也退**：链的全部意义就是能撑住，
 *     某一站的档位填错就整条链报废，比降级更糟）；
 *   · **查不到**（`supported` 为 `null`）→ 保持原样，宁可让宿主报那个准确的
 *     `UNSUPPORTED_REASONING_EFFORT`，也不替用户瞎猜。
 *
 * @param {{reasoningEffort?: string|null}} candidate
 * @param {{reasoningEffort?: string}} [chain]
 * @param {string|undefined} callerEffort 调用方传的档位。
 * @param {ReadonlySet<string>|null|undefined} supported 这一站支持的档位；null = 查不到。
 * @returns {{effort: string|null, source: 'candidate'|'chain'|'caller'|'none', dropped: string|null}}
 */
export function pickEffort(candidate, chain, callerEffort, supported) {
  /** @type {string|null} */
  let dropped = null;

  const usable = (effort) => {
    if (effort === undefined) return false;
    if (supported === null || supported === undefined) return true;
    if (supported.has(effort)) return true;
    dropped = effort;
    return false;
  };

  // 候选写死：null = 明确不要档位（这一站自己决定）；字符串 = 不商量。
  if (candidate?.reasoningEffort === null) {
    return { effort: null, source: 'candidate', dropped: null };
  }
  if (typeof candidate?.reasoningEffort === 'string' && candidate.reasoningEffort !== '') {
    if (usable(candidate.reasoningEffort)) {
      return { effort: candidate.reasoningEffort, source: 'candidate', dropped: null };
    }
  }

  const chainEffort = typeof chain?.reasoningEffort === 'string' && chain.reasoningEffort !== ''
    ? chain.reasoningEffort
    : undefined;
  const caller = typeof callerEffort === 'string' && callerEffort !== '' ? callerEffort : undefined;

  if (usable(chainEffort)) return { effort: /** @type {string} */ (chainEffort), source: 'chain', dropped: null };
  if (usable(caller)) return { effort: /** @type {string} */ (caller), source: 'caller', dropped };
  return { effort: null, source: 'none', dropped };
}

/**
 * 这一块 chunk 是否代表「模型真的开始回答了」。
 *
 * 判定为真的那一刻起就不再允许换候选 —— 已经吐给用户的内容收不回来，
 * 换候选会造成前言不搭后语。所以：
 *   · `text-delta` 有正文 → 提交；
 *   · `tool-call-delta` 有工具名或参数 → 提交（工具调用也是实质回答）；
 *   · `block-end` 的文本块有内容 → 提交；
 *   · **`reasoning-delta` 不算提交**（思考阶段撞额度墙正是最该切换的场景，
 *     而思考内容可以整段丢弃）；
 *   · `usage` / `block-start` 不算。
 *
 * @param {unknown} chunk
 * @returns {boolean}
 */
export function shouldCommit(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false;
  const record = /** @type {Record<string, any>} */ (chunk);
  if (record.type === 'text-delta') return typeof record.text === 'string' && record.text.length > 0;
  if (record.type === 'tool-call-delta') {
    const named = typeof record.name === 'string' && record.name.length > 0;
    const argued = typeof record.argumentsDelta === 'string' && record.argumentsDelta.length > 0;
    return named || argued;
  }
  if (record.type === 'block-end') {
    const block = record.block;
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      return typeof block.text === 'string' && block.text.length > 0;
    }
  }
  return false;
}

/**
 * 是不是一个「失败」的终止块。
 *
 * 宿主 `adapterStream` 的约定：adapter 抛错**不 throw**，而是产出一个
 * `{type:'finish', reason:{kind:'error'|'aborted', failure}}` 然后结束。
 * 所以判失败只能看这个块，不能靠 try/catch。
 *
 * @param {unknown} chunk
 * @returns {boolean}
 */
export function isFailureFinish(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false;
  const record = /** @type {Record<string, any>} */ (chunk);
  if (record.type !== 'finish') return false;
  const reason = record.reason;
  if (reason === null || typeof reason !== 'object') return false;
  return reason.kind === 'error' || reason.kind === 'aborted';
}

/**
 * 构造一个和宿主形状一致的失败终止块（`adapterFailureChunk` 的等价物）。
 *
 * @param {unknown} error
 * @param {{aborted?: boolean}|undefined} [signal]
 * @returns {{type: 'finish', reason: {kind: 'error'|'aborted', failure: {message: string, code: string}}}}
 */
export function failureFinish(error, signal) {
  const failure = normalizeFailure(error);
  const aborted = signal?.aborted === true || failure.code === 'ABORTED';
  return {
    type: 'finish',
    reason: aborted ? { kind: 'aborted', failure } : { kind: 'error', failure },
  };
}

/**
 * 对齐宿主 `normalizeLlmFailure` 的产出：`{message, code, status?, providerRetryAfterMs?, requestId?}`。
 *
 * `status` 一定要留着 —— 429 / 403 / 400 的处置方式不同，日志里没有状态码
 * 就没法判断「该不该重试」。
 *
 * @param {unknown} error
 * @returns {{message: string, code: string, status?: number, providerRetryAfterMs?: number, requestId?: string}}
 */
function normalizeFailure(error) {
  if (error === null || typeof error !== 'object') {
    return { message: String(error), code: 'UNKNOWN' };
  }
  const record = /** @type {Record<string, any>} */ (error);
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : String(error);
  const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : 'UNKNOWN';
  const failure = { message, code };
  if (Number.isInteger(record.status) && record.status >= 100) failure.status = record.status;
  if (Number.isFinite(record.providerRetryAfterMs) && record.providerRetryAfterMs > 0) {
    failure.providerRetryAfterMs = record.providerRetryAfterMs;
  }
  if (typeof record.requestId === 'string' && record.requestId.length > 0) {
    failure.requestId = record.requestId;
  }
  return failure;
}

/**
 * 给日志用的一句话描述。
 *
 * @param {unknown} finish
 * @returns {string}
 */
export function describeFinish(finish) {
  if (finish === null || typeof finish !== 'object') return String(finish);
  const reason = /** @type {Record<string, any>} */ (finish).reason;
  const failure = reason?.failure;
  const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN';
  const status = typeof failure?.status === 'number' ? ` status=${failure.status}` : '';
  const message = typeof failure?.message === 'string' ? failure.message : '';
  return `${code}${status}${message === '' ? '' : ` ${message}`}`;
}

/**
 * 从测试请求的 body 里解析出要测的候选。
 *
 * 两种写法（按顺序尝试）：
 *   ① `{ provider, model }` —— 直接指定，可以测**还没加进链里**的模型；
 *   ② `{ chainIndex, candidateIndex }` —— 测链上第几站，省得前端自己拼。
 *
 * @param {unknown} body
 * @param {ReadonlyArray<{name: string, candidates: ReadonlyArray<object>}>} chains
 *   当前生效的链（`chainState.chains`），仅写法 ② 用到。
 * @returns {{provider: string, model: string}|string}
 *   成功回候选对象；失败回一句中文错误说明（调用方直接转成 400）。
 */
export function pickCandidate(body, chains) {
  if (body === null || typeof body !== 'object') return '请求体必须是 JSON 对象';
  const record = /** @type {Record<string, any>} */ (body);

  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (provider !== '' && model !== '') return { provider, model };

  if (Number.isSafeInteger(record.chainIndex) && Number.isSafeInteger(record.candidateIndex)) {
    const chain = chains[record.chainIndex];
    if (chain === undefined) return `第 ${record.chainIndex + 1} 条链不存在（当前共 ${chains.length} 条）`;
    const candidate = chain.candidates?.[record.candidateIndex];
    if (candidate === undefined) {
      const total = Array.isArray(chain.candidates) ? chain.candidates.length : 0;
      return `链「${chain.name}」第 ${record.candidateIndex + 1} 站不存在（共 ${total} 站）`;
    }
    return { provider: candidate.provider, model: candidate.model };
  }

  return '需要 provider + model，或 chainIndex + candidateIndex';
}
