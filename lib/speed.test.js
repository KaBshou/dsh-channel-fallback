import assert from 'node:assert/strict';
import test from 'node:test';

import { describeProbes, orderBySpeed, probeCandidate } from './speed.js';

/**
 * 造一个假的 `stream`：按 `plan` 里给每个 `provider/model` 配的行为返回
 * 异步可迭代对象，并记录被调用的顺序与参数。
 *
 * `plan[key]` 可以是：
 *   · 数字 → 等这么多毫秒后吐一个正文块；
 *   · `{fail: true, error}` → 立刻吐一个失败 finish；
 *   · `{hang: true}` → 一直不吐（测超时）；
 *   · 缺省 → 立刻吐一个正文块。
 */
function makeStream(plan = {}, options = {}) {
  const calls = [];
  const closed = [];
  const stream = (request) => {
    const key = `${request.provider}/${request.model}`;
    calls.push({ key, maxTokens: request.maxTokens, messages: request.messages, reasoningEffort: request.reasoningEffort });
    const behaviour = plan[key];
    let iterator;
    const make = async function* () {
      try {
        if (behaviour !== null && typeof behaviour === 'object' && behaviour.hang === true) {
          // 挂到 signal 被 abort，然后按宿主约定吐一个 aborted finish
          // （真实 adapter 被取消时产出的就是这种块，不会抛错）。
          await new Promise((resolve) => {
            const signal = request.signal;
            if (signal === undefined) return; // 没信号就真的挂着（测试会给超时）
            if (signal.aborted === true) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'finish', reason: { kind: 'aborted' } };
          return;
        }
        if (behaviour !== null && typeof behaviour === 'object' && behaviour.fail === true) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: behaviour.code ?? 'PROBE_FAIL', message: behaviour.error ?? 'probe failed' },
            },
          };
          return;
        }
        if (typeof behaviour === 'number' && behaviour > 0) {
          await new Promise((resolve) => setTimeout(resolve, behaviour));
        }
        yield { type: 'text-delta', text: 'x' };
      } finally {
        closed.push(key);
      }
    };
    iterator = make()[Symbol.asyncIterator]();
    if (options.noReturn !== true) {
      // 暴露一个可观测的 return()，验证「拿到第一块就关上游」。
      const originalReturn = iterator.return?.bind(iterator);
      iterator.return = async (value) => {
        closed.push(`return:${key}`);
        return originalReturn === undefined ? { done: true, value } : originalReturn(value);
      };
    }
    return { [Symbol.asyncIterator]: () => iterator };
  };
  return { stream, calls, closed };
}

const BASE_OPTIONS = Object.freeze({ provider: 'x', model: 'y', messages: [{ role: 'user', content: 'hi' }], sessionId: 's1' });

test('probeCandidate：探通时返回首块耗时，且拿到第一块就关上游', async () => {
  const host = makeStream({ 'a/m': 30 });
  const result = await probeCandidate({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidate: { provider: 'a', model: 'm' },
    timeoutMs: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'a');
  assert.equal(result.model, 'm');
  assert.ok(result.ms >= 25, `耗时应该接近 30ms，实际 ${result.ms}`);
  // 关键：必须关上游，否则 socket 泄漏。
  assert.ok(host.closed.includes('return:a/m'), '拿到第一块后应调用 iterator.return()');
});

test('probeCandidate：探测请求很小（maxTokens=1、不继承档位）', async () => {
  const host = makeStream({ 'a/m': 0 });
  await probeCandidate({
    stream: host.stream,
    options: { ...BASE_OPTIONS, reasoningEffort: 'max', maxTokens: 8000 },
    candidate: { provider: 'a', model: 'm' },
    timeoutMs: 1000,
  });
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].maxTokens, 1, '探测要 1 个 token，别烧额度');
  assert.equal(host.calls[0].reasoningEffort, undefined, '探测不继承高思考档位，否则测的不是默认速度');
  assert.deepEqual(host.calls[0].messages, [{ role: 'user', content: 'hi' }]);
});

