// 面板 API 与虚拟 provider 的真跑验证（node probe-panel.mjs）。
//
// 覆盖：provider 注册 + 链内编排 + 面板四条路由（/state、/chains、/models、
// /efforts、/test）+ 方法限制 + 信任栅栏 + 写盘/热生效 + 成环防护。
//
// 用假的 ctx / llm / webServer 复刻宿主语义，不碰真网络。
//
// **必须先把状态文件指到临时目录**：`apply()` 会读 `stateFilePath()`，不改的话
// 探针会读到甚至写进用户真实的 `~/.dsh/channel-fallback/chains.json`。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-probe-'));
const STATE_FILE = path.join(STATE_DIR, 'chains.json');
process.env.DSH_CHANNEL_FALLBACK_STATE = STATE_FILE;

const { apply, testInflight } = await import('./lib/index.js');
const { CHAIN_PROVIDER_ID } = await import('./lib/provider.js');

const text = (t) => ({ type: 'text-delta', index: 0, text: t });
const stop = { type: 'finish', reason: { kind: 'stop' } };
const failed = (code = 'QUOTA_EXCEEDED', status = 429) => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message: `失败 ${code}`, code, status } },
});

function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/**
 * 复刻宿主的 llm 服务。
 *
 * 关键语义（全部来自 `dsh-llm-runtime.js` / `dsh-llm/lib/index.js`）：
 *   · `registerAdapter(providers, adapter)` 注册虚拟 provider，返回带 `replace`
 *     的 disposer；provider 重名抛 `DUPLICATE_ADAPTER`。
 *   · `stream(options)` 先按 provider 找注册的 adapter —— 有就走它的
 *     `prepareCall` → `stream`；没有就交给「上游」假 adapter。
 *   · `listProviders()` / `listModels()` / `resolveModelInfo()` 都走注册表。
 *   · `resolveModelInfo` 的校验（id/name/contextWindow/reasoning）必须照抄，
 *     否则插件的 `resolveModel` 写错了也测不出来。
 *
 * @param {(options: object) => AsyncIterable<any>} upstream 真实渠道的假实现
 * @param {object} [options]
 */
