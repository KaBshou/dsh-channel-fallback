/**
 * probe-client.mjs —— 浏览器半边 `client.js` 的验证。
 *
 * 为什么要单独一个探针：
 *   `client.js` 是 classic script，靠宿主外壳注入 `require('react')` 和
 *   `window.__ModuleLoader__`。这两样在 Node 里都没有，所以要在本地验它的行为，
 *   就得自己搭一个够用的替身：一个 mini React（useState / useCallback /
 *   useEffect 的同步版）+ 一个假 ModuleLoader + 一个假 document。
 *
 * 它不追求与 React 语义完全一致，只够验证这些事：
 *   1. 文件**求值两次不报错**（顶层不能让出 `let/const/class`）；
 *   2. 注册 id / name / inject 对得上，`apply` 会把 `settings.section` 挂上；
 *      **注册 id 必须等于 package.json 的 `name`** —— 宿主拿它当 boot graph 的
 *      entry id，写短名会「loaded without registering」。
 *   3. 把 `GET /api/channel-fallback/state` 的几种典型返回渲成文本，
 *      该有的字都在（链、计数、事件、失败原因、HTTP 状态）；
 *   4. 数据没来时显示提示而不是白屏；
 *   5. 缺 `slots` 服务时不抛错（页面没了，但客户端别跟着炸）。
 *
 * 以退出码 0/1 判定（不是 node --test，因为要跑 DOM 替身）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(here, 'client.js'), 'utf8')
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// mini React
// ---------------------------------------------------------------------------
function createMiniReact() {
  let slots = []
  let cursor = 0
  let pendingEffects = []
  let dirty = false
  // 挂在实例上而不是每次 mount 的局部变量：`mount` 被反复调用来模拟「重渲」，
  // 若每次重跑 effect，`useEffect(…, [])` 里的 `load()` 会把用户的编辑冲掉 ——
  // 那是替身的 bug，不是组件的 bug。
  let effectsRan = false

  const reset = () => {
    cursor = 0
    pendingEffects = []
  }

  function useState(initial) {
    const index = cursor++
    if (slots[index] === undefined) slots[index] = { value: initial }
    const box = slots[index]
    const setValue = (next) => {
      const resolved = typeof next === 'function' ? next(box.value) : next
      if (resolved === box.value) return
      box.value = resolved
      dirty = true
    }
    return [box.value, setValue]
  }

  function useCallback(fn) {
    const index = cursor++
    if (slots[index] === undefined) slots[index] = { value: fn }
    return slots[index].value
  }

  function useEffect(fn) {
    cursor += 1
    pendingEffects.push(fn)
  }

  function createElement(type, props, ...children) {
    const flat = children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false)
    return { type, props: { ...(props ?? {}), children: flat } }
  }

  const api = { createElement, useState, useCallback, useEffect }

  return {
    api,
    reset,
    takeEffects: () => {
      const taken = pendingEffects
      pendingEffects = []
      return taken
    },
    isDirty: () => dirty,
    clearDirty: () => {
      dirty = false
    },
    /**
     * 挂载并渲染到稳定态。
     *
     * 与真 React 的差别：
     *   - **函数组件会被递归展开**（`<Shell/>` 返回 `<Page/>` 这种嵌套也要跑，
     *     否则里层 hook 不注册、effect 根本不跑）；
     *   - effect 只跑第一轮（对应 `useEffect(fn, [])` 的日常用法）；
     *   - 异步 effect（fetch）要等 promise 链落地，所以每轮最多等 10 个宏任务。
     */
    async mount(Component, maxRounds = 10) {
      let tree
      for (let round = 0; round < maxRounds; round += 1) {
        reset()
        tree = expand({ type: Component, props: { children: [] } })
        const effects = this.takeEffects()
        if (!effectsRan) {
          effectsRan = true
          for (const effect of effects) effect()
        }
        for (let tick = 0; tick < 10 && !this.isDirty(); tick += 1) await flush()
        if (!this.isDirty()) return tree
        this.clearDirty()
      }
      return tree
    },
  }
}

/**
 * 在渲染树里找按钮（模拟用户操作）。
 *
 * 找法：文本节点完全相等的 `button`。`index` 用来在有多个同名按钮时挑第几个
 * （链里每个候选都有一个「删除」）。找不到就抛 —— 静默跳过会让「点了没反应」
 * 这类 bug 一路绿灯通过。
 */
function findButton(node, label, index = 0) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    const children = current.props?.children ?? []
    if (current.type === 'button' && children.length === 1 && children[0] === label) found.push(current)
    walk(children)
  }
  walk(node)
  return found[index]
}

