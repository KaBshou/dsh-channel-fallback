/**
 * 红绿验证：证明 probe-client.mjs 的用例真能抓到问题，而不是永远绿。
 *
 * 做法：在内存里改坏 client.js 的源码，写到临时文件，让 probe 去跑那个临时
 * 副本；每次跑完立刻还原。**不碰真文件**，避免编码/换行把仓库搞脏。
 *
 * 为什么需要它：一个只会绿的测试等于没有测试。这里逐条验证「把某个关键行为
 * 弄坏 → 对应用例必须变红」。
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const probePath = path.join(here, 'probe-client.mjs')
const originalSource = await readFile(path.join(here, 'client.js'), 'utf8')
const probeSource = await readFile(probePath, 'utf8')

const cases = [
  {
    title: '顶层泄漏一个 const → 「求值两次不抛错」应变红',
    mutate: (source) => `const TOP_LEVEL_LEAK = 1\n${source}`,
    expect: /求值两次不抛错/,
  },
  {
    title: '不渲染 HTTP 状态 → 「失败原因与 HTTP 状态」应变红',
    mutate: (source) => source.replace(
      "failure.status === undefined ? failure.code : `${failure.code} · HTTP ${failure.status}`",
      'failure.code',
    ),
    expect: /失败原因与 HTTP 状态/,
  },
  {
    title: '事件不反转 → 「事件倒序」应变红',
    mutate: (source) => source.replace('snapshot.events.slice().reverse()', 'snapshot.events.slice()'),
    expect: /事件倒序/,
  },
  {
    title: '错误态回落到 loading → 「取数失败显示可读错误」应变红',
    mutate: (source) => source.replace("phase.startsWith('error:')", "phase.startsWith('error-unreachable:')"),
    expect: /取数失败/,
  },
  {
    title: "注册 id 写成短名 → 「注册 id / name / inject」应变红",
    mutate: (source) => source.replace('id: packageId,', "id: 'channel-fallback',"),
    expect: /注册 id \/ name \/ inject/,
  },
  {
    title: 'section id 写错 → 「id / order / label」应变红',
    mutate: (source) => source.replace("id: 'channel-fallback',", "id: 'wrong-id',"),
    expect: /id \/ order \/ label/,
  },
  {
    title: '缺 slots 时直接抛 → 「没有 slots 不抛错」应变红',
    mutate: (source) => source.replace(
      "if (ctx.slots === undefined || typeof ctx.slots.inject !== 'function') return removeStyles",
      '',
    ),
    expect: /没有 slots 服务时不抛错/,
  },
  {
    // v0.5.0 起链允许没有候选（面板提示「先加一个」），所以这条红绿测的是
    // 另一件事：**空链必须给出可操作提示**，而不是一片空白。
    title: '空链不显示提示 → 「候选可以删到空」应变红',
    mutate: (source) => source.replace(
      "? h('p', { className: 'dcf-note' }, t.noCandidate)",
      "? null",
    ),
    expect: /候选可以删到空/,
  },
  {
    title: '第一个候选也能上移 → 「上移/下移改变顺序」应变红',
    mutate: (source) => source.replace('disabled: locked || index === 0,', 'disabled: locked,'),
    expect: /上移\/下移改变顺序/,
  },
  {
    title: '保存时发空 body → 「保存：POST body 是草稿链」应变红',
    mutate: (source) => source.replace(
      "const next = await postJson('/chains', { chains: draft })",
      "const next = await postJson('/chains', {})",
    ),
    expect: /保存：POST body 是草稿链/,
  },
  {
    title: '保存失败只显示「保存失败」→ 「原样显示后端原因」应变红',
    mutate: (source) => source.replace(
      'text: dirty ? `${savePhase.slice(6)} · ${t.dirtyHint}` : savePhase.slice(6),',
      "text: '保存失败',",
    ),
    expect: /保存失败：把后端给的原因原样显示出来/,
  },
  {
    title: 'editable 为 false 也允许编辑 → 「禁止一切修改」应变红',
    mutate: (source) => source.replace('const locked = editable !== true', 'const locked = false'),
    expect: /editable 为 false 时禁止一切修改/,
  },
  {
    title: '刷新时顺手拉模型清单（不懒加载）→ 「懒加载 /models」应变红',
    mutate: (source) => source.replace(
      'const next = await readJson(\'/state\')',
      "await readJson('/models').catch(() => {}); const next = await readJson('/state')",
    ),
    expect: /添加模型：懒加载 \/models/,
  },
  {
    title: '测试期间不显示「测试中…」→ 「运行态按钮」应变红',
    mutate: (source) => source.replace('running ? t.testing : t.test', 't.test'),
    expect: /测试期间按钮显示「测试中…」并禁用/,
  },
  {
    title: '运行中的测试按钮不禁用 → 「运行期间不能重复点」应变红',
    mutate: (source) => source.replace('disabled: locked || running,', 'disabled: locked,'),
    expect: /测试期间按钮显示「测试中…」并禁用/,
  },
  {
    title: '测试失败只显示通用文案 → 「✗ 徽章显示后端错误码」应变红',
    mutate: (source) => source.replace(
      "typeof test.code === 'string' && test.code !== '' ? test.code : (test.error ?? '')",
      "'测试失败'",
    ),
    expect: /失败徽章显示错误码，且第二个候选互不干扰/,
  },
  {
    title: '测试请求头缺 content-type → 「POST + JSON 头」应变红',
    mutate: (source) => source.replace(
      "headers: { 'content-type': 'application/json', accept: 'application/json' },",
      "headers: { accept: 'application/json' },",
    ),
    expect: /连通测试：成功显示 ✓ 徽章与耗时/,
  },
  {
    // v0.5.1：候选档位下拉里没有「自动」这一项 → 对应用例必须变红。
    title: '候选档位下拉去掉「自动」选项 → 「有自动这一项」应变红',
    mutate: (source) => source.replace(
      "h('option', { value: 'auto' }, t.effortAuto),\n            ...efforts.map",
      "...efforts.map",
    ),
    expect: /档位下拉：有「自动」这一项/,
  },
  {
    // 「自动」存成字符串 'auto' 而不是 null → 上游会以非法档位拒掉整次调用。
    title: "选「自动」时存字符串 'auto' 而不是 null → 「选了之后存成 null」应变红",
    mutate: (source) => source.replace(
      "else if (value === 'auto') next.reasoningEffort = null",
      "else if (value === 'auto') next.reasoningEffort = 'auto'",
    ),
    expect: /档位下拉：有「自动」这一项，且选了之后存成 null/,
  },
  {
    title: '清空档位时写 null 而不是删字段 → 「清空 = 删掉字段」应变红',
    mutate: (source) => source.replace(
      "if (value === '') delete next.reasoningEffort\n            else if (value === 'auto') next.reasoningEffort = null",
      "if (value === '') next.reasoningEffort = null\n            else if (value === 'auto') next.reasoningEffort = null",
    ),
    expect: /档位下拉：清空 = 删掉字段/,
  },
  {
    // 链级档位读回 null 时退回「跟随默认」= 用户选的自动静默丢了。
    title: '链级下拉不认 null → 「读回 null 显示自动」应变红',
    mutate: (source) => source.replace(
      "value: chain.reasoningEffort === null\n                          ? 'auto'\n                          : typeof chain.reasoningEffort === 'string'\n                            ? chain.reasoningEffort\n                            : '',",
      "value: typeof chain.reasoningEffort === 'string' ? chain.reasoningEffort : '',",
    ),
    expect: /链级档位：读回 null（整条链自动）时下拉显示「自动」/,
  },
  {
    title: '复选框不读 chain.speedProbe → 「勾选状态」应变红',
    mutate: (source) => source.replace(
      'checked: chain.speedProbe === true,',
      'checked: false,',
    ),
    expect: /切换前测速：快照里 speedProbe 为 true 时复选框是勾上的/,
  },
  {
    title: '勾选复选框不写 speedProbe → 「开启后保存带 speedProbe」应变红',
    mutate: (source) => source.replace(
      'if (on) next.speedProbe = true\n              else delete next.speedProbe',
      'delete next.speedProbe',
    ),
    expect: /切换前测速：复选框能开，开启后保存带 speedProbe:true/,
  },
  {
    title: 'probe 事件不给类型标签 → 「测速」应变红',
    mutate: (source) => source.replace('probe: t.typeProbe,', 'probe: event.type,'),
    expect: /事件流：probe 事件显示「测速」与最快的那家/,
  },
  {
    title: 'probe 事件不显示最快的那家 → 「显示探通的那家」应变红',
    mutate: (source) => source.replace(
      "parts.push({ key: 'fastest', text: `${fast.provider}/${fast.model}`, mono: true })",
      '',
    ),
    expect: /事件流：probe 事件显示「测速」与最快的那家/,
  },
]

/** 用突变后的 client.js 跑一次 probe，返回 { ok, text }。 */
function runProbeWith(mutatedClient) {
  // probe 里那句 `readFile(…client.js…)` 换成直接内联字符串 —— 这样 probe
  // 读到的就是被改坏的那份，而磁盘上的 client.js 一根毛都不动。
  const patchedProbe = probeSource.replace(
    "const source = await readFile(path.join(here, 'client.js'), 'utf8')",
    `const source = ${JSON.stringify(mutatedClient)}`,
  )
  assert.notEqual(patchedProbe, probeSource, 'patch 没生效：probe 的读文件那行变了？')
  const probeTmp = path.join(here, '__probe-redgreen.mjs')
  writeFileSync(probeTmp, patchedProbe, 'utf8')
  try {
    const run = spawnSync(process.execPath, ['__probe-redgreen.mjs'], { cwd: here, encoding: 'utf8' })
    return { ok: run.status === 0, text: `${run.stdout ?? ''}${run.stderr ?? ''}` }
  } finally {
    try {
      unlinkSync(probeTmp)
    } catch {}
  }
}

let failed = 0
for (const testCase of cases) {
  const mutated = testCase.mutate(originalSource)
  assert.notEqual(mutated, originalSource, `${testCase.title}：突变没生效，用例本身失效`)
  const { ok, text } = runProbeWith(mutated)
  const matched = testCase.expect.test(text)
  if (!ok && matched) {
    console.log(`  ✔ ${testCase.title}`)
  } else {
    failed += 1
    console.log(`  ✘ ${testCase.title}（probe exit=${ok ? 0 : 1}，命中=${matched}）`)
    console.log(text.split('\n').filter((line) => line.includes('✘') || line.includes('AssertionError')).join('\n'))
  }
}

console.log('')
if (failed === 0) {
  console.log(`全部 ${cases.length} 项红绿验证通过（每条用例都能被弄红）。`)
  process.exit(0)
}
console.log(`${cases.length} 项里有 ${failed} 项没被弄红 —— 那些用例是假绿。`)
process.exit(1)
