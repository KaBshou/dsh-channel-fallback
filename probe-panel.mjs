// 面板 API 的真跑验证（node probe-panel.mjs）。
//
// 覆盖：路由照常 + 快照内容正确 + 方法限制 + webServer 缺失时不影响路由 +
// 快照失败不影响路由 + 保存链（写盘/校验/热生效）+ 列模型。用假的 ctx / llm /
// webServer 复刻宿主语义，不碰真网络。
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

const { apply } = await import('./lib/index.js');

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
 * 复刻宿主：llm/stream 瀑布 + webServer.register。
 *
 * @param {(options: object) => AsyncIterable<any>} adapter
 * @param {{withWebServer?: boolean, registerThrows?: boolean, connection?: object,
 *          catalog?: {providers?: string[], models?: Record<string, Array<string>>,
 *                     failing?: string[]}, noLlmService?: boolean}} [options]
 */
function makeHost(adapter, options = {}) {
  const listeners = [];
  const routes = [];
  const returnedEffects = [];

  const ctx = {
    on(name, listener) {
      assert.equal(name, 'llm/stream');
      listeners.push(listener);
      return () => {};
    },
    effect(fn, label) {
      returnedEffects.push(label);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };

  // 复刻 `LlmRuntime` 的目录 API：`listProviders()` 同步、`listModels(provider)` 异步。
  const catalog = options.catalog ?? {};
  const providers = catalog.providers ?? ['workbuddy', 'buddy'];
  const models = catalog.models ?? {
    workbuddy: ['deepseek-v4.1-flash', 'hy3', 'glm-5.3-flash'],
    buddy: ['deepseek-v4.1-flash', 'step-5-preview'],
  };
  const failing = new Set(catalog.failing ?? []);
  const listCalls = [];
  const llmService = {
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: `渠道 ${id}` })),
      async listModels(provider) {
        listCalls.push(provider);
        if (failing.has(provider)) throw new Error(`${provider} 上游 500`);
        return (models[provider] ?? []).map((id) => ({ provider, id, name: `模型 ${id}` }));
      },
    },
  };

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
        // 复刻 `ctx.get()` 的「机会式查询」语义：没注册就答 undefined。
        get: (service) => {
          if (service === 'connection') return options.connection;
          if (service === 'llm') return options.noLlmService === true ? undefined : llmService;
          return undefined;
        },
      });
      return () => {};
    };
  }

  const builtin = (opts) => adapter(opts);
  const dispatch = (index, opts) => {
    const listener = listeners[index];
    if (listener === undefined) return builtin(opts);
    return listener(opts, () => dispatch(index + 1, opts));
  };
  ctx.llm = { stream: (opts) => dispatch(0, opts) };
  // 复刻真宿主：`llm` 服务的 `stream` 走完整瀑布链（`dsh-llm-runtime.js:634`
  // `stream(options) → streamWithRegistration → ctx.waterfall`）。连通测试直调
  // `runtime.stream(...)`，所以假服务也必须有这个函数，而且要走监听器 ——
  // 不然「测试流量被 innerCall 标记透传」就无从验证。
  llmService.llm.stream = (opts) => dispatch(0, opts);

  return { ctx, routes, returnedEffects, listCalls };
}

/** 同机浏览器的正常请求头。 */
const LOOPBACK_HEADERS = { host: '127.0.0.1:3080' };

/**
 * 直接调用已注册的路由 handler，收集响应。
 *
 * 默认带上环回 Host —— 面板 API 前面有信任栅栏（`lib/trust.js`），
 * 没有 Host 的请求会被当成非法请求拒掉，这不是 bug 而是设计。
 *
 * 第四参数可以给一个字符串/对象当请求体：`handleSaveChains` 读 body 用的是
 * `for await (const chunk of req)`，所以假 req 必须可异步迭代（真 `IncomingMessage`
 * 本身就是可迭代的）。给字符串就按「原始字节」发出去，给对象就序列化。
 */
function callRoute(route, method = 'GET', headers = LOOPBACK_HEADERS, body) {
  return callPath(route, route.path, method, headers, body);
}

