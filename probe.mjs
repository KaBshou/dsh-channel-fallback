// 虚拟 provider 编排的真跑验证（node probe.mjs）。
//
// v0.5.0 起插件不再拦 `llm/stream`，而是注册一个虚拟 provider
// （`dsh-channel-chain`），每条链是它下面的一个 model。所以这里要复刻的是
// **宿主的 adapter 注册表**，不是 waterfall：
//
//   · `ctx.llm.registerAdapter([id], adapter)` → 收下 adapter，返回 disposer
//     （带 `.replace()`，宿主用它重播 `llm/adapters-updated`）。
//   · `ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()` —— 就是
//     宿主模型选择器的数据源（`buildModelCatalog` 走这三个）。
//   · `ctx.llm.stream(options)` —— 请求打进来时，按 `options.provider` 找到
//     adapter，`prepareCall()` → `stream()`，并把 adapter 抛的错转成
//     failure finish chunk（**宿主就是这么做，不 throw**）。
//
// 复刻的关键点（与宿主一致，别简化掉）：
//   · adapter 失败不 throw，而是产出 `{type:'finish', reason:{kind:'error'}}`。
//   · `prepareCall` 会先跑 `resolveModel`，模型元数据非法就抛（`INVALID_*`）。
//   · 真实渠道（workbuddy/buddy）由「别的 adapter」提供 —— 这里用一张
//     provider→行为 的表来模拟，顺带验证「链内调用真的走到了真实渠道」。

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// 探针必须用**自己的**状态文件：真实状态文件在 `~/.dsh/channel-fallback/chains.json`，
// 里面是用户正在用的链。不隔离的话 `apply()` 会读到它、把探针传的 `chains` 覆盖掉，
// 于是所有断言都在测「用户当前的链」而不是「本文件定义的链」。
// `stateFilePath()` 每次调用现读环境变量，所以在 import 之后设置也有效。
process.env.DSH_CHANNEL_FALLBACK_STATE = path.join(
  os.tmpdir(),
  `dsh-channel-fallback-probe-${process.pid}.json`,
);

import { apply } from './lib/index.js';
import { CHAIN_PROVIDER_ID } from './lib/provider.js';

/**
 * 复刻宿主的 LLM 运行时（只做本插件用到的那部分）。
 *
 * @param {Record<string, (options: object) => AsyncIterable<any>>} upstreams
 *   provider id → 该渠道的流行为（模拟真实渠道 adapter）。
 * @param {Record<string, Array<{id: string, name: string, reasoning?: object}>>} [catalogs]
 *   provider id → 该渠道的模型元数据（`resolveModelInfo` 用）。
 */