/** 点击：调用 onClick，并断言它没被 disabled（disabled 还点得动就是 bug）。 */
function clickButton(tree, label, index = 0) {
  const button = findButton(tree, label, index)
  assert.notEqual(button, undefined, `渲染树里找不到按钮「${label}」(index ${index})`)
  assert.notEqual(button.props.disabled, true, `按钮「${label}」不该是 disabled`)
  button.props.onClick()
}

/** 按钮数量（用来断言「加了一个」「删掉一个」）。 */
function countButtons(node, label) {
  let total = 0
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    const children = current.props?.children ?? []
    if (current.type === 'button' && children.length === 1 && children[0] === label) total += 1
    walk(children)
  }
  walk(node)
  return total
}

/** 把渲染树摊成纯文本（便于断言某段话出现没出现）。 */
const flatten = (tree) => render(tree).replace(/\s+/g, ' ')

/** 等一轮宏任务，让 fetch 的 promise 链跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 递归展开函数组件 —— 包括**普通元素里的子组件**。
 *
 * 真 React 会为每个函数组件开一个 hook 作用域；这里的 mini 版没有作用域概念，
 * 靠「深度优先、逐层调用」模拟：调用组件拿到它返回的元素，若那还是个组件就
 * 继续调用，同时对普通元素（`div`/`button`…）也继续往下走。
 *
 * **必须往下走普通元素的 children**：`Page` 里写的是 `h(CandidateRow, {...})`，
 * 它在树里就是一个 `type` 为函数的节点。若 expand 碰到 `div` 就返回、不再展开，
 * 那些行内的按钮在树里根本不存在 —— `render` 会因为惰性展开而把文字渲出来
 * （看起来一切正常），但 `findButton`/`countButtons` 找不到它们，于是「点删除」
 * 这类用例会误报「按钮不存在」。这个坑踩过一次了。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    const inner = expand(node.type(node.props))
    // 保留一层包装，让 render 能继续按元素处理（也便于断言组件被调用过）。
    return { type: 'expanded', props: { children: [inner] } }
  }
  const children = node.props?.children
  if (!Array.isArray(children)) return node
  return { ...node, props: { ...node.props, children: children.map(expand) } }
}

/**
 * 装全局替身。
 * Node 21+ 的 `globalThis.navigator` 只有 getter（浏览器环境的内建对象），
 * 直接赋值会 `TypeError: Cannot set property navigator`，所以一律走
 * `defineProperty`，并要求可重定义（每次用例都要换一份）。
 */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  })
}

// ---------------------------------------------------------------------------
// 假 DOM / ModuleLoader
// ---------------------------------------------------------------------------
function installFakeDom(fetchImpl) {
  const styleTags = []
  const document = {
    documentElement: { lang: 'zh-CN' },
    baseURI: 'http://127.0.0.1:3080/',
    getElementById: (id) => styleTags.find((tag) => tag.id === id) ?? null,
    createElement: (tag) => {
      const element = {
        tagName: tag,
        id: '',
        textContent: '',
        remove() {
          const index = styleTags.indexOf(element)
          if (index >= 0) styleTags.splice(index, 1)
        },
      }
      if (tag === 'style') styleTags.push(element)
      return element
    },
    head: { append: () => {} },
  }

  const registered = []
  defineGlobal('document', document)
  defineGlobal('navigator', { language: 'zh-CN' })
  defineGlobal('fetch', fetchImpl)
  defineGlobal('window', {
    __ModuleLoader__: { load: (entry) => registered.push(entry) },
  })
  return { registered, styleTags }
}

/** 求值一次 client.js；返回它注册的唯一条目。 */
function evalClient(env) {
  env.registered.length = 0
  const context = createContext({
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    fetch: globalThis.fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  })
  runInContext(source, context)
  assert.equal(env.registered.length, 1, '一次求值应注册一个条目')
  return env.registered[0]
}

function fakeRequire() {
  const mini = createMiniReact()
  const require = (id) => {
    if (id === 'react') return mini.api
    throw new Error(`unexpected require(${id})`)
  }
  require.mini = mini
  return require
}

/** 走一遍 factory，拿 exports，并把 Page 挂到 window 上（factory 自己会挂）。 */
function loadExports(entry) {
  const require = fakeRequire()
  const exports = entry.factory(require)
  return { exports, mini: require.mini }
}

/** 用假 ctx 调 apply，收集注册的 section 与 disposer。 */
function applyWith(ctx = {}) {
  const sections = []
  const disposers = []
  const realCtx = {
    ...ctx,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: ctx.slots ?? {
      inject: (name, cb) => cb(name),
      register: (meta, Component) => {
        sections.push({ meta, Component })
        return () => {}
      },
    },
  }
  return { realCtx, sections, disposers }
}

// ---------------------------------------------------------------------------
// 渲染工具
// ---------------------------------------------------------------------------
function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join(' ')
  if (typeof node.type === 'function') return render(node.type(node.props))
  return (node.props?.children ?? []).map(render).join(' ')
}