/**
 * 同上，但可以指定子路径（`…/chains`、`…/models?provider=buddy`）。
 *
 * @param {{path: string, handler: Function}} route
 * @param {string} url
 * @param {string} [method]
 * @param {Record<string, string>} [headers]
 * @param {any} [body]
 */
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
    name: 'flash-free-first',
    candidates: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
    ],
  }],
};

const HEAD = { provider: 'workbuddy', model: 'deepseek-v4.1-flash' };

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

// ── 1. 路由照常工作（面板没抢走 llm/stream） ────────────────────────────────
{
  clearState();
  const calls = [];
  clearState();
  const { ctx, routes } = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop]);
  });
  apply(ctx, CONFIG);

  const out = await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(out, [text('好'), stop]);
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);
  assert.equal(routes.length, 1, '必须挂上一条 API 路由');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/api/channel-fallback');
  ok('面板装载后路由照常：链头失败仍自动切备选');
}

// ── 2. 快照内容：链配置 + 累计计数 + 事件流 ────────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost((opts) => (
    opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ));
  apply(ctx, CONFIG);
  await collect(ctx.llm.stream(HEAD, { messages: [] }));

  const response = await callRoute(routes[0]);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');

  const snapshot = JSON.parse(response.body);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.chains.length, 1);
  assert.equal(snapshot.chains[0].name, 'flash-free-first');
  assert.deepEqual(snapshot.chains[0].candidates[0], {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  }, '候选的 reasoningEffort 要透出来，没有的字段不能凭空补');
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
  ok('快照：链配置 / 计数 / 事件流（含失败原因与 HTTP 状态）都对');
}

// ── 3. 不归本插件管的请求只计数，不进事件流 ────────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  await collect(ctx.llm.stream({ provider: 'deepseek', model: 'other' }, {}));

  const snapshot = JSON.parse((await callRoute(routes[0])).body);
  assert.equal(snapshot.totals.passthrough, 1);
  assert.deepEqual(snapshot.events, [], '非链头请求不该在事件流里刷屏');
  ok('非链头请求：只计数不记明细');
}

// ── 4. 方法限制：POST 回 405 ────────────────────────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  const response = await callRoute(routes[0], 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
  ok('只读约束：非 GET/HEAD 一律 405');
}

// ── 5. HEAD 有头无体 ────────────────────────────────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  const response = await callRoute(routes[0], 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.body, '');
  ok('HEAD：只回头不回体');
}

// ── 6. 没有 webServer 的环境（headless）：路由必须照常 ──────────────────────
{
  const calls = [];
  const { ctx } = makeHost((opts) => {
    calls.push(opts.provider);
    return opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop]);
  }, { withWebServer: false });
  apply(ctx, CONFIG);

  const out = await collect(ctx.llm.stream(HEAD, {}));
  assert.deepEqual(out, [text('好'), stop], '没有 webServer 时路由必须照常工作');
  assert.deepEqual(calls, ['workbuddy', 'buddy']);
  ok('没有 webServer：面板跳过，路由照常（headless 不陪葬）');
}

// ── 7. 路由注册抛错（路径冲突）：不能连累路由 ──────────────────────────────
{
  const { ctx } = makeHost((opts) => (
    opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop])
  ), { registerThrows: true });
  assert.doesNotThrow(() => apply(ctx, CONFIG));
  const out = await collect(ctx.llm.stream(HEAD, {}));
  assert.deepEqual(out, [text('好'), stop], '面板挂载失败不能连累路由');
  ok('API 注册抛错：面板失效，路由不受影响');
}

// ── 8. 事件数有界（默认 60 条，连续 80 次请求后不涨） ──────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  for (let i = 0; i < 80; i += 1) await collect(ctx.llm.stream(HEAD, {}));

  const snapshot = JSON.parse((await callRoute(routes[0])).body);
  assert.equal(snapshot.totals.requests, 80);
  assert.equal(snapshot.events.length, 60, '事件流必须有界，长跑不涨内存');
  assert.equal(snapshot.events.at(-1).type, 'win');
  ok('事件流有界：80 次请求后只留最近 60 条');
}