function makeHost(upstreams, catalogs = {}) {
  const adapters = new Map();
  const calls = [];
  const events = [];

  const llm = {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) {
          const error = new Error(`an adapter for provider "${provider}" is already registered`);
          error.code = 'DUPLICATE_ADAPTER';
          throw error;
        }
      }
      let disposed = false;
      for (const provider of providers) {
        adapters.set(provider, { provider, adapter, info: adapter.providerInfo(provider) });
      }
      events.push({ kind: 'registered', providers });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const provider of providers) adapters.delete(provider);
      };
      dispose.replace = (next) => {
        if (disposed) {
          const error = new Error('a disposed adapter registration cannot replace its routes');
          error.code = 'REGISTRATION_DISPOSED';
          throw error;
        }
        events.push({ kind: 'replaced', providers: next });
      };
      return dispose;
    },

    listProviders() {
      return [...adapters.values()].map((entry) => ({ ...entry.info }));
    },

    async listModels(provider) {
      const entry = adapters.get(provider);
      if (entry === undefined) throw new Error(`no adapter registered for provider "${provider}"`);
      return entry.adapter.listModels(provider);
    },

    async resolveModelInfo(provider, model) {
      const entry = adapters.get(provider);
      if (entry === undefined) throw new Error(`no adapter registered for provider "${provider}"`);
      return entry.adapter.resolveModel(provider, model);
    },

    async providerRetryPolicy(provider) {
      const entry = adapters.get(provider);
      return entry?.adapter.providerRetryPolicy(provider);
    },

    stream(options) {
      const provider = String(options.provider);
      calls.push(`${provider}/${options.model}`);

      // 虚拟 provider：走它的 prepareCall → stream。
      const entry = adapters.get(provider);
      if (entry !== undefined) {
        return (async function* run() {
          let iterator;
          try {
            const prepared = await entry.adapter.prepareCall(provider, options.model, options.signal);
            iterator = prepared.stream(options)[Symbol.asyncIterator]();
            for (;;) {
              const step = await iterator.next();
              if (step.done === true) return;
              yield step.value;
            }
          } catch (error) {
            // 宿主契约：adapter 失败不 throw，转成 failure finish chunk。
            yield failureFinish(error, options.signal);
          } finally {
            const close = iterator?.return;
            if (typeof close === 'function') {
              try {
                await close.call(iterator);
              } catch {
                /* 忽略 */
              }
            }
          }
        })();
      }

      // 真实渠道：直接给流，失败转成 failure finish chunk。
      const upstream = upstreams[provider];
      if (upstream === undefined) {
        return (async function* missing() {
          yield failureFinish(new Error(`no adapter registered for provider "${provider}"`), options.signal);
        })();
      }
      return (async function* runUpstream() {
        let iterator;
        try {
          iterator = upstream(options)[Symbol.asyncIterator]();
          for (;;) {
            const step = await iterator.next();
            if (step.done === true) return;
            yield step.value;
          }
        } catch (error) {
          yield failureFinish(error, options.signal);
        } finally {
          const close = iterator?.return;
          if (typeof close === 'function') {
            try {
              await close.call(iterator);
            } catch {
              /* 忽略 */
            }
          }
        }
      })();
    },

    /**
     * 宿主 `resolveCallWithInfo` 的档位校验部分 —— 链的 efforts 若不是并集，
     * 这里就会抛 `UNSUPPORTED_REASONING_EFFORT`，与真实宿主一致。
     */
    async resolveCallConfig(config) {
      const entry = adapters.get(config.provider);
      if (entry === undefined) throw new Error(`no adapter registered for provider "${config.provider}"`);
      const info = await entry.adapter.resolveModel(config.provider, config.model);
      const reasoning = info.reasoning;
      const requested = config.reasoningEffort;
      if (reasoning === undefined) {
        if (requested !== undefined) {
          const error = new Error(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`);
          error.code = 'UNSUPPORTED_REASONING_EFFORT';
          throw error;
        }
        return config;
      }
      const effective = requested ?? reasoning.defaultEffort;
      const ids = reasoning.efforts.map((effort) => effort.id);
      if (effective !== undefined && !ids.includes(effective)) {
        const error = new Error(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`);
        error.code = 'UNSUPPORTED_REASONING_EFFORT';
        throw error;
      }
      return config;
    },
  };

  /** `ctx.get(name)` —— 本插件用 `runtimeOf()` 取 llm。 */
  const ctx = {
    get(name) {
      return name === 'llm' ? llm : undefined;
    },
    llm,
  };

  return { ctx, llm, calls, events, adapters };
}

function failureFinish(error, signal) {
  const aborted = signal?.aborted === true;
  return {
    type: 'finish',
    reason: {
      kind: aborted ? 'aborted' : 'error',
      failure: {
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      },
    },
  };
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

/** 收一条流，返回 `{chunks, text, error}`。 */
async function collect(iterable) {
  const chunks = [];
  let error;
  try {
    for await (const chunk of iterable) chunks.push(chunk);
  } catch (caught) {
    error = caught;
  }
  const joined = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  return { chunks, text: joined, error };
}

/** 默认链配置：workbuddy → buddy。 */
const CHAINS = [
  {
    id: 'flash-free-first',
    name: 'flash-free-first',
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  },
];

/** 两个渠道的模型元数据（档位不同，用来验证并集）。 */
const CATALOGS = {
  workbuddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }],
  buddy: [{
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
  }],
};