function snapshot(overrides = {}) {
  return {
    generatedAt: 1793000000000,
    enabled: true,
    logEnabled: false,
    maxEvents: 60,
    chains: [
      {
        id: 'flash-free-first',
        name: 'flash-free-first',
        candidates: [
          { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
          { provider: 'buddy', model: 'deepseek-v4.1-flash' },
        ],
      },
    ],
    totals: { requests: 7, switches: 2, wins: 5, exhausted: 1, aborted: 0, passthrough: 3 },
    byChain: {},
    events: [
      {
        at: 1793000000000,
        type: 'skip',
        chain: 'flash-free-first',
        candidate: 'workbuddy/deepseek-v4.1-flash',
        failure: { code: 'QUOTA', message: '额度用完', status: 429 },
      },
      {
        at: 1793000001000,
        type: 'win',
        chain: 'flash-free-first',
        candidate: 'buddy/deepseek-v4.1-flash',
        attempts: 2,
        elapsedMs: 1834,
      },
    ],
    editable: true,
    source: 'config',
    revision: 0,
    file: '~/.dsh/channel-fallback/chains.json',
    defaults: overrides.chains ?? [
      {
        id: 'flash-free-first',
        name: 'flash-free-first',
        candidates: [
          { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
          { provider: 'buddy', model: 'deepseek-v4.1-flash' },
        ],
      },
    ],
    providers: [
      { provider: 'buddy', name: 'buddy' },
      { provider: 'workbuddy', name: 'workbuddy' },
    ],
    ...overrides,
  }
}

const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const MODELS = {
  models: [
    { provider: 'buddy', model: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
    { provider: 'buddy', model: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { provider: 'trae', model: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
  ],
  failed: [{ provider: 'loomy', error: 'loomy 上游 500' }],
  providers: ['buddy', 'trae', 'loomy'],
}

/**
 * 一个假的后端：记录每次请求，按路径与 body 生成响应。
 *
 * 用它而不是一堆零散 stub，是因为「保存之后快照要跟着变」这条链路只有在
 * 状态被记住时才验得出来 —— 否则每次 GET 都回同一份常量，测不出热生效。
 */
function fakeServer(options = {}) {
  const calls = []
  let state = snapshot(options.snapshot ?? {})
  let nextRevision = 1

  const server = {
    calls,
    get state() {
      return state
    },
    saves: [],
    /** 传 options.testReply（(body)=>Response）来自定义 /test 的回应。 */
    tests: [],
    fetch: async (url, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      const body = typeof init.body === 'string' ? init.body : undefined
      calls.push({ url: String(url), method, body })
      const path = String(url)

      if (path.endsWith('/test')) {
        assert.equal(method, 'POST', '连通测试必须用 POST')
        assert.equal(init.headers?.['content-type'], 'application/json')
        const payload = JSON.parse(body ?? '{}')
        server.tests.push(payload)
        if (options.testError !== undefined) throw new Error(options.testError)
        if (options.testReply !== undefined) return options.testReply(payload)
        return jsonResponse({ ok: true, provider: payload.provider, model: payload.model, totalMs: 1234 })
      }

      if (path.endsWith('/models')) {
        if (options.modelsError !== undefined) return new Response(options.modelsError.body, { status: options.modelsError.status })
        return jsonResponse(MODELS)
      }

      if (path.endsWith('/chains')) {
        assert.equal(method, 'POST', '保存必须用 POST')
        assert.equal(init.headers?.['content-type'], 'application/json')
        const payload = JSON.parse(body ?? '{}')
        if (options.saveError !== undefined) {
          return new Response(JSON.stringify({ error: options.saveError }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (payload.reset === true) {
          state = snapshot({ ...options.snapshot, chains: state.defaults, source: 'config', revision: nextRevision++ })
          server.saves.push({ reset: true })
          return jsonResponse(state)
        }
        assert.ok(Array.isArray(payload.chains), '保存体必须是 {chains: [...]}')
        server.saves.push({ chains: payload.chains })
        state = snapshot({ ...options.snapshot, chains: payload.chains, source: 'file', revision: nextRevision++ })
        return jsonResponse(state)
      }

      if (options.stateError !== undefined) {
        throw new Error(options.stateError)
      }
      return jsonResponse(state)
    },
  }
  return server
}

/**
 * 完整走一遍：假 env → 求值 → factory → apply → 挂载。
 *
 * 返回 tree 而不只是文本：要模拟「点按钮 → 界面变了」，必须能抓到元素上的
 * onClick。
 */
async function mountPanel(fetchImpl) {
  const env = installFakeDom(fetchImpl)
  const entry = evalClient(env)
  const { exports, mini } = loadExports(entry)
  const { realCtx, sections } = applyWith()
  exports.apply(realCtx)
  assert.equal(sections.length, 1, 'apply 应注册一个 settings.section')
  const tree = await mini.mount(sections[0].Component)
  const repaint = async () => mini.mount(sections[0].Component)
  return { env, entry, exports, mini, sections, tree, repaint, text: flatten(tree) }
}

/** 兼容老用例：只要文本。 */
async function renderPanel(fetchImpl) {
  const mounted = await mountPanel(fetchImpl)
  return { ...mounted, text: mounted.text }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
const checks = []
const check = (title, fn) => checks.push({ title, fn })

check('求值两次不抛错（classic script 重新求值必须安全）', () => {
  const env = installFakeDom(async () => jsonResponse(snapshot()))
  evalClient(env)
  evalClient(env)
  assert.equal(env.registered.length, 1, '每次求值各注册一次')
})

check('注册 id / name / inject 对得上', () => {
  const env = installFakeDom(async () => jsonResponse(snapshot()))
  const entry = evalClient(env)
  // 宿主按 package.json 的 name 建 boot graph 的 entry id，注册 id 必须一模一样；
  // 写成短名时脚本能跑完，但宿主会报「loaded without registering」。
  assert.equal(entry.id, pkg.name)
  assert.equal(entry.id, 'dsh-channel-fallback')
  const { exports } = loadExports(entry)
  assert.equal(exports.name, 'channel-fallback')
  // 注意：条目代码是在 vm 上下文里求值的，它产出的数组原型与主 realm 不同，
  // 直接 deepEqual 会报 "same structure but not reference-equal"，所以先摊平。
  assert.deepEqual(Array.from(exports.inject), ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

check('apply 挂的 settings.section：id / order / label / 组件都对', () => {
  const env = installFakeDom(async () => jsonResponse(snapshot()))
  const entry = evalClient(env)
  const { exports } = loadExports(entry)
  const { realCtx, sections } = applyWith()
  exports.apply(realCtx)
  assert.equal(sections.length, 1)
  const { meta, Component } = sections[0]
  assert.equal(meta.name, 'settings.section')
  assert.equal(meta.id, 'channel-fallback')
  assert.equal(meta.order, 45)
  assert.equal(typeof meta.label, 'function')
  assert.equal(meta.label(), '渠道回退')
  assert.equal(typeof Component, 'function')
})

check('正常快照：链、计数、事件、失败原因与 HTTP 状态都在输出里', async () => {
  const { text } = await renderPanel(async () => jsonResponse(snapshot()))
  // v0.5.0 起链是模型选择器里的条目，标题栏是可编辑输入框，链名在 value 里
  // 而不是文本节点，所以这里断言的是「链 id 没被当成用户可见的乱码」+
  // 面板该有的信息都在。
  assert.match(text, /workbuddy/)
  assert.match(text, /buddy/)
  assert.match(text, /优先/)
  assert.match(text, /兜底/)
  assert.match(text, /请求/)
  assert.match(text, /切换/)
  assert.match(text, /QUOTA · HTTP 429/)
  assert.match(text, /额度用完/)
  assert.match(text, /1\.8s/)
  assert.match(text, /2 次尝试/)
  assert.match(text, /直通/)
  assert.match(text, /新建链/, 'v0.5.0 允许多链')
})

check('事件倒序：最新（win）排在较旧（skip）之上', async () => {
  const { text } = await renderPanel(async () => jsonResponse(snapshot()))
  const winIndex = text.indexOf('1.8s')
  const skipIndex = text.indexOf('额度用完')
  assert.ok(winIndex >= 0 && skipIndex >= 0)
  assert.ok(winIndex < skipIndex, '较新的 win 事件应排在较旧的 skip 之上')
})

check('空链给出配置提示，而不是空白', async () => {
  const { text } = await renderPanel(async () => jsonResponse(snapshot({ chains: [], events: [] })))
  assert.match(text, /还没有链/)
  assert.match(text, /还没有事件/)
})

check('插件被禁用时明确说明', async () => {
  const { text } = await renderPanel(async () => jsonResponse(snapshot({ enabled: false })))
  assert.match(text, /插件已禁用/)
})

check('取数失败（HTTP 500）显示可读错误，不白屏', async () => {
  const { text } = await renderPanel(async () => new Response('boom', { status: 500 }))
  assert.match(text, /读不到数据/)
  assert.match(text, /HTTP 500/)
  assert.match(text, /只是这一页拿不到数据/)
})

check('网络异常（fetch reject）走同一条错误路径', async () => {
  const { text } = await renderPanel(async () => {
    throw new Error('network down')
  })
  assert.match(text, /读不到数据/)
  assert.match(text, /network down/)
})

check('样式只装一次；dispose 后清干净', () => {
  const env = installFakeDom(async () => jsonResponse(snapshot()))
  const entry = evalClient(env)
  const { exports } = loadExports(entry)
  const allDisposers = []
  for (let round = 0; round < 2; round += 1) {
    const { realCtx, disposers } = applyWith()
    exports.apply(realCtx)
    allDisposers.push(...disposers)
  }
  assert.equal(env.styleTags.length, 1, '同一个 style id 只该存在一份')
  for (const dispose of allDisposers) dispose()
  assert.equal(env.styleTags.length, 0, 'dispose 后应清掉 style')
})

check('没有 slots 服务时不抛错（页面没了，客户端别跟着炸）', () => {
  const env = installFakeDom(async () => jsonResponse(snapshot()))
  const entry = evalClient(env)
  const { exports } = loadExports(entry)
  const ctx = { effect: (fn) => fn() }
  assert.doesNotThrow(() => exports.apply(ctx))
})

check('快照里字段缺失也不崩（totals/events 都不是数组）', async () => {
  const { text } = await renderPanel(async () => jsonResponse({ enabled: true }))
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
})

// ---------------------------------------------------------------------------
// 编辑：增删模型、调顺序、保存、恢复默认
// ---------------------------------------------------------------------------

/** 点击之后把异步链（fetch → setState）跑完。 */
async function act(fn) {
  fn()
  for (let tick = 0; tick < 12; tick += 1) await flush()
}

check('删除候选：草稿少一个，并提示有未保存改动', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  assert.equal(countButtons(mounted.tree, '删除'), 2, '两个候选各有一个删除按钮')

  await act(() => clickButton(mounted.tree, '删除'))
  const tree = await mounted.repaint()
  const text = flatten(tree)
  assert.equal(countButtons(tree, '删除'), 1)
  assert.match(text, /有未保存的改动/)
})

check('候选可以删到空（v0.5.0 起链允许没有模型）', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '删除'))
  let tree = await mounted.repaint()
  await act(() => clickButton(tree, '删除'))
  tree = await mounted.repaint()
  const text = flatten(tree)
  assert.equal(countButtons(tree, '删除'), 0, '两个候选都删掉了')
  // 空链要给出可操作提示，而不是一片空白
  assert.match(text, /这条链还没有模型/)
})

check('上移/下移改变顺序，且首尾按钮各自禁用', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)

  const up = findButton(mounted.tree, '↑')
  assert.equal(up.props.disabled, true, '第一个候选不能上移')

  await act(() => clickButton(mounted.tree, '↑', 1))
  const tree = await mounted.repaint()
  const text = flatten(tree)
  // buddy 现在是优先，workbuddy 变兜底
  const priorityIndex = text.indexOf('优先')
  assert.ok(priorityIndex >= 0)
  assert.ok(text.indexOf('buddy') < text.indexOf('workbuddy'), '升上去的 buddy 应排在 workbuddy 之前')

  const upNow = findButton(tree, '↑')
  assert.equal(upNow.props.disabled, true, '换顺序之后第一个位置仍然不能上移')
  const upSecond = findButton(tree, '↑', 1)
  assert.notEqual(upSecond.props.disabled, true, '第二个位置可以上移回去')
  const downLast = findButton(tree, '↓', 1)
  assert.equal(downLast.props.disabled, true, '最后一个候选不能下移')
})

check('保存：POST body 是草稿链，成功后提示已生效', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '删除'))
  const edited = await mounted.repaint()
  await act(() => clickButton(edited, '保存'))
  const tree = await mounted.repaint()

  assert.equal(server.saves.length, 1)
  // 点的是第一个候选的「删除」，所以留下的是原来兜底的 buddy。
  assert.deepEqual(server.saves[0].chains[0].candidates, [
    { provider: 'buddy', model: 'deepseek-v4.1-flash' },
  ])
  // v0.5.0：链 id 必须原样带回去 —— 它就是模型选择器里的 model id，
  // 草稿丢掉 id 再保存等于把所有正在用这条链的会话的选择打散。
  assert.equal(server.saves[0].chains[0].id, 'flash-free-first', '保存时链 id 不能丢')
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1)
  assert.match(flatten(tree), /已保存/)
  assert.doesNotMatch(flatten(tree), /有未保存的改动/)
})

check('保存失败：把后端给的原因原样显示出来', async () => {
  const server = fakeServer({ saveError: '第 1 条链至少有 1 个候选' })
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '删除'))
  const edited = await mounted.repaint()
  await act(() => clickButton(edited, '保存'))
  const text = flatten(await mounted.repaint())
  assert.match(text, /第 1 条链至少有 1 个候选/)
  assert.match(text, /有未保存的改动/, '保存失败后仍算脏，不能让用户以为存上了')
})