// ── 9. 信任栅栏：没有 connection 服务时，结构复刻版必须挡住跨站与坏 Host ──
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);

  // 正常环回请求照常放行。
  assert.equal((await callRoute(routes[0])).status, 200, '环回同源请求必须放行');

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
    assert.equal((await callRoute(routes[0], 'GET', headers)).status, 403, `${why} 必须 403`);
  }

  // 同源 Origin / Referer 照常放行。
  const allowed = [
    { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    { host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/settings' },
    { host: 'localhost:3080' },
    { host: '[::1]:3080' },
  ];
  for (const headers of allowed) {
    assert.equal((await callRoute(routes[0], 'GET', headers)).status, 200, `同源请求必须放行：${JSON.stringify(headers)}`);
  }
  ok('信任栅栏（无 connection）：坏 Host / 跨站 / Origin·Referer 不一致 403，同源放行');
}

// ── 10. 有 connection 服务时必须用它（内核同一个准入决定） ─────────────────
{
  const seen = [];
  const connection = {
    admit(req) {
      seen.push(req?.headers?.host);
      return req?.headers?.['x-test-admit'] === 'yes' ? { peer: 'p' } : { rejection: 401 };
    },
  };
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), { connection });
  apply(ctx, CONFIG);

  const denied = await callRoute(routes[0], 'GET', { host: '127.0.0.1:3080' });
  assert.equal(denied.status, 401, 'connection.admit 的拒绝码必须原样透出（不是 403）');
  assert.equal(denied.body, 'rejected');

  const allowedOut = await callRoute(routes[0], 'GET', {
    host: '127.0.0.1:3080',
    'x-test-admit': 'yes',
  });
  assert.equal(allowedOut.status, 200, 'connection 放行后必须正常返回快照');
  assert.deepEqual(seen, ['127.0.0.1:3080', '127.0.0.1:3080'], '每个请求都要问一次 connection');
  ok('有 connection：用内核同一个准入决定，拒绝码原样透出');
}

// ── 11. connection 服务自己抛错时必须拒绝（503），绝不能放行 ───────────────
{
  const connection = {
    admit() {
      throw new Error('boom');
    },
  };
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), { connection });
  apply(ctx, CONFIG);
  assert.equal((await callRoute(routes[0])).status, 503, '准入判断失败必须 fail-closed');
  ok('connection 抛错：503 fail-closed，绝不放行');
}

// ── 12. 旧拼写 requestRejection 也能用（dsh 0.1.7 之前的形态） ─────────────
{
  const connection = { requestRejection: (req) => (req?.headers?.host === '127.0.0.1:3080' ? undefined : 403) };
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), { connection });
  apply(ctx, CONFIG);
  assert.equal((await callRoute(routes[0])).status, 200);
  assert.equal((await callRoute(routes[0], 'GET', { host: 'evil.example.com' })).status, 403);
  ok('旧拼写 requestRejection：同样生效');
}

// ── 13. connection 晚于插件发布：每次请求重新求值（thunk 不能缓存） ────────
{
  // 服务发布后，admit 一律回 403 —— 结构栅栏对环回 Host 是放行的（200），
  // 所以「200 变 403」正好证明栅栏从结构版切换到了内核版。
  let published = false;
  const connection = { admit: () => ({ rejection: 403 }) };
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), {
    get connection() {
      return published ? connection : undefined;
    },
  });
  apply(ctx, CONFIG);

  // 服务还没起来：走结构栅栏（环回 Host 放行）。
  assert.equal((await callRoute(routes[0])).status, 200, '服务未发布时走结构栅栏');
  published = true;
  // 服务起来了：立刻改用 connection.admit（它拒绝 → 403）。
  assert.equal((await callRoute(routes[0])).status, 403, '服务发布后必须立刻改用 connection');
  ok('connection 晚发布：thunk 每次重新求值，不缓存服务实例');
}

// ── 14. 快照带上「可编辑」相关的全部字段 ───────────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  const snapshot = JSON.parse((await callRoute(routes[0])).body);
  assert.equal(snapshot.editable, true);
  assert.equal(snapshot.source, 'config', '没存过状态文件时必须说清「链来自配置文件」');
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.file, STATE_FILE);
  assert.equal(snapshot.savedAt, undefined, '没保存过就不该有 savedAt');
  assert.equal(snapshot.defaults.length, 1, '要带一份默认链，面板的「恢复默认」才知道回到哪');
  assert.deepEqual(snapshot.providers, [
    { provider: 'workbuddy', name: '渠道 workbuddy' },
    { provider: 'buddy', name: '渠道 buddy' },
  ]);
  ok('快照：editable / source / revision / file / defaults / providers 都在');
}

