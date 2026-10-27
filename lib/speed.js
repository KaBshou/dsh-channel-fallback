/**
 * 切换前的「谁最快」探测 —— 纯函数 + 一个带超时的测量器。
 *
 * ## 为什么需要这个
 *
 * 链的默认行为是「按顺序试，第一个成功的赢」。顺序是静态的：配好之后
 * 先走谁后走谁就定了。但上游的可用性是动态的 —— 某个渠道今天限流、
 * 某个模型这两天慢得像蜗牛，用户不可能天天去面板里手动调序。
 *
 * 用户（m07637）要求：「在切换时测一下速度选择最快的」。
 *
 * ## 做法
 *
 * 真正要切换的那一刻（链头已经失败、还没开始吐正文），先**并发**给
 * 剩下的候选各发一个极小的请求，谁先回来就先试谁。测完之后：
 *   · 最快的那一站排到最前，其余按实测速度排；
 *   · 探不通的站排到最后（但不删掉 —— 探测失败不代表这次调用一定失败，
 *     真实请求的 payload 更大、走的路径也可能不同）；
 *   · **探测只影响顺序，不影响「试哪些站」**：所有候选都会被试一遍。
 *
 * ## 代价（必须诚实告诉用户）
 *
 * 探测本身要花 1–3 秒、还要烧一点额度。所以它是**可选开关**，默认关闭；
 * 只有用户明确要求「切换时选最快的」才开。
 *
 * ## 为什么探测请求这么小
 *
 * 探测的目的是测「首个响应块什么时候到」，不是测生成质量。所以只要
 * `maxTokens: 1` 的一个「hi」，让上游尽快吐出第一个 chunk 就够了。
 * 请求越小，测到的越接近真实的首字延迟（TTFT），而不是被长输出拖累。
 */

/**
 * 一次探测的结果。
 *
 * @typedef {object} ProbeResult
 * @property {string} provider
 * @property {string} model
 * @property {boolean} ok       探通了吗
 * @property {number} ms        首块耗时（失败时是失败耗时）
 * @property {string} [error]   失败原因（ok=false 时）
 */

/**
 * 探测用的提示词与预算。
 *
 * `maxTokens: 1` 是关键：上游一旦开始生成就会立刻吐第一个 chunk，
 * 我们测到的就是首字延迟。给大预算会让某些模型先思考几秒，测出来的是
 * 「思考完成时间」，与真实首字延迟不符。
 */
const PROBE_MESSAGES = Object.freeze([Object.freeze({ role: 'user', content: 'hi' })]);
const PROBE_MAX_TOKENS = 1;

/**
 * 给一个候选发探测请求，量出「第一个块到达」用了多久。
 *
 * 只认**第一个块**，不等到流结束 —— 我们关心的是首字延迟（TTFT），
 * 等完整回答既慢又浪费额度。拿到第一块就立刻 `return()` 关掉迭代器
 * （不关的话上游 HTTP 连接会一直挂着，socket 泄漏）。
 *
 * @param {object} deps
 * @param {(options: object) => AsyncIterable<any>} deps.stream  宿主 `ctx.llm.stream`
 * @param {object} deps.options  原始调用 options（沿用 sessionId 等，保证探测也走同一套鉴权/配额）
 * @param {{provider: string, model: string}} deps.candidate
 * @param {number} deps.timeoutMs 单个探测的超时
 * @param {() => number} [deps.now]
 * @param {AbortSignal} [deps.signal] 调用方的取消信号
 * @returns {Promise<ProbeResult>}
 */