check('放弃修改：草稿回到快照的样子', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '删除'))
  const edited = await mounted.repaint()
  assert.equal(countButtons(edited, '删除'), 1)

  await act(() => clickButton(edited, '放弃修改'))
  const tree = await mounted.repaint()
  assert.equal(countButtons(tree, '删除'), 2)
  assert.doesNotMatch(flatten(tree), /有未保存的改动/)
})

check('恢复默认：先要确认，再 POST {reset:true}', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)

  await act(() => clickButton(mounted.tree, '恢复默认'))
  const armed = await mounted.repaint()
  assert.match(flatten(armed), /恢复默认会删掉面板保存的链/)
  assert.equal(server.saves.length, 0, '还没确认就不该发请求')

  await act(() => clickButton(armed, '确认恢复'))
  const tree = await mounted.repaint()
  assert.deepEqual(server.saves, [{ reset: true }])
  assert.match(flatten(tree), /链来自配置文件/)
})

check('添加模型：懒加载 /models，点一下加进草稿', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  assert.equal(server.calls.filter((call) => call.url.endsWith('/models')).length, 0, '没点开之前不该问模型清单')

  await act(() => clickButton(mounted.tree, '+ 添加模型'))
  const picker = await mounted.repaint()
  const pickerText = flatten(picker)
  assert.equal(server.calls.filter((call) => call.url.endsWith('/models')).length, 1)
  assert.match(pickerText, /glm-5\.3-flash/)
  assert.match(pickerText, /有渠道查不到模型：loomy/)

  await act(() => clickButton(picker, '+ 添加模型', 1))
  const tree = await mounted.repaint()
  // 候选行从 2 个变 3 个（链的删除按钮文案是「删链」，不混进来）
  assert.equal(countButtons(tree, '删除'), 3, '加了一个候选')
  assert.match(flatten(tree), /glm-5\.3-flash/)
  assert.doesNotMatch(flatten(tree), /正在问各渠道/)
})