test('probeCandidate：失败 finish 记为 ok=false 并带原因', async () => {
  const host = makeStream({ 'a/m': { fail: true, code: 'E429', error: 'rate limited' } });
  const result = await probeCandidate({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidate: { provider: 'a', model: 'm' },
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'E429: rate limited');
});

test('probeCandidate：超时记为 ok=false，且不会永远挂着', async () => {
  const host = makeStream({ 'a/m': { hang: true } });
  const startedAt = Date.now();
  const result = await probeCandidate({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidate: { provider: 'a', model: 'm' },
    timeoutMs: 60,
  });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - startedAt < 2000, '超时应该被真的执行，而不是干等');
});

test('probeCandidate：stream 直接抛错也记为 ok=false，不往外炸', async () => {
  const stream = () => {
    throw new Error('boom');
  };
  const result = await probeCandidate({
    stream,
    options: BASE_OPTIONS,
    candidate: { provider: 'a', model: 'm' },
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});

test('orderBySpeed：按实测速度排序，快的在前', async () => {
  const host = makeStream({ 'slow/m': 80, 'fast/m': 10, 'mid/m': 40 });
  const { ordered, results } = await orderBySpeed({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidates: [
      { provider: 'slow', model: 'm' },
      { provider: 'fast', model: 'm' },
      { provider: 'mid', model: 'm' },
    ],
    timeoutMs: 1000,
  });
  assert.deepEqual(ordered, [
    { provider: 'fast', model: 'm' },
    { provider: 'mid', model: 'm' },
    { provider: 'slow', model: 'm' },
  ]);
  assert.equal(results.length, 3);
  assert.equal(results.every((result) => result.ok), true);
});

test('orderBySpeed：探不通的排到最后，但仍然保留（不剔除）', async () => {
  const host = makeStream({ 'dead/m': { fail: true, code: 'NO_CREDIT' }, 'ok/m': 20 });
  const { ordered, results } = await orderBySpeed({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidates: [
      { provider: 'dead', model: 'm' },
      { provider: 'ok', model: 'm' },
    ],
    timeoutMs: 1000,
  });
  assert.deepEqual(ordered, [
    { provider: 'ok', model: 'm' },
    { provider: 'dead', model: 'm' },
  ]);
  assert.equal(results.find((result) => result.provider === 'dead').ok, false);
});

test('orderBySpeed：只有一个候选时不探测（省一次请求）', async () => {
  const host = makeStream({ 'a/m': 10 });
  const { ordered, results } = await orderBySpeed({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidates: [{ provider: 'a', model: 'm' }],
    timeoutMs: 1000,
  });
  assert.deepEqual(ordered, [{ provider: 'a', model: 'm' }]);
  assert.deepEqual(results, []);
  assert.equal(host.calls.length, 0, '单候选没什么可选的，不该白打一次');
});

test('orderBySpeed：空候选返回空，不抛错', async () => {
  const host = makeStream({});
  const { ordered, results } = await orderBySpeed({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidates: [],
    timeoutMs: 1000,
  });
  assert.deepEqual(ordered, []);
  assert.deepEqual(results, []);
});

test('orderBySpeed：完全并列时保持原顺序（结果必须稳定）', async () => {
  const host = makeStream({ 'a/m': 0, 'b/m': 0, 'c/m': 0 });
  const { ordered } = await orderBySpeed({
    stream: host.stream,
    options: BASE_OPTIONS,
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' },
      { provider: 'c', model: 'm' },
    ],
    timeoutMs: 1000,
  });
  // 三个都 0ms，排序必须退回下标顺序，否则用户会觉得「链每次都不一样」。
  assert.deepEqual(ordered.map((entry) => entry.provider), ['a', 'b', 'c']);
});

test('describeProbes：探通写毫秒，探不通写 FAIL', () => {
  const line = describeProbes([
    { provider: 'a', model: 'm', ok: true, ms: 123 },
    { provider: 'b', model: 'm', ok: false, ms: 4000, error: 'TIMEOUT' },
  ]);
  assert.equal(line, 'a/m 123ms, b/m FAIL(4000ms TIMEOUT)');
  assert.equal(describeProbes([]), '(no probe)');
});