function makeHost(upstream, options = {}) {
  const routes = [];
  const returnedEffects = [];
  const registered = new Map();
  const listCalls = [];
  const modelCalls = [];

  const catalog = options.catalog ?? {};
  const providers = catalog.providers ?? ['workbuddy', 'buddy'];
  const models = catalog.models ?? {
    workbuddy: ['deepseek-v4.1-flash', 'hy3', 'glm-5.3-flash'],
    buddy: ['deepseek-v4.1-flash', 'step-5-preview'],
  };
  const failing = new Set(catalog.failing ?? []);
  const efforts = catalog.efforts ?? {
    workbuddy: { 'deepseek-v4.1-flash': ['high'] },
    buddy: { 'deepseek-v4.1-flash': ['low', 'high', 'max'] },
  };
  const contextWindows = catalog.contextWindows ?? {
    'workbuddy/deepseek-v4.1-flash': 1_000_000,
    'buddy/deepseek-v4.1-flash': 1_000_000,
  };

  const runtime = {
    listProviders() {
      return [
        ...providers.map((id) => ({ id, name: `渠道 ${id}` })),
        ...[...registered.keys()].map((id) => registered.get(id).provider),
      ];
    },
    async listModels(provider) {
      listCalls.push(provider);
      const entry = registered.get(provider);
      if (entry !== undefined) return entry.adapter.listModels(provider);
      if (failing.has(provider)) throw new Error(`${provider} 上游 500`);
      return (models[provider] ?? []).map((id) => ({ provider, id, name: `模型 ${id}` }));
    },
    async resolveModelInfo(provider, model, signal) {
      modelCalls.push(`${provider}/${model}`);
      const entry = registered.get(provider);
      if (entry !== undefined) {
        const resolved = await entry.adapter.resolveModel(provider, model, signal);
        // 照抄宿主 `normalizeModelInfo` 的关键校验。
        assert.equal(resolved.provider, provider, 'resolveModel 必须回填 provider');
        assert.equal(resolved.id, model, 'resolveModel 必须回填 id');
        assert.ok(typeof resolved.name === 'string' && resolved.name.length > 0, 'name 不能为空');
        if (resolved.reasoning !== undefined) {
          assert.ok(resolved.reasoning.efforts.length > 0, 'efforts 不能是空数组');
          const ids = resolved.reasoning.efforts.map((e) => e.id);
          assert.equal(new Set(ids).size, ids.length, 'effort id 不能重复');
          for (const effort of resolved.reasoning.efforts) {
            assert.ok(typeof effort.id === 'string' && effort.id.length > 0);
            assert.ok(typeof effort.name === 'string' && effort.name.length > 0);
          }
          if (resolved.reasoning.defaultEffort !== undefined) {
            assert.ok(ids.includes(resolved.reasoning.defaultEffort), 'defaultEffort 必须在 efforts 里');
          }
        }
        return resolved;
      }
      if (failing.has(provider)) throw new Error(`${provider} 上游 500`);
      const list = efforts[provider]?.[model];
      const window = contextWindows[`${provider}/${model}`];
      return {
        provider,
        id: model,
        name: `模型 ${model}`,
        ...(window === undefined ? {} : { context: { contextWindow: window } }),
        ...(list === undefined ? {} : {
          reasoning: {
            efforts: list.map((id) => ({ id, name: id.toUpperCase() })),
            defaultEffort: list[0],
          },
        }),
      };
    },
    registerAdapter(ids, adapter) {
      for (const id of ids) {
        if (registered.has(id)) {
          const error = new Error(`an adapter for provider "${id}" is already registered`);
          error.code = 'DUPLICATE_ADAPTER';
          throw error;
        }
      }
      const info = adapter.providerInfo(ids[0]);
      assert.equal(info.id, ids[0]);
      assert.ok(typeof info.name === 'string' && info.name.length > 0);
      for (const id of ids) registered.set(id, { provider: info, adapter });
      const dispose = () => {
        for (const id of ids) registered.delete(id);
      };
      dispose.replace = (next) => {
        for (const id of ids) registered.delete(id);
        for (const id of next) registered.set(id, { provider: info, adapter });
      };
      return dispose;
    },
    providerRetryPolicy(provider) {
      const entry = registered.get(provider);
      return entry === undefined ? undefined : entry.adapter.providerRetryPolicy(provider);
    },
    async *stream(opts) {
      const entry = registered.get(opts.provider);
      if (entry === undefined) {
        yield* upstream(opts);
        return;
      }
      let iterator;
      try {
        const prepared = await entry.adapter.prepareCall(opts.provider, opts.model, opts.signal);
        iterator = prepared.stream(opts)[Symbol.asyncIterator]();
      } catch (error) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: error?.message ?? String(error), ...(error?.code === undefined ? {} : { code: error.code }) },
          },
        };
        return;
      }
      let completed = false;
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done === true) {
            completed = true;
            return;
          }
          yield step.value;
        }
      } finally {
        if (!completed) await iterator.return?.();
      }
    },
  };

  const ctx = {
    effect(fn, label) {
      returnedEffects.push(label);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(service) {
      if (service === 'llm') return options.noLlmService === true ? undefined : { llm: runtime };
      if (service === 'connection') return options.connection;
      return undefined;
    },
  };
  // 插件优先用 `ctx.get('llm')`，但真实宿主上 `ctx.llm` 也在 —— 两个都给。
  ctx.llm = options.noLlmService === true ? undefined : { llm: runtime, stream: (opts) => runtime.stream(opts) };

  if (options.withWebServer !== false) {
    const webServer = {
      register(route) {
        if (options.registerThrows === true) throw new Error('route conflict (test)');
        routes.push(route);
        return () => {};
      },
    };
    ctx.inject = (deps, cb) => {
      assert.deepEqual(deps, ['webServer']);
      cb({
        webServer,
        effect: ctx.effect,
        get: (service) => {
          if (service === 'connection') return options.connection;
          if (service === 'llm') return options.noLlmService === true ? undefined : { llm: runtime };
          return undefined;
        },
      });
      return () => {};
    };
  }

  return { ctx, routes, runtime, registered, listCalls, modelCalls, returnedEffects };
}

/** 同机浏览器的正常请求头。 */
const LOOPBACK_HEADERS = { host: '127.0.0.1:3080' };

/**
 * 直接调用已注册的路由 handler，收集响应。
 *
 * 默认带上环回 Host —— 面板 API 前面有信任栅栏（`lib/trust.js`），
 * 没有 Host 的请求会被当成非法请求拒掉，这不是 bug 而是设计。
 */
function callRoute(route, method = 'GET', headers = LOOPBACK_HEADERS, body) {
  return callPath(route, route.path, method, headers, body);
}

/** 同上，但可以指定子路径（`…/chains`、`…/models?provider=buddy`）。 */
function callPath(route, url, method = 'GET', headers = LOOPBACK_HEADERS, body) {
  return new Promise((resolve, reject) => {
    const captured = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headersOut) {
        captured.status = status;
        Object.assign(captured.headers, headersOut ?? {});
      },
      end(bodyOut) {
        captured.body = bodyOut ?? '';
        resolve(captured);
      },
      once() {},
      on() {},
      emit() {},
    };
    const chunks = body === undefined
      ? []
      : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
    const req = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
    try {
      route.handler(req, res);
    } catch (error) {
      reject(error);
    }
  });
}

const CONFIG = {
  chains: [{
    id: 'flash-free-first',
    name: 'flash-free-first',
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  }],
};

/** 走链的请求：provider 是虚拟 provider，model 是链 id。 */
const VIA_CHAIN = { provider: CHAIN_PROVIDER_ID, model: 'flash-free-first' };

/** 面板 API 前缀（和 `lib/index.js` 里的 `API_PREFIX` 一致）。 */
const API = '/api/channel-fallback';