// ── 15. 保存链：写盘 + 立刻生效（下一个请求就走新链，不需要重启） ──────────
{
  const calls = [];
  clearState();
  const { ctx, routes } = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return streamOf([text('好'), stop]);
  });
  apply(ctx, CONFIG);

  const saved = await callPath(routes[0], `${API}${'/chains'}`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ name: 'only-buddy', candidates: [{ provider: 'buddy', model: 'deepseek-v4.1-flash' }] }],
  });
  assert.equal(saved.status, 200);
  const snapshot = JSON.parse(saved.body);
  assert.equal(snapshot.source, 'file');
  assert.equal(snapshot.revision, 1);
  assert.match(snapshot.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(snapshot.chains[0], {
    name: 'only-buddy',
    candidates: [{ provider: 'buddy', model: 'deepseek-v4.1-flash' }],
  });

  // 真的写盘了（面板显示已保存但重启后没了 = 最糟的体验）。
  const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  assert.equal(onDisk.chains[0].name, 'only-buddy');

  // 热生效：新链头是 buddy，所以 workbuddy 的请求不再被接管 → 透传。
  calls.length = 0;
  await collect(ctx.llm.stream(HEAD, {}));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash'], '旧链头不该再被当成起点');

  // buddy 的请求现在归新链管。
  calls.length = 0;
  await collect(ctx.llm.stream({ provider: 'buddy', model: 'deepseek-v4.1-flash' }, {}));
  assert.deepEqual(calls, ['buddy/deepseek-v4.1-flash']);
  ok('保存链：写盘 + 下一个请求立刻走新链（热生效，不用重启）');
}

// ── 16. 保存非法数据：400，且内存与磁盘都不动 ──────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  // 只比「链与版本」，不比整份快照：快照里带 `generatedAt`，每次读都不同。
  const pick = (body) => {
    const snapshot = JSON.parse(body);
    return { chains: snapshot.chains, revision: snapshot.revision, source: snapshot.source };
  };
  const before = pick((await callRoute(routes[0])).body);

  const bad = await callPath(routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ name: 'x', candidates: [{ provider: 'buddy' }] }],
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /缺 provider 或 model/);

  const after = pick((await callRoute(routes[0])).body);
  assert.deepEqual(after, before, '被拒绝的提交不能产生任何副作用');
  assert.equal(fs.existsSync(STATE_FILE), false, '被拒绝的提交不能落盘');
  ok('非法提交：400 + 内存与磁盘都不动');
}

// ── 17. 保存时发了非 JSON：400（不能静默 200） ─────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  const response = await callPath(routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, '{not json');
  assert.equal(response.status, 400);
  assert.match(response.body, /不是合法 JSON/);
  ok('坏 JSON：400，不静默成功');
}

// ── 18. 请求体超上限：413（不设上限等于让调用方无限缓冲） ──────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  const huge = JSON.stringify({ chains: [], pad: 'x'.repeat(70 * 1024) });
  const response = await callPath(routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, huge);
  assert.equal(response.status, 413);
  ok('超大请求体：413');
}

// ── 19. 写盘失败：500，且内存里的链保持原样（不能假装成功） ────────────────
{
  const previous = process.env.DSH_CHANNEL_FALLBACK_STATE;
  // 让父目录是个**文件**，mkdirSync 必然 ENOTDIR。
  const blocker = path.join(STATE_DIR, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  process.env.DSH_CHANNEL_FALLBACK_STATE = path.join(blocker, 'chains.json');
  try {
    clearState();
  const { ctx, routes } = makeHost((opts) => {
      assert.equal(opts.provider, 'workbuddy', '写盘失败后不该偷偷换掉链');
      return streamOf([text('好'), stop]);
    });
    apply(ctx, CONFIG);
    const response = await callPath(routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
      chains: [{ name: 'nope', candidates: [{ provider: 'buddy', model: 'm' }] }],
    });
    assert.equal(response.status, 500);
    assert.match(JSON.parse(response.body).error, /写入失败/);
    // 链没被换掉：仍然从 workbuddy 起跳。
    await collect(ctx.llm.stream(HEAD, {}));
    ok('写盘失败：500 + 内存里的链保持原样');
  } finally {
    if (previous === undefined) delete process.env.DSH_CHANNEL_FALLBACK_STATE;
    else process.env.DSH_CHANNEL_FALLBACK_STATE = previous;
    fs.rmSync(blocker, { force: true });
  }
}