check('已在链里的模型不能再加一次', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '+ 添加模型'))
  const picker = await mounted.repaint()
  // 第一个模型是 buddy/deepseek-v4.1-flash，链里已经有了。
  const addButtons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    const children = node.props?.children ?? []
    if (node.type === 'button' && children.length === 1 && (children[0] === '+ 添加模型' || children[0] === '已加入')) {
      addButtons.push({ label: children[0], disabled: node.props.disabled })
    }
    walk(children)
  }
  walk(picker)
  // 第 0 个是外层那个「+ 添加模型」开浮层的按钮
  assert.deepEqual(addButtons.slice(1).map((entry) => entry.label), ['已加入', '+ 添加模型', '+ 添加模型'])
  assert.equal(addButtons[1].disabled, true)
})

check('模型清单取不到：浮层里显示错误，不静默空白', async () => {
  const server = fakeServer({ modelsError: { status: 503, body: 'llm 服务不可用，暂时列不出模型' } })
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '+ 添加模型'))
  const text = flatten(await mounted.repaint())
  assert.match(text, /HTTP 503/)
})

check('editable 为 false 时禁止一切修改', async () => {
  const server = fakeServer({ snapshot: { editable: false } })
  const mounted = await mountPanel(server.fetch)
  assert.equal(findButton(mounted.tree, '删除').props.disabled, true)
  assert.equal(findButton(mounted.tree, '保存').props.disabled, true)
  assert.equal(findButton(mounted.tree, '恢复默认').props.disabled, true)
  assert.equal(findButton(mounted.tree, '+ 添加模型').props.disabled, true)
})

