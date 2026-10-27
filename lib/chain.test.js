// `node --test lib/chain.test.js`
//
// 只测纯函数层（chain.js）。index.js 的整链编排用 `probe.mjs` 做真机验证，
// 因为那部分依赖宿主注入的 ctx 与 llm 服务。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CHAINS,
  candidateOptions,
  describeFinish,
  failureFinish,
  isFailureFinish,
  matchChain,
  normalizeChains,
  pickEffort,
  shouldCommit,
} from './chain.js';

test('normalizeChains：默认链可用', () => {
  const chains = normalizeChains(DEFAULT_CHAINS);
  assert.equal(chains.length, 1);
  assert.deepEqual(
    chains[0].candidates.map((c) => `${c.provider}/${c.model}`),
    ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash'],
  );
});

test('normalizeChains：非数组 / 缺候选 / 候选不足 2 个都丢弃', () => {
  assert.deepEqual(normalizeChains(undefined), []);
  assert.deepEqual(normalizeChains({}), []);
  assert.deepEqual(normalizeChains([null, 1, 'x']), []);
  assert.deepEqual(normalizeChains([{ name: 'a' }]), []);
  assert.deepEqual(
    normalizeChains([{ candidates: [{ provider: 'a', model: 'm' }] }]),
    [],
    '1 个候选等于没有回退，应丢弃整条链',
  );
});

test('normalizeChains：正常两条候选原样保留', () => {
  const chains = normalizeChains([{
    name: 'My Chain',
    candidates: [
      { provider: 'workbuddy', model: 'w' },
      { provider: 'buddy', model: 'b' },
    ],
  }]);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].name, 'My Chain');
  assert.equal(chains[0].head.provider, 'workbuddy');
  assert.equal(chains[0].candidates.length, 2);
});

test('normalizeChains：缺 provider 或 model 的候选被剔除，剔除后不足 2 个则整条丢弃', () => {
  const chains = normalizeChains([{
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: 'b' },
      { model: 'm2' },
    ],
  }]);
  assert.deepEqual(chains, []);

  const kept = normalizeChains([{
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: '', model: 'm2' },
      { provider: 'c', model: 'm3' },
    ],
  }]);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].candidates.map((c) => c.provider), ['a', 'c']);
});

test('normalizeChains：相邻重复候选合并，不相邻的保留', () => {
  const chains = normalizeChains([{
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: 'a', model: 'm', reasoningEffort: 'low' },
      { provider: 'b', model: 'm' },
      { provider: 'a', model: 'm' },
    ],
  }]);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].candidates.length, 3);
  assert.equal(chains[0].candidates[0].reasoningEffort, 'low', '后者覆盖前者');
});

test('normalizeChains：head 可显式指定；非法则整条丢弃', () => {
  const ok = normalizeChains([{
    head: { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  }]);
  assert.equal(ok[0].head.provider, 'buddy');

  const bad = normalizeChains([{
    head: { provider: 'buddy' },
    candidates: [
      { provider: 'workbuddy', model: 'm' },
      { provider: 'buddy', model: 'm' },
    ],
  }]);
  assert.deepEqual(bad, [], 'head 写错时宁可不动，也不要接错请求');
});

test('normalizeChains：空字符串被 trim 成空后视为缺失', () => {
  const chains = normalizeChains([{
    candidates: [
      { provider: '   ', model: 'm' },
      { provider: 'b', model: '  ' },
    ],
  }]);
  assert.deepEqual(chains, []);
});

test('normalizeChains：reasoningEffort / maxTokens 支持显式 null（删除该字段）', () => {
  const chains = normalizeChains([{
    candidates: [
      { provider: 'a', model: 'm', reasoningEffort: 'high', maxTokens: 1000 },
      { provider: 'b', model: 'm', reasoningEffort: null, maxTokens: null },
    ],
  }]);
  assert.equal(chains[0].candidates[0].reasoningEffort, 'high');
  assert.equal(chains[0].candidates[0].maxTokens, 1000);
  assert.equal(chains[0].candidates[1].reasoningEffort, null);
  assert.equal(chains[0].candidates[1].maxTokens, null);
});

test('normalizeChains：写 "auto" 与写 null 等价（都归一化成 null）', () => {
  const chains = normalizeChains([{
    reasoningEffort: 'auto',
    candidates: [
      { provider: 'a', model: 'm', reasoningEffort: 'auto' },
      { provider: 'b', model: 'm', reasoningEffort: null },
    ],
  }]);
  // 'auto' 不是任何 provider 的合法档位 id，留着它一路传下去会被宿主以
  // UNSUPPORTED_REASONING_EFFORT 拒掉，所以必须归一化成 null。
  assert.equal(chains[0].candidates[0].reasoningEffort, null);
  assert.equal(chains[0].candidates[1].reasoningEffort, null);
  assert.equal(chains[0].reasoningEffort, null);
});

test('normalizeChains：speedProbe 只认显式 true，缺省不带这个字段', () => {
  const on = normalizeChains([{
    speedProbe: true,
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' },
    ],
  }]);
  assert.equal(on[0].speedProbe, true);

  const off = normalizeChains([{
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' },
    ],
  }]);
  assert.equal('speedProbe' in off[0], false, '没写就别带，省得面板以为用户开了');

  const truthy = normalizeChains([{
    speedProbe: 'yes',
    candidates: [
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' },
    ],
  }]);
  assert.equal('speedProbe' in truthy[0], false, '只认 true，字符串不算');
});

test('pickEffort：候选写 null（自动）时到这一站就停，不再继承链级/调用方', () => {
  const picked = pickEffort({ reasoningEffort: null }, { reasoningEffort: 'high' }, 'max', null);
  assert.deepEqual(picked, { effort: null, source: 'candidate', dropped: null });
});