// ── 20. 恢复默认：删掉状态文件，链回到配置文件的样子 ──────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);
  await callPath(routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ name: 'temp', candidates: [{ provider: 'buddy', model: 'm' }] }],
  });
  assert.equal(fs.existsSync(STATE_FILE), true);

  const reset = await callPath(routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, { reset: true });
  assert.equal(reset.status, 200);
  const snapshot = JSON.parse(reset.body);
  assert.equal(snapshot.source, 'config');
  assert.equal(snapshot.savedAt, undefined);
  assert.equal(snapshot.chains[0].name, 'flash-free-first', 'restore default 必须回到配置文件的链');
  assert.equal(snapshot.revision, 2);
  assert.equal(fs.existsSync(STATE_FILE), false, '恢复默认要真的删掉状态文件');
  ok('恢复默认：删状态文件 + 链回到配置文件的样子');
}

// ── 21. 重启后仍在：状态文件优先于配置文件 ────────────────────────────────
{
  const first = makeHost(() => streamOf([text('x'), stop]));
  apply(first.ctx, CONFIG);
  await callPath(first.routes[0], `${API}/chains`, 'POST', LOOPBACK_HEADERS, {
    chains: [{ name: 'persisted', candidates: [{ provider: 'trae', model: 'glm' }] }],
  });

  // 模拟重启：同一份配置，新的 apply。
  const second = makeHost(() => streamOf([text('x'), stop]));
  apply(second.ctx, CONFIG);
  const snapshot = JSON.parse((await callRoute(second.routes[0])).body);
  assert.equal(snapshot.source, 'file');
  assert.equal(snapshot.chains[0].name, 'persisted');
  assert.match(snapshot.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(STATE_FILE, { force: true });
  ok('重启后仍在：状态文件覆盖配置文件，并带上保存时间');
}

// ── 22. 列模型：正常返回，按 provider 分组 ────────────────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), {
    catalog: {
      providers: ['workbuddy', 'buddy'],
      models: {
        workbuddy: ['deepseek-v4.1-flash', 'hy3'],
        buddy: ['deepseek-v4.1-flash', 'step-5-preview'],
      },
    },
  });
  apply(ctx, CONFIG);
  const response = await callPath(routes[0], `${API}/models`);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.providers, ['workbuddy', 'buddy']);
  assert.deepEqual(payload.failed, []);
  assert.deepEqual(payload.models, [
    { provider: 'buddy', model: 'deepseek-v4.1-flash', name: '模型 deepseek-v4.1-flash' },
    { provider: 'buddy', model: 'step-5-preview', name: '模型 step-5-preview' },
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', name: '模型 deepseek-v4.1-flash' },
    { provider: 'workbuddy', model: 'hy3', name: '模型 hy3' },
  ]);
  ok('列模型：返回 {provider, model, name}，顺序稳定');
}

// ── 23. 列模型：单个 provider 挂了不影响其它（渠道离线很常见） ────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), {
    catalog: {
      providers: ['workbuddy', 'buddy', 'cline'],
      models: { workbuddy: ['a'], buddy: ['b'], cline: ['c'] },
      failing: ['buddy'],
    },
  });
  apply(ctx, CONFIG);
  const payload = JSON.parse((await callPath(routes[0], `${API}/models`)).body);
  assert.equal(payload.models.length, 2, '一个渠道挂了，其它渠道的模型照样该能加进链');
  assert.deepEqual(payload.failed, [{ provider: 'buddy', error: 'buddy 上游 500' }]);
  ok('列模型：单 provider 失败只记进 failed，不影响整体');
}