let passed = 0;
let failedCount = 0;

/**
 * @param {string} label
 * @param {() => Promise<void>} body
 */
async function test(label, body) {
  try {
    await body();
    passed += 1;
    console.log(`✔ ${label}`);
  } catch (error) {
    failedCount += 1;
    console.log(`✘ ${label}`);
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
    if (error?.stack) console.log(error.stack.split('\n').slice(1, 4).join('\n'));
  }
}

/** 起一个装好插件的宿主。 */
async function setup(upstreams, { chains = CHAINS } = {}) {
  const host = makeHost(upstreams);
  // `resolveModelInfo` 走 catalog 表：真实渠道的元数据由上游 adapter 提供，
  // 这里用 `registerAdapter` 之外的方式注入（模拟 channel-pack 已注册的那些）。
  const realResolveModelInfo = host.llm.resolveModelInfo;
  host.llm.resolveModelInfo = async (provider, model) => {
    const entry = host.adapters.get(provider);
    if (entry !== undefined) return entry.adapter.resolveModel(provider, model);
    const found = (CATALOGS[provider] ?? []).find((item) => item.id === model);
    if (found === undefined) throw new Error(`unknown model ${provider}/${model}`);
    return { provider, id: model, ...found };
  };
  host.llm.resolveCallConfig = host.llm.resolveCallConfig.bind(host.llm);
  apply(host.ctx, { chains });
  return host;
}

/** 走虚拟 provider 发一次请求，把结果收回来。 */
async function ask(host, { chainId = 'flash-free-first', signal, reasoningEffort } = {}) {
  return collect(host.llm.stream({
    provider: CHAIN_PROVIDER_ID,
    model: chainId,
    messages: [{ role: 'user', content: 'hi' }],
    ...(signal === undefined ? {} : { signal }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }));
}

// ── ① 链头成功：只请求一次，chunk 原样透传 ──────────────────────────────
await test('链头成功：只请求一次，正文原样透传', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('国际'), text('版'), stop]),
    buddy: () => streamOf([text('不该走到这里'), stop]),
  });
  const result = await ask(host);
  assert.equal(result.text, '国际版');
  assert.deepEqual(host.calls, ['dsh-channel-chain/flash-free-first', 'workbuddy/deepseek-v4.1-flash']);
});

// ── ② 链头失败：自动切备选，失败 chunk 不外泄 ──────────────────────────
await test('链头失败：自动切备选，失败的 finish 不外泄', async () => {
  const host = await setup({
    workbuddy: () => streamOf([failed('CREDITS_EXHAUSTED', 429)]),
    buddy: () => streamOf([text('国内版'), stop]),
  });
  const result = await ask(host);
  assert.equal(result.text, '国内版');
  assert.equal(result.chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  assert.equal(result.chunks.at(-1).reason.kind, 'stop');
  assert.deepEqual(host.calls, [
    'dsh-channel-chain/flash-free-first',
    'workbuddy/deepseek-v4.1-flash',
    'buddy/deepseek-v4.1-flash',
  ]);
});

// ── ③ 思考阶段失败：整段丢弃思考，切备选 ──────────────────────────────
await test('思考阶段失败：丢弃思考内容并切备选', async () => {
  const host = await setup({
    workbuddy: () => streamOf([think('我先想想'), failed('QUOTA_EXCEEDED', 429)]),
    buddy: () => streamOf([text('好'), stop]),
  });
  const result = await ask(host);
  assert.equal(result.text, '好');
  assert.equal(result.chunks.filter((chunk) => chunk.type === 'reasoning-delta').length, 0);
});

// ── ④ 已开始回答后出错：不切换，失败如实传给调用方 ────────────────────
await test('已提交后出错：不切换，失败如实透传', async () => {
  const host = await setup({
    workbuddy: () => throwingStream([text('说到一半')], new Error('网络断了')),
    buddy: () => streamOf([text('不该走到这里'), stop]),
  });
  const result = await ask(host);
  assert.equal(result.text, '说到一半');
  // 宿主把 adapter 抛的错转成 failure finish chunk（不 throw），插件在提交后
  // 原样把它交出去 —— 调用方看到的是「答了一半 + 明确失败」，不是静默截断。
  const finish = result.chunks.at(-1);
  assert.equal(finish.type, 'finish');
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.message, '网络断了');
  assert.equal(host.calls.includes('buddy/deepseek-v4.1-flash'), false);
});