test('pickEffort：链级写 null（整条链自动）时压过调用方', () => {
  const picked = pickEffort({}, { reasoningEffort: null }, 'max', null);
  assert.equal(picked.effort, null, '用户选了「自动」，就不能被调用方的档位盖掉');
  assert.equal(picked.source, 'chain');
});

test('pickEffort：链级没设置时仍然用调用方的档位', () => {
  const picked = pickEffort({}, {}, 'max', null);
  assert.equal(picked.effort, 'max');
  assert.equal(picked.source, 'caller');
});

test('pickEffort：这一站不支持该档位时降级掉，不让整条链报废', () => {
  const picked = pickEffort({}, { reasoningEffort: 'max' }, undefined, new Set(['high']));
  assert.equal(picked.effort, null);
  assert.equal(picked.dropped, 'max');
});

test('pickEffort：查不到档位（null）就放行，不替用户瞎猜', () => {
  const picked = pickEffort({ reasoningEffort: 'max' }, {}, undefined, null);
  assert.equal(picked.effort, 'max', 'supported 为 null 表示查不到，不能当成「不支持」');
});

test('matchChain：只按链头匹配，不匹配备选', () => {
  const chains = normalizeChains([{
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  }]);
  assert.ok(matchChain(chains, { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }));
  assert.equal(
    matchChain(chains, { provider: 'buddy', model: 'deepseek-v4.1-flash' }),
    undefined,
    '备选自己发起的请求不能再被接管，否则成环',
  );
  assert.equal(matchChain(chains, { provider: 'trae', model: 'deepseek-v4.1-flash' }), undefined);
  assert.equal(matchChain(chains, null), undefined);
});

test('candidateOptions：不修改原对象（宿主可能冻结 options）', () => {
  const original = Object.freeze({
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
    maxTokens: 4000,
    messages: [],
  });
  const next = candidateOptions(original, { provider: 'buddy', model: 'deepseek-v4.1-flash' });
  assert.notEqual(next, original);
  assert.equal(next.provider, 'buddy');
  assert.equal(next.model, 'deepseek-v4.1-flash');
  assert.equal(next.reasoningEffort, 'high', '没覆盖就保留原值');
  assert.equal(next.maxTokens, 4000);
  assert.equal(original.provider, 'workbuddy', '原对象必须不变');
});

test('candidateOptions：reasoningEffort / maxTokens 为 null 时删除字段', () => {
  const next = candidateOptions(
    { provider: 'a', model: 'm', reasoningEffort: 'high', maxTokens: 100 },
    { provider: 'b', model: 'm', reasoningEffort: null, maxTokens: null },
  );
  assert.equal('reasoningEffort' in next, false);
  assert.equal('maxTokens' in next, false);
});

test('shouldCommit：正文与工具调用算提交，思考与 usage 不算', () => {
  assert.equal(shouldCommit({ type: 'text-delta', index: 0, text: '你' }), true);
  assert.equal(shouldCommit({ type: 'text-delta', index: 0, text: '' }), false);
  assert.equal(shouldCommit({ type: 'tool-call-delta', index: 0, id: 't1', name: 'read' }), true);
  assert.equal(shouldCommit({ type: 'tool-call-delta', index: 0, id: 't1', argumentsDelta: '{' }), true);
  assert.equal(shouldCommit({ type: 'block-end', block: { type: 'text', text: '有内容' } }), true);
  assert.equal(shouldCommit({ type: 'block-end', block: { type: 'text', text: '' } }), false);

  assert.equal(
    shouldCommit({ type: 'reasoning-delta', index: 0, text: '让我想想' }),
    false,
    '思考阶段撞额度墙是最该切换的场景，思考内容可以整段丢弃',
  );
  assert.equal(shouldCommit({ type: 'usage', usage: { inputTokens: 1 } }), false);
  assert.equal(shouldCommit({ type: 'block-start', index: 0, blockType: 'text' }), false);
  assert.equal(shouldCommit(null), false);
  assert.equal(shouldCommit('x'), false);
});

test('isFailureFinish：只认 finish 里的 error / aborted', () => {
  assert.equal(isFailureFinish({ type: 'finish', reason: { kind: 'error', failure: {} } }), true);
  assert.equal(isFailureFinish({ type: 'finish', reason: { kind: 'aborted', failure: {} } }), true);
  assert.equal(isFailureFinish({ type: 'finish', reason: { kind: 'stop' } }), false);
  assert.equal(isFailureFinish({ type: 'finish' }), false);
  assert.equal(isFailureFinish({ type: 'text-delta', text: 'x' }), false);
  assert.equal(isFailureFinish(undefined), false);
});

test('failureFinish：形状与宿主 adapterFailureChunk 一致', () => {
  const chunk = failureFinish(new Error('boom'));
  assert.equal(chunk.type, 'finish');
  assert.equal(chunk.reason.kind, 'error');
  assert.equal(chunk.reason.failure.message, 'boom');
  assert.equal(chunk.reason.failure.code, 'UNKNOWN');
});

test('failureFinish：带 status 的错误保留状态码；aborted 走 aborted 分支', () => {
  const error = Object.assign(new Error('quota'), { code: 'QUOTA', status: 429 });
  const failed = failureFinish(error);
  assert.equal(failed.reason.kind, 'error');
  assert.equal(describeFinish(failed), 'QUOTA status=429 quota');

  const aborted = failureFinish(new Error('x'), { aborted: true });
  assert.equal(aborted.reason.kind, 'aborted');
});

test('describeFinish：畸形输入不抛错', () => {
  assert.equal(typeof describeFinish(undefined), 'string');
  assert.equal(typeof describeFinish({ type: 'finish' }), 'string');
  assert.equal({}.x, undefined);
});
