/**
 * `lib/store.js` 的单测。
 *
 * 这一层决定「面板上点了保存，重启后还在不在」，所以测的重点不是 happy path，
 * 而是三种会让用户困惑的场景：
 *   · 写一半断电 → 不能留下半截 JSON（原子写 + 临时文件清理）；
 *   · 文件被手改坏 → 不能把插件带崩，也不能悄悄覆盖用户数据（`invalid` 三态）；
 *   · 提交了非法数据 → 必须报错，不能悄悄丢候选（否则用户以为少了的那站还在）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeChains } from '../lib/chain.js';
import {
  MAX_BODY_BYTES,
  STATE_VERSION,
  parseChainsPayload,
  readChainFile,
  removeChainFile,
  stateFilePath,
  writeChainFile,
} from '../lib/store.js';

/** 每个用例一个独立临时目录，互不干扰。 */
function tempFile(name = 'chains.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-store-'));
  return path.join(dir, name);
}

const SAMPLE = normalizeChains(
  [{ name: 'main', candidates: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, { provider: 'buddy', model: 'deepseek-v4.1-flash' }] }],
  { minCandidates: 1 },
);

test('stateFilePath 默认落在 ~/.dsh/channel-fallback/chains.json', () => {
  const saved = process.env.DSH_CHANNEL_FALLBACK_STATE;
  delete process.env.DSH_CHANNEL_FALLBACK_STATE;
  try {
    assert.equal(stateFilePath(), path.join(os.homedir(), '.dsh', 'channel-fallback', 'chains.json'));
  } finally {
    if (saved !== undefined) process.env.DSH_CHANNEL_FALLBACK_STATE = saved;
  }
});

test('stateFilePath 认环境变量覆盖（探针靠它不碰真实配置）', () => {
  const saved = process.env.DSH_CHANNEL_FALLBACK_STATE;
  process.env.DSH_CHANNEL_FALLBACK_STATE = '  ./tmp/x.json  ';
  try {
    assert.equal(stateFilePath(), path.resolve('./tmp/x.json'));
  } finally {
    if (saved === undefined) delete process.env.DSH_CHANNEL_FALLBACK_STATE;
    else process.env.DSH_CHANNEL_FALLBACK_STATE = saved;
  }
});

test('文件不存在时报 missing，不报错', () => {
  const result = readChainFile(tempFile());
  assert.equal(result.kind, 'missing');
});

test('写进去再读出来，链一字不差，并带上版本与时间', () => {
  const file = tempFile();
  const updatedAt = writeChainFile(file, SAMPLE, { now: () => 1700000000000 });
  assert.equal(updatedAt, new Date(1700000000000).toISOString());

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, STATE_VERSION);
  assert.equal(raw.updatedAt, updatedAt);

  const read = readChainFile(file);
  assert.equal(read.kind, 'ok');
  assert.equal(read.updatedAt, updatedAt);
  assert.deepEqual(read.chains, SAMPLE);
});

test('裸数组写法也能读（方便手写）', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify(SAMPLE), 'utf8');
  const read = readChainFile(file);
  assert.equal(read.kind, 'ok');
  assert.deepEqual(read.chains, SAMPLE);
  assert.equal(read.updatedAt, undefined);
});

test('半截 JSON 报 invalid 而不是抛错（插件不能因此起不来）', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{"chains": [', 'utf8');
  const read = readChainFile(file);
  assert.equal(read.kind, 'invalid');
  assert.match(read.reason, /JSON/);
});

test('JSON 合法但不是链（缺 chains 数组）也报 invalid', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
  assert.equal(readChainFile(file).kind, 'invalid');
});

test('目录不存在时自动创建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-store-'));
  const file = path.join(dir, 'deep', 'nested', 'chains.json');
  writeChainFile(file, SAMPLE);
  assert.equal(readChainFile(file).kind, 'ok');
});

test('原子写：成功后目录里不留临时文件', () => {
  const file = tempFile();
  writeChainFile(file, SAMPLE);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('写盘失败时抛错且清掉临时文件（不能假装保存成功）', () => {
  const file = tempFile();
  const dir = path.dirname(file);
  // 把目标文件变成一个**目录**，rename 必定失败。
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => writeChainFile(file, SAMPLE));
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('removeChainFile 删得掉，重复删不报错', () => {
  const file = tempFile();
  writeChainFile(file, SAMPLE);
  assert.equal(removeChainFile(file), true);
  assert.equal(readChainFile(file).kind, 'missing');
  assert.equal(removeChainFile(file), true);
});

test('parseChainsPayload 接受合法提交', () => {
  const result = parseChainsPayload({ chains: SAMPLE }, normalizeChains);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chains, SAMPLE);
});

test('parseChainsPayload 接受单候选链（面板允许删到只剩一个）', () => {
  const single = [{ name: 'only', candidates: [{ provider: 'buddy', model: 'deepseek-v4.1-flash' }] }];
  const result = parseChainsPayload({ chains: single }, normalizeChains);
  assert.equal(result.ok, true);
  assert.equal(result.chains[0].candidates.length, 1);
});

test('parseChainsPayload 的 reset 走单独分支', () => {
  const result = parseChainsPayload({ reset: true }, normalizeChains);
  assert.deepEqual(result, { ok: true, chains: [], reset: true });
});

test('parseChainsPayload 拒绝各种非法提交，且都带可读原因', () => {
  const cases = [
    [null, /JSON 对象/],
    [{}, /chains 必须是数组/],
    [{ chains: [] }, /至少要有一条链/],
    [{ chains: ['x'] }, /不是对象/],
    [{ chains: [{ name: 'a' }] }, /缺少 candidates/],
    [{ chains: [{ name: 'a', candidates: [] }] }, /没有任何候选/],
    [{ chains: [{ name: 'a', candidates: [null] }] }, /非对象/],
    [{ chains: [{ name: 'a', candidates: [{ provider: 'buddy' }] }] }, /缺 provider 或 model/],
    [{ chains: [{ name: 'a', candidates: [{ provider: ' ', model: 'm' }] }] }, /缺 provider 或 model/],
    [{ chains: [{ name: 'a', candidates: [{ provider: 'p', model: 'm' }] }], name: 1 }, /name 必须是字符串/],
  ];
  for (const [body, pattern] of cases) {
    const result = parseChainsPayload(body, normalizeChains);
    assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(body)}`);
    assert.match(result.error, pattern);
  }
});

test('parseChainsPayload 对「会被静默合并/丢弃」的提交报错，而不是悄悄接受', () => {
  // 相邻同名候选会被 normalizeCandidate 合并 —— 用户看着是两个，存下去是一个。
  const duplicated = [{
    name: 'a',
    candidates: [
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  }];
  const result = parseChainsPayload({ chains: duplicated }, normalizeChains);
  assert.equal(result.ok, false);
  assert.match(result.error, /合并或丢弃/);
});

test('MAX_BODY_BYTES 是个明确的上限（不设上限等于让调用方无限缓冲）', () => {
  assert.equal(Number.isSafeInteger(MAX_BODY_BYTES), true);
  assert.equal(MAX_BODY_BYTES > 0, true);
  assert.equal(MAX_BODY_BYTES <= 1024 * 1024, true);
});