// ---------------------------------------------------------------------------
// 连通测试：点一下「测试」→ 徽章
// ---------------------------------------------------------------------------
check('连通测试：成功显示 ✓ 徽章与耗时', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '测试', 0))
  const tree = await mounted.repaint()
  const text = flatten(tree)
  assert.equal(server.tests.length, 1, '点了一个候选就只发一次测试')
  assert.deepEqual(server.tests[0], { provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
  assert.match(text, /✓ 1\.2s/, 'totalMs 1234 → 1.2s')
  assert.doesNotMatch(text, /测试中/)
})

check('连通测试：失败徽章显示错误码，且第二个候选互不干扰', async () => {
  const server = fakeServer({
    // workbuddy（第 0 行）失败，buddy（第 1 行）成功 —— 用 provider 区分。
    testReply: (payload) => jsonResponse(payload.provider === 'workbuddy'
      ? { ok: false, error: '上游拒绝', code: 'QUOTA', status: 429 }
      : { ok: true, provider: payload.provider, model: payload.model, totalMs: 400 }),
  })
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '测试', 0))
  const first = flatten(await mounted.repaint())
  assert.match(first, /✗ QUOTA/)
  await act(() => clickButton(mounted.tree, '测试', 1)) // index 1 = buddy 那行（徽章不是按钮，两行按钮都还在）
  const both = flatten(await mounted.repaint())
  assert.match(both, /✗ QUOTA/, '第一行的失败徽章还在')
  assert.match(both, /✓ 400ms/, '第二行的成功徽章也出现了（humanMs：<1s 显示 Nms）')
})