// ── ⑤ 全部候选都失败：产出最后一个失败 finish，不 throw ───────────────
await test('全部失败：产出失败 finish，不抛错', async () => {
  const host = await setup({
    workbuddy: () => streamOf([failed('QUOTA_EXCEEDED', 429)]),
    buddy: () => streamOf([failed('SERVER_BUSY', 503)]),
  });
  const result = await ask(host);
  assert.equal(result.error, undefined);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].reason.kind, 'error');
  assert.equal(result.chunks[0].reason.failure.code, 'SERVER_BUSY');
});

// ── ⑥ 调用方取消：不切换 ──────────────────────────────────────────────
await test('调用方取消：不切备选', async () => {
  const controller = new AbortController();
  const host = await setup({
    workbuddy: () => streamOf([aborted]),
    buddy: () => streamOf([text('不该走到这里'), stop]),
  });
  const result = await ask(host, { signal: controller.signal });
  assert.equal(result.chunks.at(-1).reason.kind, 'aborted');
  assert.equal(host.calls.includes('buddy/deepseek-v4.1-flash'), false);
});

// ── ⑦ 空流视为失败并切备选 ────────────────────────────────────────────
await test('空流：视为失败并切备选', async () => {
  const host = await setup({
    workbuddy: () => streamOf([usage, stop]),
    buddy: () => streamOf([text('好'), stop]),
  });
  const result = await ask(host);
  assert.equal(result.text, '好');
});

// ── ⑧ 真实渠道的请求不会被插件接管（无监听器，天然成立）───────────────
await test('真实渠道请求不受影响', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('直连'), stop]),
    buddy: () => streamOf([text('直连'), stop]),
  });
  const result = await collect(host.llm.stream({
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
  }));
  assert.equal(result.text, '直连');
  assert.deepEqual(host.calls, ['workbuddy/deepseek-v4.1-flash']);
});

// ── ⑨ 选择器数据源：listModels 每条链一个 model ───────────────────────
await test('模型选择器：每条链是一个可选 model', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('x'), stop]),
    buddy: () => streamOf([text('x'), stop]),
  });
  const providers = host.llm.listProviders();
  assert.deepEqual(providers, [{ id: 'dsh-channel-chain', name: '渠道链' }]);
  const models = await host.llm.listModels('dsh-channel-chain');
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'flash-free-first');
  assert.equal(models[0].provider, 'dsh-channel-chain');
  assert.ok(models[0].name.includes('flash-free-first'));
});

// ── ⑩ 档位是链上各站的并集（否则选择器里选 max 会被宿主拒）───────────
await test('档位并集：workbuddy(high) + buddy(low/high/max) → 三档全在', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('x'), stop]),
    buddy: () => streamOf([text('x'), stop]),
  });
  const info = await host.llm.resolveModelInfo(CHAIN_PROVIDER_ID, 'flash-free-first');
  const ids = info.reasoning.efforts.map((effort) => effort.id).sort();
  assert.deepEqual(ids, ['high', 'low', 'max']);
});

// ── ⑪ 链级档位真的透传到上游 ──────────────────────────────────────────
await test('链级档位透传到上游请求', async () => {
  const seen = [];
  const host = await setup({
    workbuddy: (options) => {
      seen.push(options.reasoningEffort);
      return streamOf([text('x'), stop]);
    },
    buddy: () => streamOf([text('x'), stop]),
  }, {
    chains: [{
      id: 'low-first',
      name: 'low-first',
      reasoningEffort: 'low',
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
        { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      ],
    }],
  });
  await ask(host, { chainId: 'low-first' });
  // workbuddy 只有 high，链级 low 在它这儿不支持 → 降级到删掉档位（用上游默认）。
  assert.deepEqual(seen, [undefined]);
});

