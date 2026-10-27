// 整链编排的真跑验证（node probe.mjs）。
//
// 用假的 ctx / llm 复刻宿主 `llm/stream` 瀑布的语义，把 index.js 的编排逻辑
// 跑一遍：链头成功 / 链头失败切备选 / 两个都失败 / 思考阶段失败也要切 /
// 调用方取消 / 非链头请求原样透传 / 一次成功即不再请求后面的候选 / 递归保护。
//
// 复刻的关键点（与宿主一致，别简化掉）：
//   · `ctx.llm.stream(opts)` == `waterfall('llm/stream', opts, () => adapterStream(opts))`
//     —— 插件用它发起备选调用时，会**重新**走一遍瀑布；靠 AsyncLocalStorage
//     标记让监听器见到自己的调用就透传。
//   · adapter 失败不 throw，而是产出 `{type:'finish', reason:{kind:'error'}}`。

import assert from 'node:assert/strict';

import { apply } from './lib/index.js';

/**
 * 复刻宿主：`ctx.llm.stream()` 每次都完整走一遍 `llm/stream` 瀑布，
 * 瀑布最内层是测试提供的 adapter 行为。
 *
 * @param {(options: object) => AsyncIterable<any>} adapter
 */
function makeHost(adapter) {
  const listeners = [];
  const calls = [];

  const ctx = {
    on(name, listener) {
      assert.equal(name, 'llm/stream');
      listeners.push(listener);
      return () => {};
    },
  };

  /** 内置行为：记一笔调用，然后交给测试的 adapter。 */
  const builtin = (options) => {
    calls.push(`${options.provider}/${options.model}`);
    return adapter(options);
  };

  /** 瀑布派发：监听器由外到内包裹，`next()` 继续。 */
  const dispatch = (index, options) => {
    const listener = listeners[index];
    if (listener === undefined) return builtin(options);
    return listener(options, () => dispatch(index + 1, options));
  };

  ctx.llm = {
    stream(options) {
      return dispatch(0, options);
    },
  };

  return { ctx, calls, listeners };
}

/** 把一串 chunk 变成 AsyncIterable。 */
function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

/** 先吐几个 chunk 再抛错的流（模拟 adapter 迭代中途炸掉）。 */
function throwingStream(chunks, error) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
    throw error;
  })();
}

const text = (t) => ({ type: 'text-delta', index: 0, text: t });
const think = (t) => ({ type: 'reasoning-delta', index: 0, text: t });
const usage = { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } };
const stop = { type: 'finish', reason: { kind: 'stop' } };
const failed = (code = 'QUOTA_EXCEEDED', status = 429) => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message: `失败 ${code}`, code, status } },
});
const aborted = { type: 'finish', reason: { kind: 'aborted', failure: { message: '用户取消', code: 'ABORTED' } } };

/** 收集一个 async iterable 的全部 chunk。 */
async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const DEFAULT_CONFIG = {
  chains: [{
    name: 'test-chain',
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  }],
};

