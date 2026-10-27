/**
 * 面板的数据记录层。
 *
 * 这一层只做一件事：把「每次请求走了哪条链、哪个候选失败、最后谁顶上」记下来，
 * 供宿主侧的只读 API 吐给设置页。**不参与任何路由决策** —— 路由全在 index.js，
 * 这里出错最多让面板显示得难看，绝不会影响模型请求。
 *
 * 设计约束：
 *   · 只记有界内存（默认 60 条事件），长跑不涨内存；
 *   · 时间戳可注入（`now`），单测才能稳定断言；
 *   · 任何方法都不抛错 —— 面板是观测工具，不该成为新的故障点。
 */

/** 默认保留多少条最近事件。 */
export const DEFAULT_MAX_EVENTS = 60;

/**
 * @typedef {object} FallbackEvent
 * @property {number} at - 毫秒时间戳。
 * @property {'start'|'skip'|'win'|'exhausted'|'passthrough'} type
 * @property {string} chain - 链名；passthrough 时为 ''。
 * @property {string} [candidate] - `provider/model`。
 * @property {object} [failure] - `{code, message, status?}`。
 * @property {number} [attempts] - 本次请求尝试了几个候选。
 * @property {number} [elapsedMs] - 从 start 到 win 的耗时。
 */

/**
 * @param {{max?: number, now?: () => number}} [options]
 */
export function createRecorder(options = {}) {
  const max = Number.isSafeInteger(options.max) && options.max > 0 ? options.max : DEFAULT_MAX_EVENTS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** @type {FallbackEvent[]} */
  const events = [];

  /** 全局累计。 */
  const totals = { requests: 0, switches: 0, wins: 0, exhausted: 0, aborted: 0, passthrough: 0 };

  /** 逐链累计，键是链名。 */
  const byChain = new Map();

  /**
   * @param {string} name
   */
  function chainStats(name) {
    let entry = byChain.get(name);
    if (entry === undefined) {
      entry = { requests: 0, switches: 0, wins: 0, exhausted: 0 };
      byChain.set(name, entry);
    }
    return entry;
  }

  /**
   * @param {FallbackEvent} event
   */
  function push(event) {
    try {
      events.push(event);
      while (events.length > max) events.shift();
    } catch {
      // 记录失败不影响主流程。
    }
  }

  /**
   * 一次请求开始。
   *
   * @param {string} chain
   * @param {string} requested - 调用方原本要求的 `provider/model`。
   * @returns {{at: number, chain: string}}
   */
  function begin(chain, requested) {
    totals.requests += 1;
    chainStats(chain).requests += 1;
    const stamp = { at: now(), chain };
    push({ at: stamp.at, type: 'start', chain, candidate: requested });
    return stamp;
  }

  /**
   * 某个候选失败了，正在换下一个。
   *
   * @param {string} chain
   * @param {string} candidate
   * @param {{code?: string, message?: string, status?: number}} failure
   */
  function skip(chain, candidate, failure) {
    totals.switches += 1;
    chainStats(chain).switches += 1;
    push({ at: now(), type: 'skip', chain, candidate, failure: trimFailure(failure) });
  }

  /**
   * 请求成功（第一个吐出正文的候选胜出）。
   *
   * @param {string} chain
   * @param {string} candidate
   * @param {number} startedAt
   * @param {number} attempts
   */
  function win(chain, candidate, startedAt, attempts) {
    totals.wins += 1;
    chainStats(chain).wins += 1;
    push({ at: now(), type: 'win', chain, candidate, attempts, elapsedMs: elapsed(now(), startedAt) });
  }

  /**
   * 全部候选都失败。
   *
   * @param {string} chain
   * @param {Array<string>} tried
   */
  function exhausted(chain, tried) {
    totals.exhausted += 1;
    chainStats(chain).exhausted += 1;
    push({ at: now(), type: 'exhausted', chain, candidate: tried.join(' → ') });
  }

  /** 调用方主动取消。 */
  function aborted(chain) {
    totals.aborted += 1;
    push({ at: now(), type: 'aborted', chain });
  }

  /** 不归本插件管的请求（只计数，不记明细，避免刷屏）。 */
  function passthrough() {
    totals.passthrough += 1;
  }

  /**
   * 给 API 的快照。
   *
   * @param {{chains?: unknown, enabled?: boolean, logEnabled?: boolean}} [context]
   */
  function snapshot(context = {}) {
    return {
      generatedAt: now(),
      enabled: context.enabled !== false,
      logEnabled: context.logEnabled === true,
      chains: Array.isArray(context.chains) ? context.chains : [],
      totals: { ...totals },
      byChain: [...byChain].map(([name, stats]) => ({ name, ...stats })),
      events: events.slice(),
      maxEvents: max,
    };
  }

  return { begin, skip, win, exhausted, aborted, passthrough, snapshot };
}

/**
 * @param {any} failure
 * @returns {{code: string, message: string, status?: number}}
 */
function trimFailure(failure) {
  const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN';
  const message = typeof failure?.message === 'string' ? failure.message : '';
  const trimmed = { code, message };
  if (Number.isSafeInteger(failure?.status)) trimmed.status = failure.status;
  return trimmed;
}

/**
 * @param {number} end
 * @param {number} start
 */
function elapsed(end, start) {
  const delta = end - start;
  return Number.isFinite(delta) && delta >= 0 ? delta : 0;
}