/** 每个用例开始前把状态文件清干净，避免用例之间互相污染。 */
function clearState() {
  fs.rmSync(STATE_FILE, { force: true });
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✔ ${name}`);
}

// ── 1. 注册：装上插件后模型选择器里多一组「渠道链」 ────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);

  const infos = host.runtime.listProviders();
  assert.ok(infos.some((info) => info.id === CHAIN_PROVIDER_ID), '必须注册虚拟 provider');
  const listed = await host.runtime.listModels(CHAIN_PROVIDER_ID);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'flash-free-first', '链 id 就是选择器里的 model id');
  assert.match(listed[0].name, /flash-free-first/);
  assert.match(listed[0].description, /workbuddy\/deepseek-v4\.1-flash → buddy\/deepseek-v4\.1-flash/);
  ok('注册：模型选择器里多出一条「渠道链 · 链名」');
}

// ── 2. 不选链的请求完全不受影响（这是本次重构的核心承诺） ──────────────────
{
  clearState();
  const calls = [];
  const host = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return streamOf([text('直连'), stop]);
  });
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', messages: [] }));
  assert.deepEqual(out, [text('直连'), stop], '真实渠道请求必须原样透传');
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash'], '只发一次，不许被链接管');
  ok('不选链：真实渠道请求原样透传（装上插件不会偷偷接管）');
}

// ── 3. 选了链：按链上顺序走，链头失败自动切备选 ────────────────────────────
{
  clearState();
  const calls = [];
  const host = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop]);
  });
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.deepEqual(out, [text('好'), stop], '失败的 finish 不能外泄给调用方');
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  ok('选链：链头失败自动切备选，失败 chunk 不外泄');
}

// ── 4. 链头成功：只请求一次 ────────────────────────────────────────────────
{
  clearState();
  const calls = [];
  const host = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return streamOf([text('一次'), stop]);
  });
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.deepEqual(out, [text('一次'), stop]);
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash'], '链头成功就不能再打备选');
  ok('链头成功：只请求一次，chunk 原样透传');
}

// ── 5. 思考阶段失败：整段丢弃，用户无感 ────────────────────────────────────
{
  clearState();
  const host = makeHost((opts) => (
    opts.provider === 'workbuddy'
      ? streamOf([{ type: 'reasoning-delta', index: 0, text: '想一下' }, failed()])
      : streamOf([text('好'), stop])
  ));
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.deepEqual(out, [text('好'), stop], '思考内容属于被放弃的那一站，不能漏给用户');
  ok('思考阶段失败：丢弃思考内容并切备选');
}

// ── 6. 全部失败：如实报错，不假装成功 ──────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([failed('QUOTA', 429)]));
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'finish');
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(out[0].reason.failure.code, 'QUOTA');
  ok('全部失败：产出最后一个失败 finish，不抛错');
}

// ── 7. 调用方取消：不切备选 ────────────────────────────────────────────────
{
  clearState();
  const calls = [];
  const controller = new AbortController();
  const host = makeHost((opts) => {
    calls.push(opts.provider);
    controller.abort();
    return streamOf([{ type: 'finish', reason: { kind: 'aborted' } }]);
  });
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream({ ...VIA_CHAIN, signal: controller.signal }));
  assert.equal(calls.length, 1, '取消之后不该继续打备选');
  assert.equal(out.at(-1).reason.kind, 'aborted');
  ok('调用方取消：不切备选');
}

// ── 8. 空流：视为失败并切备选 ──────────────────────────────────────────────
{
  clearState();
  const calls = [];
  const host = makeHost((opts) => {
    calls.push(opts.provider);
    return opts.provider === 'workbuddy' ? streamOf([]) : streamOf([text('好'), stop]);
  });
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.deepEqual(out, [text('好'), stop]);
  assert.equal(calls.length, 2);
  ok('空流：视为失败并切备选');
}

// ── 9. 面板路由挂上了，且方法正确 ──────────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  assert.equal(host.routes.length, 1, '必须挂上一条 API 路由');
  assert.equal(host.routes[0].kind, 'prefix');
  assert.equal(host.routes[0].path, API);
  ok('面板装载：注册一条 prefix 路由');
}

// ── 10. 快照：链（带 id）、累计、事件、provider 列表 ───────────────────────
{
  clearState();
  const host = makeHost((opts) => (
    opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ));
  apply(host.ctx, CONFIG);
  await collect(host.runtime.stream(VIA_CHAIN));

  const response = await callRoute(host.routes[0]);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');

  const snapshot = JSON.parse(response.body);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.editable, true);
  assert.equal(snapshot.providerId, CHAIN_PROVIDER_ID, '面板要知道虚拟 provider 的 id');
  assert.equal(snapshot.chains.length, 1);
  assert.equal(snapshot.chains[0].id, 'flash-free-first', 'id 必须透出去（它就是选择器里的 model id）');
  assert.equal(snapshot.chains[0].name, 'flash-free-first');
  assert.deepEqual(snapshot.chains[0].candidates, [
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    { provider: 'buddy', model: 'deepseek-v4.1-flash' },
  ]);
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.switches, 1);
  assert.equal(snapshot.totals.wins, 1);
  assert.deepEqual(snapshot.events.map((e) => e.type), ['start', 'skip', 'win']);
  assert.deepEqual(snapshot.events[1].failure, {
    code: 'QUOTA_EXCEEDED',
    message: '失败 QUOTA_EXCEEDED',
    status: 429,
  });
  assert.equal(snapshot.events[2].candidate, 'buddy/deepseek-v4.1-flash');
  assert.equal(snapshot.events[2].attempts, 2);
  ok('快照：链（含 id）/ 计数 / 事件流都对');
}

// ── 11. 倍率：从渠道显示名里解析出来挂到候选上 ─────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]), {
    catalog: {
      providers: ['workbuddy', 'buddy'],
      models: { workbuddy: ['deepseek-v4.1-flash'], buddy: ['deepseek-v4.1-flash'] },
    },
  });
  // 让 listModels 返回带倍率的显示名（真实渠道就是这样拼的）。
  const original = host.runtime.listModels.bind(host.runtime);
  host.runtime.listModels = async (provider) => {
    const list = await original(provider);
    return list.map((model) => ({
      ...model,
      name: provider === 'workbuddy' ? 'Deepseek-V4.1-Flash · x0.00→免费' : 'Deepseek-V4.1-Flash · x0.11',
    }));
  };
  apply(host.ctx, CONFIG);
  // 先让目录进缓存（`ratesFor` 只读缓存，不打上游）。
  await host.runtime.listModels('workbuddy');
  await host.runtime.listModels('buddy');

  const snapshot = JSON.parse((await callRoute(host.routes[0])).body);
  const [first, second] = snapshot.chains[0].candidates;
  assert.equal(first.rate, 'x0.00→免费', '倍率要从显示名里解析出来');
  assert.equal(first.displayName, 'Deepseek-V4.1-Flash · x0.00→免费');
  assert.equal(second.rate, 'x0.11');
  ok('倍率：解析渠道显示名并挂到候选上');
}

// ── 11b. 链级开关与自动档：写进去、读回来、不丢字段 ────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);

  const saved = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{
      id: 'auto-probe',
      name: 'auto-probe',
      speedProbe: true,
      reasoningEffort: null,
      candidates: [
        { provider: 'buddy', model: 'deepseek-v4.1-flash', reasoningEffort: null },
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      ],
    }],
  });
  assert.equal(saved.status, 200);
  const chain = JSON.parse(saved.body).chains[0];
  assert.equal(chain.speedProbe, true, 'speedProbe 必须原样带回来');
  assert.equal(chain.reasoningEffort, null, '链级自动档（null）不能被吞成「没设置」');
  assert.equal(chain.candidates[0].reasoningEffort, null, '候选自动档同样要保住');

  // 落盘的 JSON 里也必须是这些值（否则重启后用户的设置就变了）。
  const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  assert.equal(onDisk.chains[0].speedProbe, true);
  assert.equal(onDisk.chains[0].reasoningEffort, null);
  assert.equal(onDisk.chains[0].candidates[0].reasoningEffort, null);
  ok('链级开关：speedProbe 与「自动」档位保存后原样读回（含落盘）');
}

// ── 11c. 写 "auto" 字符串与写 null 等价（面板两种写法都认）──────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const saved = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{
      id: 'auto-str',
      name: 'auto-str',
      reasoningEffort: 'auto',
      candidates: [
        { provider: 'buddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'auto' },
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      ],
    }],
  });
  assert.equal(saved.status, 200);
  const chain = JSON.parse(saved.body).chains[0];
  // 'auto' 不是任何 provider 的合法档位 id，必须归一化成 null 才不会被宿主拒。
  assert.equal(chain.reasoningEffort, null);
  assert.equal(chain.candidates[0].reasoningEffort, null);
  ok('自动档：写 "auto" 与写 null 归一化成同一个值');
}

// ── 12. /efforts：查某站真实支持的档位 ─────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);

  const good = await callPath(host.routes[0], `${API}/efforts?provider=buddy&model=deepseek-v4.1-flash`);
  assert.equal(good.status, 200);
  const payload = JSON.parse(good.body);
  assert.deepEqual(payload.efforts.map((e) => e.id), ['low', 'high', 'max']);
  assert.equal(payload.defaultEffort, 'low');

  const missing = await callPath(host.routes[0], `${API}/efforts?provider=workbuddy`);
  assert.equal(missing.status, 400, '缺参数必须 400');
  assert.match(JSON.parse(missing.body).error, /provider 与 model/);

  const self = await callPath(host.routes[0], `${API}/efforts?provider=${CHAIN_PROVIDER_ID}&model=x`);
  assert.equal(self.status, 400, '渠道链自己不能当候选');
  assert.match(JSON.parse(self.body).error, /不能嵌套/);

  const unknown = await callPath(host.routes[0], `${API}/efforts?provider=buddy&model=no-such`);
  assert.equal(unknown.status, 200, '查不到也是 200，error 才是结论');
  assert.equal(JSON.parse(unknown.body).efforts.length, 0);
  ok('/efforts：返回真实档位；缺参数 400、虚拟 provider 400、查不到 200+空');
}

// ── 13. /models：剔除虚拟 provider 自己（防成环） ──────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const payload = JSON.parse((await callPath(host.routes[0], `${API}/models`)).body);
  assert.deepEqual(payload.providers, ['workbuddy', 'buddy'], '虚拟 provider 不能出现在候选来源里');
  assert.equal(payload.models.length, 5);
  ok('/models：剔除虚拟 provider，防成环');
}

// ── 14. 保存链：写盘 + 立刻生效（选择器目录同步刷新） ──────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('好'), stop]));
  apply(host.ctx, CONFIG);

  const saved = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ id: 'only-buddy', name: 'only-buddy', candidates: [{ provider: 'buddy', model: 'deepseek-v4.1-flash' }] }],
  });
  assert.equal(saved.status, 200);
  const snapshot = JSON.parse(saved.body);
  assert.equal(snapshot.source, 'file');
  assert.equal(snapshot.revision, 1);
  assert.match(snapshot.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snapshot.chains[0].id, 'only-buddy');
  assert.deepEqual(snapshot.chains[0].candidates, [{ provider: 'buddy', model: 'deepseek-v4.1-flash' }]);

  // 真的写盘了（面板显示已保存但重启后没了 = 最糟的体验）。
  const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  assert.equal(onDisk.chains[0].name, 'only-buddy');

  // 选择器目录立刻变：旧链 id 消失、新链 id 出现。
  const listed = await host.runtime.listModels(CHAIN_PROVIDER_ID);
  assert.deepEqual(listed.map((model) => model.id), ['only-buddy']);
  ok('保存链：写盘 + 选择器目录立刻刷新');
}

// ── 15. 成环防护：候选不能是虚拟 provider 自己 ─────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const response = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{
      name: 'loop',
      candidates: [
        { provider: CHAIN_PROVIDER_ID, model: 'flash-free-first' },
        { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      ],
    }],
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.body).error, /成环/);
  assert.equal(fs.existsSync(STATE_FILE), false, '被拒绝的提交不能落盘');
  ok('成环防护：候选是「渠道链」自己 → 400');
}

// ── 16. 非法提交：400，内存与磁盘都不动 ───────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const pick = (body) => {
    const snapshot = JSON.parse(body);
    return { chains: snapshot.chains, revision: snapshot.revision, source: snapshot.source };
  };
  const before = pick((await callRoute(host.routes[0])).body);

  const bad = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ name: 'x', candidates: [{ provider: 'buddy' }] }],
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /缺 provider 或 model/);

  const after = pick((await callRoute(host.routes[0])).body);
  assert.deepEqual(after, before, '被拒绝的提交不能产生任何副作用');
  assert.equal(fs.existsSync(STATE_FILE), false);
  ok('非法提交：400 + 内存与磁盘都不动');
}

// ── 17. 坏 JSON：400 ───────────────────────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const response = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, '{not json');
  assert.equal(response.status, 400);
  assert.match(response.body, /不是合法 JSON/);
  ok('坏 JSON：400，不静默成功');
}

// ── 18. 请求体超上限：413 ──────────────────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const huge = JSON.stringify({ chains: [], pad: 'x'.repeat(70 * 1024) });
  const response = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, huge);
  assert.equal(response.status, 413);
  ok('超大请求体：413');
}

// ── 19. 写盘失败：500，内存里的链保持原样 ─────────────────────────────────
{
  const previous = process.env.DSH_CHANNEL_FALLBACK_STATE;
  const blocker = path.join(STATE_DIR, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  process.env.DSH_CHANNEL_FALLBACK_STATE = path.join(blocker, 'chains.json');
  try {
    const host = makeHost((opts) => {
      assert.equal(opts.provider, 'workbuddy', '写盘失败后不该偷偷换掉链');
      return streamOf([text('好'), stop]);
    });
    apply(host.ctx, CONFIG);
    const response = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
      chains: [{ name: 'nope', candidates: [{ provider: 'buddy', model: 'm' }] }],
    });
    assert.equal(response.status, 500);
    assert.match(JSON.parse(response.body).error, /写入失败/);
    await collect(host.runtime.stream(VIA_CHAIN));
    ok('写盘失败：500 + 内存里的链保持原样');
  } finally {
    if (previous === undefined) delete process.env.DSH_CHANNEL_FALLBACK_STATE;
    else process.env.DSH_CHANNEL_FALLBACK_STATE = previous;
    fs.rmSync(blocker, { force: true });
  }
}

// ── 20. 恢复默认：删状态文件 + 链回到配置文件的样子 ───────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ name: 'temp', candidates: [{ provider: 'buddy', model: 'm' }] }],
  });
  assert.equal(fs.existsSync(STATE_FILE), true);

  const reset = await callPath(host.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, { reset: true });
  assert.equal(reset.status, 200);
  const snapshot = JSON.parse(reset.body);
  assert.equal(snapshot.source, 'config');
  assert.equal(snapshot.savedAt, undefined);
  assert.equal(snapshot.chains[0].name, 'flash-free-first');
  assert.equal(snapshot.revision, 2);
  assert.equal(fs.existsSync(STATE_FILE), false);
  ok('恢复默认：删状态文件 + 链回到配置文件的样子');
}

// ── 21. 重启后仍在：状态文件优先于配置文件 ────────────────────────────────
{
  clearState();
  const first = makeHost(() => streamOf([text('x'), stop]));
  apply(first.ctx, CONFIG);
  await callPath(first.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ id: 'persisted', name: 'persisted', candidates: [{ provider: 'trae', model: 'glm' }] }],
  });

  const second = makeHost(() => streamOf([text('x'), stop]));
  apply(second.ctx, CONFIG);
  const snapshot = JSON.parse((await callRoute(second.routes[0])).body);
  assert.equal(snapshot.source, 'file');
  assert.equal(snapshot.chains[0].name, 'persisted');
  assert.equal(snapshot.chains[0].id, 'persisted', 'id 必须持久化，否则选择器里记住的选择会失效');
  fs.rmSync(STATE_FILE, { force: true });
  ok('重启后仍在：状态文件覆盖配置文件（含链 id）');
}

// ── 22. 信任栅栏：没有 connection 时结构复刻版必须挡住跨站 ────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);

  assert.equal((await callRoute(host.routes[0])).status, 200, '环回同源请求必须放行');

  const rejected = [
    [{ host: 'evil.example.com' }, '非环回 Host'],
    [{ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, '跨站请求'],
    [{ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }, 'Origin 与 Host 不一致'],
    [{ host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' }, 'Origin 协议与 Host 不一致'],
    [{ host: '127.0.0.1:3080', referer: 'http://evil.example.com/page' }, 'Referer 与 Host 不一致'],
    [{ host: '127.0.0.1:3080', origin: 'null' }, 'Origin: null（沙箱 iframe）'],
    [{}, '缺 Host'],
  ];
  for (const [headers, why] of rejected) {
    assert.equal((await callRoute(host.routes[0], 'GET', headers)).status, 403, `${why} 必须 403`);
  }

  const allowed = [
    { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    { host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/settings' },
    { host: 'localhost:3080' },
    { host: '[::1]:3080' },
  ];
  for (const headers of allowed) {
    assert.equal((await callRoute(host.routes[0], 'GET', headers)).status, 200, `同源必须放行：${JSON.stringify(headers)}`);
  }
  ok('信任栅栏（无 connection）：坏 Host / 跨站 / Origin·Referer 不一致 403，同源放行');
}

// ── 23. 有 connection：用内核同一个准入决定 ───────────────────────────────
{
  const seen = [];
  const connection = {
    admit(req) {
      seen.push(req?.headers?.host);
      return req?.headers?.['x-test-admit'] === 'yes' ? { peer: 'p' } : { rejection: 401 };
    },
  };
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]), { connection });
  apply(host.ctx, CONFIG);

  const denied = await callRoute(host.routes[0], 'GET', { host: '127.0.0.1:3080' });
  assert.equal(denied.status, 401, 'connection.admit 的拒绝码必须原样透出');
  assert.equal(denied.body, 'rejected');

  const allowedOut = await callRoute(host.routes[0], 'GET', { host: '127.0.0.1:3080', 'x-test-admit': 'yes' });
  assert.equal(allowedOut.status, 200);
  assert.deepEqual(seen, ['127.0.0.1:3080', '127.0.0.1:3080'], '每个请求都要问一次 connection');
  ok('有 connection：用内核同一个准入决定，拒绝码原样透出');
}

// ── 24. connection 抛错：503 fail-closed ──────────────────────────────────
{
  const connection = {
    admit() {
      throw new Error('boom');
    },
  };
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]), { connection });
  apply(host.ctx, CONFIG);
  assert.equal((await callRoute(host.routes[0])).status, 503, '准入判断失败必须 fail-closed');
  ok('connection 抛错：503 fail-closed，绝不放行');
}

// ── 25. 旧拼写 requestRejection 也能用 ────────────────────────────────────
{
  const connection = { requestRejection: (req) => (req?.headers?.host === '127.0.0.1:3080' ? undefined : 403) };
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]), { connection });
  apply(host.ctx, CONFIG);
  assert.equal((await callRoute(host.routes[0])).status, 200);
  assert.equal((await callRoute(host.routes[0], 'GET', { host: 'evil.example.com' })).status, 403);
  ok('旧拼写 requestRejection：同样生效');
}

// ── 26. connection 晚发布：每次请求重新求值 ───────────────────────────────
{
  let published = false;
  const connection = { admit: () => ({ rejection: 403 }) };
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]), {
    get connection() {
      return published ? connection : undefined;
    },
  });
  apply(host.ctx, CONFIG);

  assert.equal((await callRoute(host.routes[0])).status, 200, '服务未发布时走结构栅栏');
  published = true;
  assert.equal((await callRoute(host.routes[0])).status, 403, '服务发布后必须立刻改用 connection');
  ok('connection 晚发布：thunk 每次重新求值，不缓存服务实例');
}

// ── 27. 没有 webServer：面板跳过，provider 照常注册 ───────────────────────
{
  clearState();
  const host = makeHost((opts) => (
    opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ), { withWebServer: false });
  apply(host.ctx, CONFIG);

  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.deepEqual(out, [text('好'), stop], '没有 webServer 时链必须照常工作');
  ok('没有 webServer：面板跳过，链照常（headless 不陪葬）');
}

// ── 28. 面板注册抛错：不影响链 ────────────────────────────────────────────
{
  clearState();
  const host = makeHost((opts) => (
    opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ), { registerThrows: true });
  assert.doesNotThrow(() => apply(host.ctx, CONFIG));
  const out = await collect(host.runtime.stream(VIA_CHAIN));
  assert.deepEqual(out, [text('好'), stop], '面板挂载失败不能连累链');
  ok('API 注册抛错：面板失效，链不受影响');
}

// ── 29. 重复 apply：DUPLICATE_ADAPTER 被吞掉，不抛 ────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  assert.doesNotThrow(() => apply(host.ctx, CONFIG), '重复装载不能让插件崩掉');
  ok('重复 apply：DUPLICATE_ADAPTER 被吞掉，不抛');
}

// ── 30. 没有链时：仍注册，但 listModels 为空（选择器里不出现空组） ────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, { chains: [] });
  const listed = await host.runtime.listModels(CHAIN_PROVIDER_ID);
  assert.deepEqual(listed, [], '没有链时 listModels 必须为空（宿主会滤掉空组）');
  ok('没有链：注册成功、listModels 为空');
}

// ── 31. 链级档位：并集透出、且真的传到上游 ────────────────────────────────
{
  clearState();
  const seen = [];
  const host = makeHost((opts) => {
    seen.push(opts.reasoningEffort);
    return streamOf([text('好'), stop]);
  });
  apply(host.ctx, {
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

  const info = await host.runtime.resolveModelInfo(CHAIN_PROVIDER_ID, 'low-first');
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ['high', 'low', 'max'], '并集：workbuddy(high) + buddy(low/high/max)');

  await collect(host.runtime.stream({ provider: CHAIN_PROVIDER_ID, model: 'low-first' }));
  // workbuddy 只有 high，链级 low 在它这儿不支持 → 降级到删掉档位（用上游默认）。
  assert.deepEqual(seen, [undefined]);
  ok('链级档位：并集透出；该站不支持时降级而不是整链报废');
}

// ── 32. 候选固定档位优先于链级 ────────────────────────────────────────────
{
  clearState();
  const seen = [];
  const host = makeHost((opts) => {
    seen.push(opts.reasoningEffort);
    return streamOf([text('好'), stop]);
  });
  apply(host.ctx, {
    chains: [{
      id: 'pinned',
      name: 'pinned',
      reasoningEffort: 'max',
      candidates: [
        { provider: 'buddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      ],
    }],
  });
  await collect(host.runtime.stream({ provider: CHAIN_PROVIDER_ID, model: 'pinned' }));
  assert.deepEqual(seen, ['low'], '候选写死的档位必须赢过链级');
  ok('候选固定档位优先于链级');
}

// ── 33. 链被删掉：如实报错，不静默回退 ────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);
  const out = await collect(host.runtime.stream({ provider: CHAIN_PROVIDER_ID, model: 'no-such-chain' }));
  assert.equal(out.length, 1);
  assert.equal(out[0].reason.kind, 'error');
  assert.equal(out[0].reason.failure.code, 'NO_SUCH_CHAIN');
  ok('链被删掉：产出失败 finish 而不是静默回退');
}

// ── 34. 上下文窗口：取链上各站最小值 ──────────────────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]), {
    catalog: {
      providers: ['workbuddy', 'buddy'],
      models: { workbuddy: ['deepseek-v4.1-flash'], buddy: ['deepseek-v4.1-flash'] },
      contextWindows: {
        'workbuddy/deepseek-v4.1-flash': 1_000_000,
        'buddy/deepseek-v4.1-flash': 200_000,
      },
    },
  });
  apply(host.ctx, CONFIG);
  const info = await host.runtime.resolveModelInfo(CHAIN_PROVIDER_ID, 'flash-free-first');
  assert.equal(info.context.contextWindow, 200_000, '必须取最小值，否则会在小窗口那站溢出');
  ok('上下文窗口：取链上各站最小值');
}

// ── 35. 连通测试：见到正文即成功 ──────────────────────────────────────────
{
  clearState();
  const calls = [];
  const host = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}|${opts.sessionId ?? ''}`);
    return streamOf([text('好'), stop]);
  });
  apply(host.ctx, CONFIG);
  const response = await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'buddy',
    model: 'glm-5.3-flash',
  });
  assert.equal(response.status, 200, '测试结果（无论通不通）都该是 200');
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, 'buddy');
  assert.equal(payload.model, 'glm-5.3-flash');
  assert.ok(payload.totalMs >= 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^buddy\/glm-5\.3-flash\|channel-fallback:test:/);
  ok('连通测试：见到正文即成功，返回 {ok, provider, model, totalMs}');
}