// ── ⑫ 候选固定档位优先于链级 ──────────────────────────────────────────
await test('候选固定档位优先于链级', async () => {
  const seen = [];
  const host = await setup({
    workbuddy: (options) => {
      seen.push(options.reasoningEffort);
      return streamOf([text('x'), stop]);
    },
    buddy: () => streamOf([text('x'), stop]),
  }, {
    chains: [{
      id: 'mixed',
      name: 'mixed',
      reasoningEffort: 'low',
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
        { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      ],
    }],
  });
  await ask(host, { chainId: 'mixed' });
  assert.deepEqual(seen, ['high']);
});

// ── ⑬ 候选不支持时降级而不是整条链报废 ────────────────────────────────
await test('候选档位不支持时降级到支持的档位', async () => {
  const seen = [];
  const host = await setup({
    workbuddy: (options) => {
      seen.push(options.reasoningEffort);
      return streamOf([text('x'), stop]);
    },
    buddy: () => streamOf([text('x'), stop]),
  }, {
    chains: [{
      id: 'bad-effort',
      name: 'bad-effort',
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
        { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      ],
    }],
  });
  const result = await ask(host, { chainId: 'bad-effort' });
  // workbuddy 不支持 max → 降级（删掉档位让它用默认）；仍然成功。
  assert.equal(result.text, 'x');
  assert.equal(seen.length, 1);
});

// ── ⑭ 选中的链被删掉：如实报错 ────────────────────────────────────────
await test('链被删掉：产出失败 finish 而不是静默回退', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('x'), stop]),
    buddy: () => streamOf([text('x'), stop]),
  });
  // 走真实渠道的 stream 路径：链 id 不存在时 `resolveModel` 会抛
  // `NO_SUCH_CHAIN`，宿主把它转成 failure finish。
  const result = await collect(host.llm.stream({
    provider: CHAIN_PROVIDER_ID,
    model: 'no-such-chain',
    messages: [{ role: 'user', content: 'hi' }],
  }));
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].reason.kind, 'error');
  assert.equal(result.chunks[0].reason.failure.code, 'NO_SUCH_CHAIN');
});

// ── ⑮ 空链：注册成功但选择器里不出现（整组被过滤）──────────────────────
await test('没有链时：注册成功、listModels 为空', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('x'), stop]),
    buddy: () => streamOf([text('x'), stop]),
  }, { chains: [] });
  const models = await host.llm.listModels(CHAIN_PROVIDER_ID);
  assert.deepEqual(models, []);
});

// ── ⑯ 重复注册：沿用既有路由，不抛 ────────────────────────────────────
await test('重复 apply：DUPLICATE_ADAPTER 被吞掉，不抛', async () => {
  const host = await setup({
    workbuddy: () => streamOf([text('x'), stop]),
    buddy: () => streamOf([text('x'), stop]),
  });
  apply(host.ctx, { chains: CHAINS });
  const models = await host.llm.listModels(CHAIN_PROVIDER_ID);
  assert.equal(models.length, 1);
});

// ── ⑰ 消费方提前 break：上游迭代器必须被关掉 ──────────────────────────
await test('消费方提前 break：上游迭代器被关闭', async () => {
  let closed = 0;
  const host = await setup({
    workbuddy: () => (async function* slow() {
      try {
        yield text('第一段');
        yield text('第二段');
        yield text('第三段');
        yield stop;
      } finally {
        closed += 1;
      }
    })(),
    buddy: () => streamOf([text('x'), stop]),
  });
  const iterator = host.llm.stream({
    provider: CHAIN_PROVIDER_ID,
    model: 'flash-free-first',
    messages: [{ role: 'user', content: 'hi' }],
  })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.type, 'text-delta');
  await iterator.return();
  assert.equal(closed, 1, `上游迭代器应被关闭一次，实际 ${closed}`);
});

