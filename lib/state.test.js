/**
 * state.js 单测（node --test lib/state.test.js）。
 *
 * 这些测试只锁「记录层」的行为：有界、可注入时钟、不抛错、快照形状。
 * 路由逻辑另由 chain.test.js / probe.mjs 覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_EVENTS, createRecorder } from './state.js';

test('默认上限与初始快照为空', () => {
  const recorder = createRecorder();
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.maxEvents, DEFAULT_MAX_EVENTS);
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.totals, { requests: 0, switches: 0, wins: 0, exhausted: 0, aborted: 0, passthrough: 0 });
  assert.deepEqual(snapshot.byChain, []);
});

test('begin / skip / win 串成一条可读的事件流', () => {
  let clock = 1000;
  const recorder = createRecorder({ now: () => clock });

  recorder.begin('c1', 'workbuddy/m');
  clock = 1500;
  recorder.skip('c1', 'workbuddy/m', { code: 'QUOTA', message: '额度不够', status: 429 });
  clock = 2000;
  recorder.win('c1', 'buddy/m', 1000, 2);

  const { events, totals, byChain } = recorder.snapshot();
  assert.deepEqual(events.map((e) => e.type), ['start', 'skip', 'win']);
  assert.deepEqual(events[1].failure, { code: 'QUOTA', message: '额度不够', status: 429 });
  assert.equal(events[2].elapsedMs, 1000, 'elapsedMs 从 begin 的时刻算');
  assert.equal(events[2].attempts, 2);
  assert.deepEqual(totals, { requests: 1, switches: 1, wins: 1, exhausted: 0, aborted: 0, passthrough: 0 });
  assert.deepEqual(byChain, [{ name: 'c1', requests: 1, switches: 1, wins: 1, exhausted: 0 }]);
});

test('事件数有界：超出上限丢最旧的', () => {
  const recorder = createRecorder({ max: 3, now: () => 1 });
  for (let i = 0; i < 10; i += 1) recorder.begin(`c${i}`, 'p/m');
  const { events, maxEvents } = recorder.snapshot();
  assert.equal(maxEvents, 3);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.chain), ['c7', 'c8', 'c9']);
});

test('非法 max 回落到默认值', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, 'abc', undefined]) {
    const recorder = createRecorder({ max: bad });
    assert.equal(recorder.snapshot().maxEvents, DEFAULT_MAX_EVENTS, `max=${String(bad)} 应回落`);
  }
});

test('exhausted / aborted / passthrough 分别计数', () => {
  const recorder = createRecorder({ now: () => 5 });
  recorder.begin('c1', 'a/m');
  recorder.exhausted('c1', ['a/m', 'b/m']);
  recorder.begin('c1', 'a/m');
  recorder.aborted('c1');
  recorder.passthrough();
  recorder.passthrough();

  const { totals, events } = recorder.snapshot();
  assert.equal(totals.exhausted, 1);
  assert.equal(totals.aborted, 1);
  assert.equal(totals.passthrough, 2);
  const exhausted = events.find((e) => e.type === 'exhausted');
  assert.equal(exhausted.candidate, 'a/m → b/m');
});

test('畸形 failure 不抛错且被收敛成固定形状', () => {
  const recorder = createRecorder({ now: () => 1 });
  recorder.begin('c1', 'a/m');
  assert.doesNotThrow(() => recorder.skip('c1', 'a/m', undefined));
  assert.doesNotThrow(() => recorder.skip('c1', 'a/m', null));
  assert.doesNotThrow(() => recorder.skip('c1', 'a/m', { code: 42, message: null, status: 'nope' }));
  const skipEvents = recorder.snapshot().events.filter((e) => e.type === 'skip');
  assert.deepEqual(skipEvents[0].failure, { code: 'UNKNOWN', message: '' });
  assert.deepEqual(skipEvents[2].failure, { code: 'UNKNOWN', message: '' }, 'status 不是整数必须丢掉');
});

test('snapshot 把链配置与控制开关一并带上', () => {
  const recorder = createRecorder({ now: () => 7 });
  const chains = [{ name: 'c1', head: { provider: 'a', model: 'm' }, candidates: [{ provider: 'a', model: 'm' }] }];
  const snapshot = recorder.snapshot({ chains, enabled: true, logEnabled: false });
  assert.equal(snapshot.generatedAt, 7);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.logEnabled, false);
  assert.equal(snapshot.chains.length, 1);
});

test('elapsedMs 在时钟倒退时收敛为 0，不出现负数', () => {
  let clock = 5000;
  const recorder = createRecorder({ now: () => clock });
  recorder.begin('c1', 'a/m');
  clock = 1000; // 假的时钟倒退
  recorder.win('c1', 'a/m', 5000, 1);
  assert.equal(recorder.snapshot().events.at(-1).elapsedMs, 0);
});