// ── 36. 连通测试：上游失败也 200，带 code/status ──────────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([failed('QUOTA', 429)]));
  apply(host.ctx, CONFIG);
  const payload = JSON.parse((await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
  })).body);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'QUOTA');
  assert.equal(payload.status, 429);
  ok('连通测试：上游失败 → 200 + {ok:false, code, status, error}');
}

// ── 37. 连通测试：只吐 finish 不吐正文 → NO_OUTPUT ───────────────────────
{
  clearState();
  const host = makeHost(() => streamOf([stop]));
  apply(host.ctx, CONFIG);
  const payload = JSON.parse((await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'buddy',
    model: 'm',
  })).body);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'NO_OUTPUT');
  ok('连通测试：只吐 finish 不吐正文 → {ok:false, code:NO_OUTPUT}');
}

// ── 38. 连通测试：参数错 400、并发 409、llm 缺失 503、方法 405 ────────────
{
  clearState();
  const host = makeHost(() => streamOf([text('好'), stop]));
  apply(host.ctx, CONFIG);

  const badBody = await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, { chainIndex: 99, candidateIndex: 0 });
  assert.equal(badBody.status, 400);
  assert.match(JSON.parse(badBody.body).error, /不存在/);

  const wrongType = await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, []);
  assert.equal(wrongType.status, 400);
  assert.match(JSON.parse(wrongType.body).error, /需要 provider \+ model/);

  testInflight.add('buddy/m');
  const busy = await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, { provider: 'buddy', model: 'm' });
  assert.equal(busy.status, 409);
  testInflight.delete('buddy/m');

  const noLlm = makeHost(() => streamOf([text('x'), stop]), { noLlmService: true });
  apply(noLlm.ctx, CONFIG);
  const unavail = await callPath(noLlm.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, { provider: 'buddy', model: 'm' });
  assert.equal(unavail.status, 503);

  const wrongMethod = await callPath(host.routes[0], `${API}/test`, 'GET');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  ok('连通测试：400 / 409 / 503 / 405 各就各位');
}