check('连通测试：测试期间按钮显示「测试中…」并禁用', async () => {
  // mini React 的 mount() 会一路追到「稳定态」，转瞬即逝的 running 树抓不到；
  // 让 fetch 挂着不 resolve，mount 返回的就是停在 running 的树。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const server = fakeServer()
  const originalFetch = server.fetch
  const mounted = await mountPanel(async (url, init) => {
    if (String(url).endsWith('/test')) {
      await gate
      return originalFetch(url, init)
    }
    return originalFetch(url, init)
  })
  clickButton(mounted.tree, '测试', 0)
  const runningTree = await mounted.repaint()
  const running = flatten(runningTree)
  assert.match(running, /测试中/)
  // 按钮文本是「测试中…」（带省略号），完全相等匹配要用全词。
  const btn = findButton(runningTree, '测试中…')
  assert.notEqual(btn, undefined, '运行中的按钮应显示「测试中…」')
  assert.equal(btn.props.disabled, true, '运行期间不能重复点')
  release()
  await act(() => {})
  const doneTree = await mounted.repaint()
  const done = flatten(doneTree)
  assert.match(done, /✓ 1\.2s/, '放行后正常落到成功徽章')
  assert.doesNotMatch(done, /测试中/)
})

check('连通测试：网络失败也长成 ✗ 徽章（拿 catch 的 message）', async () => {
  const server = fakeServer({ testError: 'HTTP 503' })
  const mounted = await mountPanel(server.fetch)
  await act(() => clickButton(mounted.tree, '测试', 0))
  const text = flatten(await mounted.repaint())
  assert.match(text, /✗ HTTP 503/)
})

check('editable 为 false 时「测试」按钮禁用', async () => {
  const server = fakeServer({ snapshot: { editable: false } })
  const mounted = await mountPanel(server.fetch)
  assert.equal(findButton(mounted.tree, '测试').props.disabled, true, '只读面板不该发测试请求')
})

// ---------------------------------------------------------------------------
// v0.5.1：自动档 + 切换前测速
// ---------------------------------------------------------------------------

/** 找到所有 select 元素（按出现顺序）。 */
function findSelects(node) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.type === 'select') found.push(current)
    walk(current.props?.children ?? [])
  }
  walk(node)
  return found
}

/**
 * 按 className 找下拉框。
 *
 * 链头（含链级档位）渲染在候选行**之前**，所以不能靠「第几个 select」定位 ——
 * 候选档位是 `.dcf-effort`，链级是 `.dcf-chain-effort`。
 */
function findSelectsByClass(node, className) {
  return findSelects(node).filter((select) => String(select.props?.className ?? '').includes(className))
}

/** 找到某个下拉框里 value 为 `value` 的选项（验证「自动」这一项在不在）。 */
function hasOption(select, value) {
  return (select.props.children ?? []).some((option) => option?.props?.value === value)
}

/** 找到一个 checkbox（链头只有一个：切换前测速）。 */
function findCheckbox(node) {
  let found
  const walk = (current) => {
    if (found !== undefined || current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.type === 'input' && current.props?.type === 'checkbox') {
      found = current
      return
    }
    walk(current.props?.children ?? [])
  }
  walk(node)
  return found
}

check('档位下拉：有「自动」这一项，且选了之后存成 null', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  const candidateSelects = findSelectsByClass(mounted.tree, 'dcf-effort')
  assert.ok(candidateSelects.length >= 1, `应该有候选档位下拉，实际 ${candidateSelects.length}`)
  assert.equal(hasOption(candidateSelects[0], 'auto'), true, '候选档位下拉里必须有「自动」')

  // 选「自动」→ 草稿里存 null（不是字符串 'auto'，那会被宿主当成非法档位）。
  candidateSelects[0].props.onChange({ target: { value: 'auto' } })
  await act(() => {})
  const edited = await mounted.repaint()
  await act(() => clickButton(edited, '保存'))
  const tree = await mounted.repaint()
  assert.equal(server.saves.length, 1)
  assert.equal(server.saves[0].chains[0].candidates[0].reasoningEffort, null, '自动档要存成 null')
  assert.doesNotMatch(flatten(tree), /有未保存的改动/)
})