// ── 24. 列模型：?provider= 只问这一个（面板按需展开，不刷全量） ────────────
{
  const { ctx, routes, listCalls } = makeHost(() => streamOf([text('x'), stop]), {
    catalog: { providers: ['workbuddy', 'buddy'], models: { workbuddy: ['a'], buddy: ['b'] } },
  });
  apply(ctx, CONFIG);
  const payload = JSON.parse((await callPath(routes[0], `${API}/models?provider=buddy`)).body);
  assert.deepEqual(listCalls, ['buddy'], '必须只问指定的那个 provider');
  assert.deepEqual(payload.providers, ['buddy']);
  assert.deepEqual(payload.models.map((m) => m.model), ['b']);
  ok('列模型：?provider= 只查一个渠道');
}

// ── 25. 列模型：llm 服务拿不到时 503，不是 500 也不是空列表 ────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]), { noLlmService: true });
  apply(ctx, CONFIG);
  const response = await callPath(routes[0], `${API}/models`);
  assert.equal(response.status, 503);
  assert.match(JSON.parse(response.body).error, /llm 服务不可用/);
  ok('列模型：llm 服务缺失 → 503，且说明原因');
}

// ── 26. /models 只允许 GET/HEAD，/chains 只允许 POST ───────────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('x'), stop]));
  apply(ctx, CONFIG);

  const headModels = await callPath(routes[0], `${API}/models`, 'HEAD');
  assert.equal(headModels.status, 200);
  assert.equal(headModels.body, '', 'HEAD 不能回体');

  const postModels = await callPath(routes[0], `${API}/models`, 'POST');
  assert.equal(postModels.status, 405);
  assert.equal(postModels.headers.allow, 'GET, HEAD');

  const getChains = await callPath(routes[0], `${API}/chains`, 'GET');
  assert.equal(getChains.status, 405);
  assert.equal(getChains.headers.allow, 'POST');
  ok('方法限制：/models 只收 GET·HEAD，/chains 只收 POST');
}