// ── 39. 方法限制：/models、/efforts 只收 GET·HEAD，/chains 只收 POST ──────
{
  clearState();
  const host = makeHost(() => streamOf([text('x'), stop]));
  apply(host.ctx, CONFIG);

  for (const sub of ['/models', '/efforts']) {
    // `/efforts` 需要 provider+model 两个参数（缺了是 400，见用例 38），
    // 这里测的是「方法放不放行」，所以带上合法参数。
    const query = sub === '/efforts' ? '?provider=buddy&model=m' : '';
    const head = await callPath(host.routes[0], `${API}${sub}${query}`, 'HEAD');
    assert.equal(head.status, 200, `${sub} HEAD 应当放行`);
    assert.equal(head.body, '', 'HEAD 不能回体');
    const post = await callPath(host.routes[0], `${API}${sub}${query}`, 'POST');
    assert.equal(post.status, 405, `${sub} POST 必须 405`);
    assert.equal(post.headers.allow, 'GET, HEAD');
  }

  const getChains = await callPath(host.routes[0], `${API}/chains`, 'GET');
  assert.equal(getChains.status, 405);
  assert.equal(getChains.headers.allow, 'POST');

  const postState = await callRoute(host.routes[0], 'POST');
  assert.equal(postState.status, 405);
  assert.equal(postState.headers.allow, 'GET, HEAD');
  ok('方法限制：/models·/efforts 只收 GET·HEAD，/chains 只收 POST');
}

// ── 40. 测试流量不进事件流、不计数 ────────────────────────────────────────
{
  clearState();
  const host = makeHost((opts) => (
    opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ));
  apply(host.ctx, CONFIG);

  await collect(host.runtime.stream(VIA_CHAIN));
  const before = JSON.parse((await callRoute(host.routes[0])).body);
  assert.deepEqual(before.events.map((e) => e.type), ['start', 'skip', 'win']);

  await callPath(host.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
  });
  const after = JSON.parse((await callRoute(host.routes[0])).body);
  assert.deepEqual(after.events.map((e) => e.type), ['start', 'skip', 'win'], '测试流量不能写进事件流');
  assert.equal(after.totals.requests, before.totals.requests, '计数只算真实请求');
  ok('连通测试：测试流量不写事件流、不计数');
}

console.log(`\n全部 ${passed} 项面板验证通过。`);