// ── ⑱ 上下文窗口取各站最小值 ──────────────────────────────────────────
await test('上下文窗口：取链上各站最小值', async () => {
  const host = makeHost({
    workbuddy: () => streamOf([text('x'), stop]),
    buddy: () => streamOf([text('x'), stop]),
  });
  // 直接给两个渠道不同窗口，验证 merge 取 min。
  host.llm.resolveModelInfo = async (provider, model) => {
    const entry = host.adapters.get(provider);
    if (entry !== undefined) return entry.adapter.resolveModel(provider, model);
    const window = provider === 'workbuddy' ? 1_000_000 : 200_000;
    return { provider, id: model, name: model, context: { contextWindow: window } };
  };
  apply(host.ctx, { chains: CHAINS });
  const info = await host.llm.resolveModelInfo(CHAIN_PROVIDER_ID, 'flash-free-first');
  assert.equal(info.context.contextWindow, 200_000);
});

// ── ⑲ 切换前测速：按实测速度重排剩下的候选 ────────────────────────────
await test('切换前测速：按实测速度决定下一个试谁', async () => {
  // 链头 workbuddy 秒失败；剩下 buddy（慢，60ms）与 trae（快，5ms）。
  // 没开 speedProbe 时按原顺序试 buddy；开了就该先试 trae。
  const threeChains = [{
    id: 'three',
    name: 'three',
    speedProbe: true,
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      { provider: 'trae', model: 'deepseek-v4.1-flash' },
    ],
  }];
  const asked = [];
  const host = await setup({
    workbuddy: () => streamOf([failed('QUOTA_EXCEEDED')]),
    buddy: () => {
      asked.push('buddy');
      return (async function* slow() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield text('慢的那家');
        yield stop;
      })();
    },
    trae: () => {
      asked.push('trae');
      return streamOf([text('快的那家'), stop]);
    },
  }, { chains: threeChains });

  const result = await ask(host, { chainId: 'three' });
  assert.equal(result.text, '快的那家', '应该用测速后最快的那家回答');
  // 探测阶段两家都被试过一次，之后正式请求打给 trae。
  assert.ok(asked.includes('trae'), '快的那家应被选中');
});

// ── ⑳ 没开测速：老老实实按配置顺序走 ──────────────────────────────────
await test('没开 speedProbe：按配置顺序切，不探测', async () => {
  const threeChains = [{
    id: 'three',
    name: 'three',
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      { provider: 'trae', model: 'deepseek-v4.1-flash' },
    ],
  }];
  const host = await setup({
    workbuddy: () => streamOf([failed('QUOTA_EXCEEDED')]),
    buddy: () => streamOf([text('第二个'), stop]),
    trae: () => streamOf([text('第三个'), stop]),
  }, { chains: threeChains });

  const result = await ask(host, { chainId: 'three' });
  assert.equal(result.text, '第二个', '默认不探测，按原顺序');
});

// ── ㉑ 自动档：候选写 null 时上游请求里不带 reasoningEffort ─────────────
await test('自动档：候选写 null 时请求里没有 reasoningEffort', async () => {
  const seen = [];
  const chains = [{
    id: 'auto-chain',
    name: 'auto-chain',
    candidates: [
      { provider: 'buddy', model: 'deepseek-v4.1-flash', reasoningEffort: null },
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    ],
  }];
  const host = await setup({
    buddy: (options) => {
      seen.push(options.reasoningEffort);
      return streamOf([text('ok'), stop]);
    },
    workbuddy: () => streamOf([text('x'), stop]),
  }, { chains });
  await ask(host, { chainId: 'auto-chain', reasoningEffort: 'max' });
  assert.deepEqual(seen, [undefined], '自动档必须让上游用它自己的默认值');
});

console.log(`\n全部 ${passed} 项编排验证通过。${failedCount === 0 ? '' : ` ${failedCount} 项失败。`}`);
process.exit(failedCount === 0 ? 0 : 1);