check('档位下拉：清空 = 删掉字段（不写 null，也不算脏设置）', async () => {
  const server = fakeServer({
    snapshot: {
      chains: [{
        id: 'flash-free-first',
        name: 'flash-free-first',
        candidates: [
          { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
          { provider: 'buddy', model: 'deepseek-v4.1-flash' },
        ],
      }],
    },
  })
  const mounted = await mountPanel(server.fetch)
  const candidateSelects = findSelectsByClass(mounted.tree, 'dcf-effort')
  candidateSelects[0].props.onChange({ target: { value: '' } })
  await act(() => {})
  const ready = await mounted.repaint()
  await act(() => clickButton(ready, '保存'))
  await mounted.repaint()
  const saved = server.saves[0].chains[0].candidates[0]
  assert.equal('reasoningEffort' in saved, false, '「跟随上游默认」= 字段不存在，而不是 null')
})

check('链级档位：读回 null（整条链自动）时下拉显示「自动」而不是「跟随默认」', async () => {
  const server = fakeServer({
    snapshot: {
      chains: [{
        id: 'flash-free-first',
        name: 'flash-free-first',
        reasoningEffort: null,
        candidates: [
          { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
          { provider: 'buddy', model: 'deepseek-v4.1-flash' },
        ],
      }],
    },
  })
  const mounted = await mountPanel(server.fetch)
  const chainSelects = findSelectsByClass(mounted.tree, 'dcf-chain-effort')
  assert.equal(chainSelects.length, 1, '链头应该有一个链级档位下拉')
  assert.equal(chainSelects[0].props.value, 'auto', 'null 必须显示成「自动」，不能退回「跟随默认」')
})

check('切换前测速：复选框能开，开启后保存带 speedProbe:true', async () => {
  const server = fakeServer()
  const mounted = await mountPanel(server.fetch)
  const checkbox = findCheckbox(mounted.tree)
  assert.notEqual(checkbox, undefined, '链头应该有「切换前测速」复选框')
  assert.equal(checkbox.props.checked, false, '默认必须是关的（探测要花时间+额度）')

  checkbox.props.onChange({ target: { checked: true } })
  await act(() => {})
  const ready = await mounted.repaint()
  await act(() => clickButton(ready, '保存'))
  const tree = await mounted.repaint()
  assert.equal(server.saves[0].chains[0].speedProbe, true)
  assert.doesNotMatch(flatten(tree), /有未保存的改动/)
})

check('切换前测速：快照里 speedProbe 为 true 时复选框是勾上的', async () => {
  const server = fakeServer({
    snapshot: {
      chains: [{
        id: 'flash-free-first',
        name: 'flash-free-first',
        speedProbe: true,
        candidates: [
          { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
          { provider: 'buddy', model: 'deepseek-v4.1-flash' },
        ],
      }],
    },
  })
  const mounted = await mountPanel(server.fetch)
  const box = findCheckbox(mounted.tree)
  assert.equal(box?.props?.checked, true, '读回来的 speedProbe 要体现在勾选状态上')
})

check('事件流：probe 事件显示「测速」与最快的那家', async () => {
  // 链留空：链头的「切换前测速」复选框文案里也有「测速」二字，留着它会让
  // 断言变得什么都匹配得上（红绿验证就是这么抓出假绿的）。
  const server = fakeServer({
    snapshot: {
      chains: [],
      events: [
        {
          at: 1793000002000,
          type: 'probe',
          chain: 'flash-free-first',
          probes: [
            { provider: 'buddy', model: 'deepseek-v4.1-flash', ok: false, ms: 6000, error: 'TIMEOUT' },
            { provider: 'trae', model: 'deepseek-v4.1-flash', ok: true, ms: 812 },
          ],
        },
      ],
    },
  })
  const mounted = await mountPanel(server.fetch)
  const text = flatten(mounted.tree)
  assert.match(text, /测速/, 'probe 事件要有自己的类型标签')
  assert.match(text, /trae\/deepseek-v4\.1-flash/, '应显示探通的那家')
  assert.match(text, /812ms/)
})

check('事件流：全部探不通时给一句「按原顺序继续」', async () => {
  const server = fakeServer({
    snapshot: {
      events: [
        {
          at: 1793000002000,
          type: 'probe',
          chain: 'flash-free-first',
          probes: [{ provider: 'buddy', model: 'deepseek-v4.1-flash', ok: false, ms: 6000, error: 'TIMEOUT' }],
        },
      ],
    },
  })
  const mounted = await mountPanel(server.fetch)
  assert.match(flatten(mounted.tree), /都探不通，按原顺序继续/)
})

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
let failed = 0
for (const { title, fn } of checks) {
  try {
    await fn()
    console.log(`  ✔ ${title}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${title}`)
    console.log(`    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  }
}

console.log('')
if (failed === 0) {
  console.log(`全部 ${checks.length} 项客户端验证通过。`)
  process.exit(0)
}
console.log(`${checks.length} 项里有 ${failed} 项失败。`)
process.exit(1)