// ── 27. 连通测试：真发一次极小请求，见到正文就算成功 ────────────────────────
{
  clearState();
  const calls = [];
  const { ctx, routes } = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}|${opts.sessionId ?? ''}`);
    return streamOf([text('好'), stop]);
  });
  apply(ctx, CONFIG);
  const response = await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'buddy',
    model: 'glm-5.3-flash',
  });
  assert.equal(response.status, 200, '测试结果（无论通不通）都该是 200，ok 才是结论');
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, 'buddy');
  assert.equal(payload.model, 'glm-5.3-flash');
  assert.equal(typeof payload.totalMs, 'number');
  assert.ok(payload.totalMs >= 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^buddy\/glm-5\.3-flash\|channel-fallback:test:/, '测试必须带标记 sessionId，让路由认识它');
  ok('连通测试：见到正文即成功，返回 {ok, provider, model, totalMs}');
}

// ── 28. 连通测试：上游失败也要 200，把 code/status 带回去 ──────────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([failed('QUOTA', 429)]));
  apply(ctx, CONFIG);
  const response = await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'QUOTA');
  assert.equal(payload.status, 429);
  assert.match(payload.error, /QUOTA/);
  ok('连通测试：上游失败 → 200 + {ok:false, code, status, error}');
}

// ── 29. 连通测试：流结束但没有正文 = 不可用（与路由的提交判据一致） ────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([stop]));
  apply(ctx, CONFIG);
  const payload = JSON.parse((await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'buddy',
    model: 'm',
  })).body);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'NO_OUTPUT');
  ok('连通测试：只吐 finish 不吐正文 → {ok:false, code:NO_OUTPUT}');
}

// ── 30. 连通测试：runtime.stream 直接抛错（没这个 provider 之类） ──────────
{
  clearState();
  const { ctx, routes } = makeHost(() => {
    throw Object.assign(new Error('no adapter for provider "ghost"'), { code: 'NO_ADAPTER' });
  });
  apply(ctx, CONFIG);
  const payload = JSON.parse((await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'ghost',
    model: 'm',
  })).body);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'NO_ADAPTER');
  assert.match(payload.error, /no adapter/);
  ok('连通测试：runtime.stream 抛错 → {ok:false, code, error}');
}

// ── 31. 连通测试：测链上的第几站（chainIndex + candidateIndex） ────────────
{
  clearState();
  const calls = [];
  const { ctx, routes } = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return streamOf([text('好'), stop]);
  });
  apply(ctx, CONFIG);
  const payload = JSON.parse((await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    chainIndex: 0,
    candidateIndex: 1,
  })).body);
  assert.equal(payload.ok, true);
  assert.deepEqual(calls, ['buddy/deepseek-v4.1-flash'], '按链定位要解到具体的 provider/model');
  ok('连通测试：chainIndex+candidateIndex 也能定位候选');
}

// ── 32. 连通测试：参数错 400、并发 409、llm 缺失 503、方法限制 ─────────────
{
  clearState();
  const { ctx, routes } = makeHost(() => streamOf([text('好'), stop]));
  apply(ctx, CONFIG);

  const badBody = await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, { chainIndex: 99, candidateIndex: 0 });
  assert.equal(badBody.status, 400);
  assert.match(JSON.parse(badBody.body).error, /不存在/);

  // 数组虽然是 object，但没有 provider/model 也没有链索引 —— 仍要 400。
  const wrongType = await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, []);
  assert.equal(wrongType.status, 400);
  assert.match(JSON.parse(wrongType.body).error, /需要 provider \+ model/);

  // 并发护栏：手动占住 inflight，再发一次必须 409。
  const { testInflight } = await import('./lib/index.js');
  testInflight.add('buddy/m');
  const busy = await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, { provider: 'buddy', model: 'm' });
  assert.equal(busy.status, 409);
  testInflight.delete('buddy/m');

  const noLlm = makeHost(() => streamOf([text('x'), stop]), { noLlmService: true });
  apply(noLlm.ctx, CONFIG);
  const unavail = await callPath(noLlm.routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, { provider: 'buddy', model: 'm' });
  assert.equal(unavail.status, 503);
  assert.match(JSON.parse(unavail.body).error, /测不了模型/);

  const wrongMethod = await callPath(routes[0], `${API}/test`, 'GET');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  ok('连通测试：400 / 409 / 503 / 405 各就各位');
}

// ── 33. 连通测试：测试流量不被路由接管、不计数 ─────────────────────────────
{
  clearState();
  const calls = [];
  const { ctx, routes } = makeHost((opts) => {
    calls.push(`${opts.provider}/${opts.model}`);
    return opts.provider === 'workbuddy' ? streamOf([failed()]) : streamOf([text('好'), stop]);
  });
  apply(ctx, CONFIG);

  // 先造一条「workbuddy 必挂、buddy 接管」的基线事件。
  await collect(ctx.llm.stream(HEAD, { messages: [] }));
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash', 'buddy/deepseek-v4.1-flash']);

  // 通过面板测试 workbuddy —— 它失败也必须只打一发，不触发链切换。
  calls.length = 0;
  const payload = JSON.parse((await callPath(routes[0], `${API}/test`, 'POST', LOOPBACK_HEADERS, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
  })).body);
  assert.equal(payload.ok, false);
  assert.deepEqual(calls, ['workbuddy/deepseek-v4.1-flash'], '测试失败不能触发路由切换');

  // 测试也不产生事件/计数 —— 基线那次真实请求留下 start+skip+win 三条事件，
  // 测试之后必须还是这 3 条；totals 也必须原封不动。
  const snapshot = JSON.parse((await callRoute(routes[0])).body);
  assert.deepEqual(snapshot.events.map((e) => e.type), ['start', 'skip', 'win'], '测试流量不能写进事件流');
  assert.equal(snapshot.totals.requests, 1, '计数只算真实路由请求');
  assert.equal(snapshot.totals.switches, 1, '测试失败不能算成一次切换');
  assert.equal(snapshot.totals.passthrough, 0, '测试流量也不能算成旁路');
  ok('连通测试：测试流量不被路由接管、不写事件流');
}

console.log(`\n全部 ${passed} 项面板验证通过。`);