export async function probeCandidate(deps) {
  const { stream, options, candidate, timeoutMs, signal } = deps;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const startedAt = now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  // 调用方取消时也要停掉探测 —— 用户已经不等了，别再烧额度。
  const onAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted === true) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let iterator;
  try {
    const routed = {
      ...options,
      provider: candidate.provider,
      model: candidate.model,
      messages: PROBE_MESSAGES,
      maxTokens: PROBE_MAX_TOKENS,
      signal: controller.signal,
    };
    // 探测不该继承调用方的档位：我们测的是这一站的**默认**速度。
    // 继承了高思考档位会让探测变慢，测出来的顺序也就不是用户实际会遇到的顺序。
    delete routed.reasoningEffort;

    iterator = stream(routed)[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) {
        // 流直接结束了：没内容也算探通（上游确实应答了），但耗时是完整的。
        return { provider: candidate.provider, model: candidate.model, ok: true, ms: now() - startedAt };
      }
      const chunk = step.value;
      // 任何一块都算「应答了」。包括 reasoning-delta：思考也是上游在动，
      // 我们量的是「多久开始有反应」，不是「多久有正文」。
      if (chunk !== null && typeof chunk === 'object') {
        const finish = chunk.type === 'finish';
        const failure = finish ? chunk.reason?.kind : undefined;
        if (finish && (failure === 'error' || failure === 'aborted')) {
          return {
            provider: candidate.provider,
            model: candidate.model,
            ok: false,
            ms: now() - startedAt,
            error: describeProbeFailure(chunk),
          };
        }
        return { provider: candidate.provider, model: candidate.model, ok: true, ms: now() - startedAt };
      }
    }
  } catch (error) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      ok: false,
      ms: now() - startedAt,
      error: error?.message ?? String(error),
    };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
    // 拿到第一块就关：不关的话上游会继续生成到结束，白烧额度 + 泄漏连接。
    const close = iterator?.return;
    if (typeof close === 'function') {
      try {
        await close.call(iterator);
      } catch {
        /* 关不上就算了，不影响测量结果 */
      }
    }
  }
}

/**
 * 从失败的 finish 块里抠一句人话，给日志和面板用。
 *
 * @param {any} chunk
 * @returns {string}
 */
function describeProbeFailure(chunk) {
  const failure = chunk?.reason?.failure;
  if (failure === null || typeof failure !== 'object') return 'probe failed';
  const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : '';
  const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : '';
  if (code !== '' && message !== '') return `${code}: ${message}`;
  return code !== '' ? code : message !== '' ? message : 'probe failed';
}

/**
 * 并发探测所有候选，按「能用的快慢」排好序。
 *
 * 排序规则：
 *   1. 探通的在前，按耗时升序；
 *   2. 探不通的在后，按耗时升序（都失败了就没差别，保持稳定）；
 *   3. **完全并列时保持原顺序** —— 用下标做最后的比较，保证结果稳定
 *      （不然每次切换顺序都可能不一样，用户会觉得「链坏了」）。
 *
 * 探测本身并发跑，总耗时约等于最慢那一站（不超过 `timeoutMs`）。
 *
 * @param {object} deps
 * @param {(options: object) => AsyncIterable<any>} deps.stream
 * @param {object} deps.options
 * @param {ReadonlyArray<{provider: string, model: string}>} deps.candidates
 * @param {number} deps.timeoutMs
 * @param {() => number} [deps.now]
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{ordered: Array<{provider: string, model: string}>, results: Array<ProbeResult>}>}
 */
export async function orderBySpeed(deps) {
  const { candidates } = deps;
  if (!Array.isArray(candidates) || candidates.length === 0) return { ordered: [], results: [] };
  // 只有一个候选就没什么可选的 —— 别浪费一次探测。
  if (candidates.length === 1) {
    return {
      ordered: candidates.map((candidate) => ({ provider: candidate.provider, model: candidate.model })),
      results: [],
    };
  }

  const results = await Promise.all(candidates.map((candidate) => probeCandidate({ ...deps, candidate })));

  const indexed = results.map((result, index) => ({ result, index }));
  indexed.sort((a, b) => {
    if (a.result.ok !== b.result.ok) return a.result.ok ? -1 : 1;
    if (a.result.ms !== b.result.ms) return a.result.ms - b.result.ms;
    return a.index - b.index;
  });

  const byKey = new Map();
  for (const entry of indexed) {
    byKey.set(`${entry.result.provider}/${entry.result.model}`, entry.result);
  }

  const ordered = indexed.map((entry) => ({
    provider: entry.result.provider,
    model: entry.result.model,
  }));
  return { ordered, results: indexed.map((entry) => entry.result) };
}

/**
 * 把探测结果写成一行日志，方便用户在 `dsh-channel-fallback.log` 里核对。
 *
 * @param {ReadonlyArray<ProbeResult>} results
 * @returns {string}
 */
export function describeProbes(results) {
  if (!Array.isArray(results) || results.length === 0) return '(no probe)';
  return results
    .map((result) => `${result.provider}/${result.model} ${result.ok ? `${result.ms}ms` : `FAIL(${result.ms}ms ${result.error ?? ''})`}`)
    .join(', ');
}