const HEAD = { provider: 'workbuddy', model: 'deepseek-v4.1-flash' };

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✔ ${name}`);
}

// ── 1. 链头成功：只请求一次，chunk 原样透传 ────────────────────────────────
{
  const chunks = [usage, text('你'), text('好'), stop];
  const { ctx, calls } = makeHost(() => streamOf(chunks));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(out, chunks);
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash']);
  ok('链头成功：只请求一次，chunk 原样透传');
}

// ── 2. 链头失败：自动切备选，用户只看到成功那次的正文 ──────────────────────
{
  const { ctx, calls } = makeHost((options) => (
    options.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([usage, text('好'), stop])
  ));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.deepEqual(out, [usage, text('好'), stop], '链头那份失败 chunk 不能泄漏给用户');
  ok('链头失败：自动切备选，失败 chunk 不外泄');
}

// ── 3. 思考阶段失败：思考内容整段丢弃，切备选 ──────────────────────────────
{
  const { ctx, calls } = makeHost((options) => (
    options.provider === 'workbuddy'
      ? streamOf([think('让我想想'), failed('QUOTA_EXCEEDED')])
      : streamOf([text('答案'), stop])
  ));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.deepEqual(out, [text('答案'), stop], '思考 chunk 必须整段丢弃，不能拼到答案前面');
  ok('思考阶段失败：整段丢弃思考内容并切备选');
}

// ── 4. 已经开始吐正文后才出错：不再切换，异常继续上抛 ──────────────────────
//
// 宿主注释把「middleware / nested-call / cleanup / consumer failures」划为
// 「remain thrown」—— 已提交后我们只是透明管道，抛错必须原样传给调用方，
// 绝不能吞掉，否则上层会以为请求成功。
{
  const boom = Object.assign(new Error('断流'), { code: 'NETWORK' });
  const { ctx, calls } = makeHost(() => throwingStream([text('半'), text('句')], boom));
  apply(ctx, DEFAULT_CONFIG);
  const out = [];
  let caught;
  try {
    for await (const chunk of ctx.llm.stream(HEAD, { messages: [] })) out.push(chunk);
  } catch (error) {
    caught = error;
  }
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash'], '已经吐字就更不该换候选');
  assert.deepEqual(out, [text('半'), text('句')], '已吐出的内容照常交付');
  assert.equal(caught, boom, '中途异常必须原样上抛，不能吞');
  ok('已提交后出错：不切换，异常原样上抛');
}

// ── 5. adapter 抛错（不是 finish chunk）：也能切 ───────────────────────────
{
  const { ctx, calls } = makeHost((options) => (
    options.provider === 'workbuddy'
      ? throwingStream([], new Error('boom'))
      : streamOf([text('ok'), stop])
  ));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.deepEqual(out, [text('ok'), stop]);
  ok('adapter 抛错：识别为失败并切备选');
}

// ── 6. 全部候选失败：产出失败 finish，不 throw ─────────────────────────────
{
  const { ctx, calls } = makeHost((options) => streamOf([
    failed(options.provider === 'buddy' ? 'FINAL' : 'QUOTA_EXCEEDED'),
  ]));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'finish');
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(out[0].reason.failure.code, 'FINAL', '最后一份失败要如实上报');
  ok('全部失败：产出最后一个失败 finish，不 throw');
}

// ── 7. 调用方取消：不再打扰备选 ────────────────────────────────────────────
{
  const { ctx, calls } = makeHost(() => streamOf([aborted]));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash'], '取消不是故障，不该再拿备选去打扰上游');
  assert.equal(out[0].reason.kind, 'aborted');
  ok('调用方取消：直接结束，不切备选');
}

// ── 8. 非链头请求：一个字节都不碰 ──────────────────────────────────────────
{
  const chunks = [failed('QUOTA_EXCEEDED')];
  const { ctx, calls } = makeHost(() => streamOf(chunks));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream({ provider: 'trae', model: 'deepseek-v4.1-flash' }, { messages: [] }));
  assert.deepEqual(calls, ['trae/deepseek-v4.1-flash']);
  assert.deepEqual(out, chunks, '不归我们管的请求必须原样透传');
  ok('非链头请求：原样透传，不接管');
}

// ── 9. 备选自己发起的请求：不再被包装（防成环） ────────────────────────────
{
  const { ctx, calls } = makeHost(() => streamOf([failed('STILL_BAD')]));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(
    { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    { messages: [] },
  ));
  assert.deepEqual(calls, ['buddy/deepseek-v4.1-flash']);
  assert.equal(out[0].reason.failure.code, 'STILL_BAD');
  ok('备选自己发起的请求：不再被接管，不会成环');
}

// ── 10. 空流（无正文直接结束）：视为失败并切备选 ───────────────────────────
{
  const { ctx, calls } = makeHost((options) => (
    options.provider === 'workbuddy' ? streamOf([]) : streamOf([text('有内容'), stop])
  ));
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.deepEqual(out, [text('有内容'), stop]);
  ok('空流：视为失败并切备选');
}

// ── 11. 递归保护：备选经由 ctx.llm.stream 发起时不会无限递归 ───────────────
{
  const seen = [];
  const { ctx, calls } = makeHost((options) => {
    seen.push(options.provider);
    return options.provider === 'workbuddy'
      ? streamOf([failed('QUOTA_EXCEEDED')])
      : streamOf([text('备选答案'), stop]);
  });
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(out, [text('备选答案'), stop]);
  assert.deepEqual(seen, ['workbuddy', 'buddy'], '备选只请求一次，没有递归');
  assert.equal(calls.length, 2);
  ok('递归保护：备选经由 ctx.llm.stream 发起时只请求一次');
}

// ── 12. enabled:false / 非法配置：不注册监听器 ─────────────────────────────
{
  const chunks = [text('x'), stop];
  const disabled = makeHost(() => streamOf(chunks));
  apply(disabled.ctx, { enabled: false });
  assert.equal(disabled.listeners.length, 0);
  assert.deepEqual(await collect(disabled.ctx.llm.stream(HEAD, {})), chunks);

  const bogus = makeHost(() => streamOf(chunks));
  apply(bogus.ctx, { chains: [{ candidates: [{ provider: 'a', model: 'm' }] }] });
  assert.equal(bogus.listeners.length, 0, '候选不足 2 个时不注册');
  assert.deepEqual(await collect(bogus.ctx.llm.stream({ provider: 'a', model: 'm' }, {})), chunks);
  ok('enabled:false 与非法配置：不注册监听器，一切原样');
}

// ── 13. 自定义链：第三个候选也能被用上 ────────────────────────────────────
{
  const { ctx, calls } = makeHost((options) => (
    options.provider === 'trae' ? streamOf([text('第三站'), stop]) : streamOf([failed()])
  ));
  apply(ctx, {
    chains: [{
      candidates: [
        { provider: 'workbuddy', model: 'm' },
        { provider: 'buddy', model: 'm' },
        { provider: 'trae', model: 'm' },
      ],
    }],
  });
  const out = await collect(ctx.llm.stream({ provider: 'workbuddy', model: 'm' }, {}));
  assert.deepEqual(calls, ['workbuddy/m', 'buddy/m', 'trae/m']);
  assert.deepEqual(out, [text('第三站'), stop]);
  ok('自定义链：失败两次后用到第三个候选');
}

// ── 14. 与别的监听器共存：外层监听器仍能看到最终流 ────────────────────────
{
  const { ctx, calls } = makeHost((options) => (
    options.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ));
  // 先挂一个「别的插件」的监听器（模拟 cost-meter 之类），再挂我们的。
  const seenByOther = [];
  ctx.on('llm/stream', (options, next) => {
    seenByOther.push(options.provider);
    return next();
  });
  apply(ctx, DEFAULT_CONFIG);
  const out = await collect(ctx.llm.stream(HEAD, {}));
  assert.deepEqual(out, [text('好'), stop]);
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.deepEqual(
    seenByOther,
    ['workbuddy', 'buddy'],
    '我们自己发起的备选调用也会经过别的监听器（真实宿主行为），但我们见到标记就透传，不会二次包装',
  );
  ok('与别的监听器共存：我们的备选调用照常经过它们，但不重复接管');
}

// ── 15. 消费方提前 break：必须关掉上游迭代器，否则 socket 泄漏 ─────────────
//
// 这是最容易被忽略的一条：一旦开始回答，`runChain` 就不再接管上游迭代器，
// 收尾全落到 `restOf` 的 finally 上。少了它，调用方 break 之后上游 HTTP 流
// 会一直跑完。
{
  let closed = 0;
  const makeTracked = (chunks) => ({
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
        async return() {
          closed += 1;
          return { done: true, value: undefined };
        },
      };
    },
  });

  const { ctx, calls } = makeHost((options) => (
    options.provider === 'workbuddy'
      ? streamOf([failed('QUOTA_EXCEEDED')])
      : makeTracked([text('一'), text('二'), text('三'), stop])
  ));
  apply(ctx, DEFAULT_CONFIG);

  const seen = [];
  for await (const chunk of ctx.llm.stream(HEAD, {})) {
    seen.push(chunk);
    if (seen.length === 2) break; // 只读两段就退出
  }

  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.deepEqual(seen, [text('一'), text('二')]);
  assert.equal(closed, 1, '消费方 break 后必须关掉上游迭代器，且只关一次');
  ok('消费方提前 break：上游迭代器被关闭（防 socket 泄漏）');
}

console.log(`\n全部 ${passed} 项编排验证通过。`);
