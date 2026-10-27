/**
 * dsh-channel-fallback 的浏览器半边：设置 → 「渠道回退」一页。
 *
 * 这一页做三件事：
 *   1. **看**：现在配的链是什么（谁优先、谁兜底）、切换了多少次、最近发生了什么；
 *   2. **改**：在链里加模型、删模型、调顺序，保存后立刻生效（宿主每次请求都
 *      现读链，不需要重启）；
 *   3. **退**：一键恢复配置文件里的默认链。
 *
 * 为什么文件是这样一个 IIFE：
 *   外壳把 client 当**普通 classic script** 加载（每次 revision 一个新鲜的
 *   `<script src=…?rev=…>`），重建时会在同一个 realm 里再求值一次。顶层
 *   `let` / `const` / `class` 第二次声明直接 `Identifier '…' has already been
 *   declared`，新版本还没跑到第一句就死了 —— 表现是「改了没反应」。所以整份
 *   文件包在一个函数作用域里，求值多少次都安全（照 `dsh-wechat-plugin` 的写法）。
 *
 * 数据：
 *   · `GET  /api/channel-fallback/state`   快照（链 + 计数 + 事件 + 可选渠道）
 *   · `GET  /api/channel-fallback/models`  可添加的模型（**懒加载**，只在打开
 *     「添加模型」时才问 —— 它要逐渠道打上游，很贵）
 *   · `POST /api/channel-fallback/chains`  保存（body `{chains}` 或 `{reset:true}`）
 *
 * 注意作用域：`require('react')` 只有 factory 里才有，所以**所有组件都必须
 * 定义在 factory 内部**。写在 IIFE 顶层会拿到 undefined 的 `h`。
 *
 * 注意 hook 位置：`probe-client.mjs` 的 mini React 没有「每个组件一个 hook
 * 作用域」的概念，所以**所有 useState/useCallback 都集中在 `Page` 里**，子组件
 * 一律只收 props。真 React 里这也完全合法（只是 Page 稍胖），换来的是这一页
 * 能被离线验证。
 */

(function () {
  const STYLE_ID = 'dsh-channel-fallback-style'
  const API = '/api/channel-fallback'

  const copy = {
    zh: {
      nav: '渠道回退',
      title: '渠道回退',
      intro: '链就是模型选择器里的一个条目：选中它，请求按链上的顺序走，前一个失败自动换下一个。改动保存后立刻生效，不用重启。',
      howto: '在会话的模型选择器里选「渠道链 · 链名」即可启用；不选就不影响任何请求。',
      refresh: '刷新',
      refreshing: '读取中…',
      loadFailed: '读不到数据',
      loadFailedHint: '宿主侧面板 API 没响应。插件路由可能仍在工作，只是这一页拿不到数据。',
      disabled: '插件已禁用（config.enabled === false）',
      noChains: '还没有链。点「新建链」开始配一条。',
      chainTitle: '链',
      newChain: '+ 新建链',
      newChainName: '链 {n}',
      deleteChain: '删链',
      onlyOneChain: '至少要留一条链',
      chainName: '链名',
      chainNameHint: '链名会显示在模型选择器里；改链名会同时换一个新的链 id。',
      chainEffort: '整条链的档位',
      effortDefault: '跟随上游默认',
      effortAuto: '自动（这一站自己定）',
      speedProbe: '切换前测速',
      speedProbeHint: '开启后，链头失败要换站时会先并发试一下剩下的站谁最快，按实测速度决定顺序。代价是切换会多花 1–3 秒和一点额度。',
      effortUnsupported: '不支持档位',
      effortLoading: '查档位…',
      effortHint: '候选自己选了档位就以候选为准；否则用这里；都没选就交给上游默认。',
      rate: '倍率',
      rateUnknown: '倍率未知',
      priority: '优先',
      fallback: '兜底',
      addModel: '+ 添加模型',
      remove: '删除',
      moveUp: '上移',
      moveDown: '下移',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      restore: '恢复默认',
      restoreConfirm: '恢复默认会删掉面板保存的链，回到配置文件里的那份。',
      restoreYes: '确认恢复',
      restoreNo: '取消',
      dirtyHint: '有未保存的改动',
      savedOk: '已保存。选择器里的「渠道链」分组会立刻刷新。',
      sourceConfig: '链来自配置文件',
      sourceFile: '链来自面板保存',
      savedAt: '保存于 {t}',
      revision: '第 {n} 次修改',
      onlyOneLeft: '链里至少要留一个模型',
      noCandidate: '这条链还没有模型，先加一个。',
      test: '测试',
      testing: '测试中…',
      testOk: '✓ {n}',
      testFail: '✗ {n}',
      testHint: '向该模型发一次极小请求，看它现在能不能答',
      pickerTitle: '添加模型',
      pickerLoading: '正在问各渠道有哪些模型…',
      pickerEmpty: '这个渠道没报回任何模型。',
      pickerFailed: '有渠道查不到模型：{list}',
      pickerClose: '收起',
      pickerAdded: '已加入',
      pickerFilterAll: '全部渠道',
      statsTitle: '累计',
      requests: '请求',
      switches: '切换',
      wins: '成功',
      exhausted: '全挂',
      aborted: '取消',
      passthrough: '直通',
      passthroughHint: '不归本插件管的请求（例如会话标题生成）',
      eventsTitle: '最近事件',
      noEvents: '还没有事件。发一句话给模型，这里就会出现记录。',
      eventsLimit: '只保留最近 {n} 条',
      typeStart: '请求',
      typeSkip: '切换',
      typeWin: '成功',
      typeExhausted: '全挂',
      typeAborted: '取消',
      typeProbe: '测速',
      probeNone: '都探不通，按原顺序继续',
      attempts: '{n} 次尝试',
      logOn: '诊断日志已开',
      logOff: '诊断日志未开',
      logHint: '设 DSH_CHANNEL_FALLBACK_LOG=1 可写文件日志',
      unknown: '未知',
      file: '保存位置',
    },
    en: {
      nav: 'Channel fallback',
      title: 'Channel fallback',
      intro: 'A chain is one entry in the model picker: pick it and the request walks the chain, moving on when a step fails. Changes apply right after saving — no restart.',
      howto: 'Select "Channel chain · name" in the model picker to use it; leave it unselected and nothing changes.',
      refresh: 'Refresh',
      refreshing: 'Loading…',
      loadFailed: 'Cannot load data',
      loadFailedHint: 'The host-side panel API did not answer. Routing may still work; only this page is blind.',
      disabled: 'Plugin disabled (config.enabled === false)',
      noChains: 'No chains yet. Click "New chain" to make one.',
      chainTitle: 'Chains',
      newChain: '+ New chain',
      newChainName: 'Chain {n}',
      deleteChain: 'Del chain',
      onlyOneChain: 'Keep at least one chain',
      chainName: 'Chain name',
      chainNameHint: 'The name shows up in the model picker; renaming also gives the chain a new id.',
      chainEffort: 'Chain-wide reasoning effort',
      effortDefault: 'Follow upstream default',
      effortAuto: 'Auto (this site decides)',
      speedProbe: 'Probe before switching',
      speedProbeHint: 'When on, if the first candidate fails, the remaining ones are probed concurrently and tried in measured-speed order. Costs 1–3s and a little quota per switch.',
      effortUnsupported: 'No effort levels',
      effortLoading: 'Loading efforts…',
      effortHint: 'A candidate that pins its own effort wins; otherwise this applies; otherwise the upstream default.',
      rate: 'Rate',
      rateUnknown: 'rate unknown',
      priority: 'primary',
      fallback: 'fallback',
      addModel: '+ Add model',
      remove: 'Remove',
      moveUp: 'Move up',
      moveDown: 'Move down',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      restore: 'Restore defaults',
      restoreConfirm: 'Restoring deletes the chains saved from this panel and goes back to the config file.',
      restoreYes: 'Restore',
      restoreNo: 'Cancel',
      dirtyHint: 'Unsaved changes',
      savedOk: 'Saved. The "Channel chain" group in the picker refreshes immediately.',
      sourceConfig: 'Chains from config file',
      sourceFile: 'Chains saved from this panel',
      savedAt: 'saved {t}',
      revision: 'revision {n}',
      onlyOneLeft: 'A chain needs at least one model',
      noCandidate: 'This chain has no models yet — add one.',
      test: 'Test',
      testing: 'Testing…',
      testOk: '✓ {n}',
      testFail: '✗ {n}',
      testHint: 'Send a tiny request to this model and see whether it answers right now',
      pickerTitle: 'Add model',
      pickerLoading: 'Asking each channel for its models…',
      pickerEmpty: 'This channel reported no models.',
      pickerFailed: 'Some channels failed: {list}',
      pickerClose: 'Close',
      pickerAdded: 'added',
      pickerFilterAll: 'All channels',
      statsTitle: 'Totals',
      requests: 'Requests',
      switches: 'Switches',
      wins: 'Wins',
      exhausted: 'Exhausted',
      aborted: 'Aborted',
      passthrough: 'Passthrough',
      passthroughHint: 'Requests this plugin does not own (e.g. session titles)',
      eventsTitle: 'Recent events',
      noEvents: 'No events yet. Send one message and records will appear here.',
      eventsLimit: 'Keeps the latest {n} events',
      typeStart: 'start',
      typeSkip: 'switch',
      typeWin: 'win',
      typeExhausted: 'exhausted',
      typeAborted: 'aborted',
      typeProbe: 'probe',
      probeNone: 'all failed, keeping order',
      attempts: '{n} attempts',
      logOn: 'Diagnostic log on',
      logOff: 'Diagnostic log off',
      logHint: 'Set DSH_CHANNEL_FALLBACK_LOG=1 for a file log',
      unknown: 'unknown',
      file: 'Saved at',
    },
  }

  /** 按页面语言挑词典（与 DSH 其他插件一致，不自己定义语言开关）。 */
  function text() {
    const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
    return lang.toLowerCase().startsWith('zh') ? copy.zh : copy.en
  }

  function fill(template, value) {
    return String(template).replace('{n}', String(value)).replace('{t}', String(value)).replace('{list}', String(value))
  }

  /** 毫秒 → 人类可读。 */
  function humanMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  function clockTime(at) {
    if (!Number.isFinite(at)) return '—'
    try {
      return new Date(at).toLocaleTimeString()
    } catch {
      return '—'
    }
  }

  function stampTime(iso) {
    if (typeof iso !== 'string' || iso === '') return '—'
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return iso
    try {
      return new Date(at).toLocaleString()
    } catch {
      return iso
    }
  }

  const styles = `
.dcf-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; }
.dcf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dcf-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0 0 4px; }
.dcf-intro { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin: 0; }
.dcf-btn { flex: none; font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); transition: background .15s; }
.dcf-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.dcf-btn:disabled { opacity: .55; cursor: default; }
.dcf-btn-primary { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.dcf-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dcf-btn-mini { padding: 2px 7px; font-size: 11px; border-radius: 5px; }
.dcf-section { display: flex; flex-direction: column; gap: 10px; }
.dcf-section-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dcf-section-title { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary); margin: 0; }
.dcf-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.dcf-chain-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dcf-chain-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
  flex: 1 1 160px; min-width: 0; }
.dcf-chain-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dcf-input, .dcf-select { font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); }
.dcf-input:disabled, .dcf-select:disabled { opacity: .6; cursor: default; }
.dcf-select { flex: 0 0 auto; max-width: 200px; }
.dcf-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
  color: var(--dsw-alias-fg-secondary, #8b8b8b); white-space: nowrap; cursor: pointer; }
.dcf-check input { margin: 0; cursor: pointer; }
.dcf-check input:disabled { cursor: default; }
.dcf-row { display: grid; grid-template-columns: 30px 1fr auto auto; gap: 8px; align-items: center;
  padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); }
.dcf-row-primary { border-color: var(--dsw-alias-state-business-primary); }
.dcf-row-index { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dcf-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dcf-row-model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; }
.dcf-rate { font-size: 10px; color: var(--dsw-alias-state-warning-primary); }
.dcf-row-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dcf-tag { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.dcf-row-actions { display: flex; gap: 4px; align-items: center; }
.dcf-add { align-self: flex-start; }
.dcf-test-badge { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dcf-test-ok { color: var(--dsw-alias-state-success-primary); }
.dcf-test-fail { color: var(--dsw-alias-state-error-primary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.dcf-steps-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin: 0; line-height: 1.6; }
.dcf-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dcf-bar-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dcf-bar-warn { color: var(--dsw-alias-state-warning-primary); }
.dcf-bar-ok { color: var(--dsw-alias-state-success-primary); }
.dcf-bar-error { color: var(--dsw-alias-state-error-primary); }
.dcf-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  border: 1px solid var(--dsw-alias-state-warning-primary); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); }
.dcf-picker { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.dcf-picker-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dcf-picker-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dcf-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.dcf-chip { font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); }
.dcf-chip-on { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.dcf-models { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto;
  border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 6px; }
.dcf-model { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 4px 6px; border-radius: 5px; }
.dcf-model:hover { background: var(--dsw-alias-bg-layer-3); }
.dcf-model-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dcf-model-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  color: var(--dsw-alias-label-primary); }
.dcf-model-where { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.dcf-model-name { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcf-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.dcf-tile { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
.dcf-tile-value { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums; line-height: 1.2; }
.dcf-tile-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dcf-tile-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary); line-height: 1.4; }
.dcf-events { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dcf-event { display: grid; grid-template-columns: 62px 52px 1fr; gap: 10px; align-items: baseline;
  padding: 8px 12px; font-size: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dcf-event:first-child { border-top: none; }
.dcf-event-time { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; font-size: 11px; }
.dcf-event-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
.dcf-kind-win { color: var(--dsw-alias-state-success-primary); }
.dcf-kind-skip { color: var(--dsw-alias-state-warning-primary); }
.dcf-kind-exhausted { color: var(--dsw-alias-state-error-primary); }
.dcf-kind-aborted { color: var(--dsw-alias-label-tertiary); }
.dcf-kind-start { color: var(--dsw-alias-label-secondary); }
.dcf-event-body { color: var(--dsw-alias-label-primary); display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.dcf-event-model { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dcf-event-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dcf-event-failure { color: var(--dsw-alias-state-error-primary); font-size: 11px; }
.dcf-failure-body { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dcf-note { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); margin: 0; }
.dcf-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dcf-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; }
.dcf-error-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-state-error-primary); margin: 0 0 4px; }
.dcf-error-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; line-height: 1.6; }
`

  function installStyles() {
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) return () => {}
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = styles
    document.head.append(style)
    return () => {
      style.remove?.()
    }
  }

  /**
   * 只留面板认识的字段，别把后端结构直接搬进草稿（保存时会原样回传）。
   *
   * `id` 必须保留 —— 它就是模型选择器里的 model id，也是会话里已经记住的
   * 选择。草稿丢掉 id 再保存，等于把所有正在用这条链的会话换成了新 id，
   * 用户的选择会突然失效（`normalizeChains` 会按链名重新 slug 出一个新 id）。
   */
  function cloneChains(chains) {
    if (!Array.isArray(chains)) return []
    return chains.map((chain) => {
      const out = {
        name: typeof chain?.name === 'string' ? chain.name : '',
        candidates: (Array.isArray(chain?.candidates) ? chain.candidates : [])
          .filter((candidate) => typeof candidate?.provider === 'string' && typeof candidate?.model === 'string')
          .map((candidate) => {
            const item = { provider: candidate.provider, model: candidate.model }
            if (candidate.reasoningEffort !== undefined) item.reasoningEffort = candidate.reasoningEffort
            if (candidate.maxTokens !== undefined) item.maxTokens = candidate.maxTokens
            return item
          }),
      }
      if (typeof chain?.id === 'string' && chain.id !== '') out.id = chain.id
      // `null` 表示「整条链自动」，是**有意义的取值**，不能用 typeof 过滤掉。
      if (chain?.reasoningEffort === null || typeof chain?.reasoningEffort === 'string') {
        out.reasoningEffort = chain.reasoningEffort
      }
      if (chain?.speedProbe === true) out.speedProbe = true
      return out
    })
  }

  function labelOf(candidate) {
    return `${candidate.provider}/${candidate.model}`
  }

  /** 链名改了要换新 id（否则选择器里两个同名条目没法区分）。 */
  function nextChainId(name, chains) {
    const base =
      String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'chain'
    const taken = new Set(
      (Array.isArray(chains) ? chains : []).map((chain) => chain?.id).filter((id) => typeof id === 'string'),
    )
    if (!taken.has(base)) return base
    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${base}-${index}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base}-${Date.now().toString(36)}`
  }

  const name = 'channel-fallback'
  /**
   * 注册 id **必须是包名**，不是上面的短名。
   *
   * 宿主 `client-modules` 用 package.json 的 `name` 作为 boot graph 的 entry id，
   * 收到脚本后只按这个 id 去 `factories` 里找工厂（`stripClientSuffix` 也只去掉
   * 末尾的 `/client`）。写成 `channel-fallback` 会让脚本正常执行、工厂却挂在另一个
   * 键上，宿主报「loaded without registering "dsh-channel-fallback"」，整个 client
   * 半边不激活。`probe-client.mjs` 现在直接读 package.json 对这个值。
   */
  const packageId = 'dsh-channel-fallback'
  const inject = ['slots']

  function apply(ctx) {
    ctx.effect(() => {
      const removeStyles = installStyles()
      // `inject: ['slots']` 正常保证它存在；这里只是不信任环境，别让缺服务炸掉整客户端。
      if (ctx.slots === undefined || typeof ctx.slots.inject !== 'function') return removeStyles
      const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'channel-fallback',
          // 内置分区在 10..30，微信插件占 40；排在它后面。
          order: 45,
          label: () => text().nav,
          inject: () => ({}),
        },
        // 组件由 factory 在下面注入：`require('react')` 只有 factory 里才有，
        // 所以这里不能直接引用 React，只能走 window 上那层薄转发。
        (props) => {
          const mod = window.__channelFallback
          if (mod === undefined || typeof mod.Page !== 'function') return null
          return mod.h(mod.Page, props)
        },
      ))
      return () => {
        if (typeof disposeSection === 'function') disposeSection()
        removeStyles()
      }
    })
  }

  // 注册在求值当下就发生（不加守卫）：client 条目注册失败本来就只能在
  // `apply` 里报，若注册本身被吞掉，就彻底没有痕迹了。
  window.__ModuleLoader__.load({
    id: packageId,
    factory: (require) => {
      const React = require('react')
      const h = React.createElement

      /** 一次 GET，带超时兜底：后端没挂上时 fetch 不该永久挂着。 */
      async function readJson(path, timeoutMs = 8000) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(`${API}${path}`, {
            cache: 'no-store',
            signal: controller.signal,
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.json()
        } finally {
          clearTimeout(timer)
        }
      }

      /**
       * 一次 POST。
       *
       * 为什么不复用 `readJson`：保存失败时宿主会回一段说明「哪里不合法」的
       * JSON（400/413/500），那段话必须原样显示给用户 —— 只说「保存失败」等于
       * 让人去猜。所以这里先取文本，再尽力解析。
       */
      async function postJson(path, body, timeoutMs = 20000) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(`${API}${path}`, {
            method: 'POST',
            cache: 'no-store',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const raw = await response.text()
          let payload = {}
          if (raw !== '') {
            try {
              payload = JSON.parse(raw)
            } catch {
              payload = {}
            }
          }
          if (!response.ok) {
            const message = typeof payload.error === 'string' && payload.error !== ''
              ? payload.error
              : (raw !== '' ? raw : `HTTP ${response.status}`)
            throw new Error(message)
          }
          return payload
        } finally {
          clearTimeout(timer)
        }
      }

      /** 事件一行的正文。每种类型说什么话，集中在这里。 */
      function eventLine(event, t) {
        const kindLabel = {
          start: t.typeStart,
          skip: t.typeSkip,
          win: t.typeWin,
          exhausted: t.typeExhausted,
          aborted: t.typeAborted,
          probe: t.typeProbe,
        }[event.type] || event.type

        const parts = []
        if (typeof event.candidate === 'string' && event.candidate !== '') {
          parts.push({ key: 'model', text: event.candidate, mono: true })
        }
        if (event.type === 'win') {
          if (Number.isFinite(event.elapsedMs)) parts.push({ key: 'elapsed', text: humanMs(event.elapsedMs) })
          if (Number.isFinite(event.attempts)) parts.push({ key: 'attempts', text: fill(t.attempts, event.attempts) })
        }
        if (event.type === 'probe' && Array.isArray(event.probes)) {
          // 只显示「探通了、按速度排好」的结论，别把每一站的毫秒数堆上去 ——
          // 那行会很长，而用户真正要看的只是「为什么下一个试的是这家」。
          const fast = event.probes.find((probe) => probe.ok === true)
          if (fast !== undefined) {
            parts.push({ key: 'fastest', text: `${fast.provider}/${fast.model}`, mono: true })
            parts.push({ key: 'fastestMs', text: humanMs(Number.isFinite(fast.ms) ? fast.ms : 0) })
          } else {
            parts.push({ key: 'none', text: t.probeNone })
          }
        }

        const failure = event.type === 'skip' && event.failure !== undefined
          ? {
              code: typeof event.failure.code === 'string' ? event.failure.code : t.unknown,
              status: Number.isFinite(event.failure.status) ? event.failure.status : undefined,
              message: typeof event.failure.message === 'string' ? event.failure.message : '',
            }
          : undefined

        return { kindLabel, parts, failure }
      }

      function EventRow({ event, t }) {
        const { kindLabel, parts, failure } = eventLine(event, t)
        return h(
          'div',
          { className: 'dcf-event' },
          h('span', { className: 'dcf-event-time' }, clockTime(event.at)),
          h('span', { className: `dcf-event-kind dcf-kind-${event.type}` }, kindLabel),
          h(
            'div',
            { className: 'dcf-event-body' },
            ...parts.map((part) => h(
              'span',
              { key: part.key, className: part.mono ? 'dcf-event-model' : 'dcf-event-meta' },
              part.text,
            )),
            failure === undefined ? null : h(
              'span',
              { className: 'dcf-event-failure' },
              failure.status === undefined ? failure.code : `${failure.code} · HTTP ${failure.status}`,
            ),
            failure === undefined || failure.message === '' ? null : h(
              'span',
              { className: 'dcf-failure-body' },
              failure.message,
            ),
          ),
        )
      }

      /**
       * 链里的一行：序号 + 模型 + 倍率 + 档位下拉 + 操作按钮。
       *
       * 测试是异步的，状态存在 `Page` 的 `tests` 里（按 `labelOf` 键）：
       * `{phase: 'running'|'ok'|'fail', totalMs?, error?, code?}`。
       * 没有记录 = 还没测过；`running` 期间按钮禁用并显示「测试中…」。
       * 结果以徽章形式长在本行尾部 —— 放在操作按钮之外，避免按钮换行把它挤没。
       *
       * 档位下拉的选项来自 `Page` 里的 `effortsOf(candidate)`（后端 `/efforts`
       * 查该站真实支持的档位）。查不到时给空列表 + 提示，不假装有档位。
       */
      function CandidateRow({
        chainIndex,
        index,
        candidate,
        total,
        editable,
        t,
        onMove,
        onRemove,
        onTest,
        onEffort,
        test,
        effortState,
        rate,
      }) {
        const locked = editable !== true
        const label = labelOf(candidate)
        const running = test !== undefined && test.phase === 'running'
        const efforts = Array.isArray(effortState?.efforts) ? effortState.efforts : []
        // 三态：'' = 没设置（跟随上层）；'auto' = 这一站自动（null）；其余 = 固定档位。
        const effortValue = candidate.reasoningEffort === null
          ? 'auto'
          : typeof candidate.reasoningEffort === 'string'
            ? candidate.reasoningEffort
            : ''
        const effortTitle = effortState?.phase === 'loading' ? t.effortLoading : efforts.length === 0 ? t.effortUnsupported : t.effortHint
        return h(
          'div',
          { className: index === 0 ? 'dcf-row dcf-row-primary' : 'dcf-row' },
          h('span', { className: 'dcf-row-index' }, String(index + 1)),
          h(
            'div',
            { className: 'dcf-row-main' },
            h(
              'span',
              { className: 'dcf-row-model' },
              candidate.model,
              typeof rate?.rate === 'string' && rate.rate !== '' && h('span', { className: 'dcf-rate', title: rate.rateLabel ?? t.rate }, ` ${rate.rate}`),
            ),
            h(
              'span',
              { className: 'dcf-row-sub' },
              h('span', { className: 'dcf-tag' }, index === 0 ? t.priority : t.fallback),
              ' ',
              candidate.provider,
            ),
          ),
          h(
            'select',
            {
              className: 'dcf-select dcf-effort',
              title: effortTitle,
              value: effortValue,
              disabled: locked || efforts.length === 0,
              onChange: (event) => onEffort(chainIndex, index, event.target.value),
            },
            h('option', { value: '' }, t.effortDefault),
            h('option', { value: 'auto' }, t.effortAuto),
            ...efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)),
          ),
          h(
            'div',
            { className: 'dcf-row-actions' },
            test !== undefined && test.phase === 'ok' && h(
              'span',
              { className: 'dcf-test-badge dcf-test-ok', title: `${t.test} ${label}` },
              fill(t.testOk, humanMs(test.totalMs ?? 0)),
            ),
            test !== undefined && test.phase === 'fail' && h(
              'span',
              { className: 'dcf-test-badge dcf-test-fail', title: test.error ?? label },
              fill(t.testFail, typeof test.code === 'string' && test.code !== '' ? test.code : (test.error ?? '')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn dcf-btn-mini',
                title: t.testHint,
                disabled: locked || running,
                onClick: () => onTest(candidate),
              },
              running ? t.testing : t.test,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn dcf-btn-mini',
                title: t.moveUp,
                disabled: locked || index === 0,
                onClick: () => onMove(chainIndex, index, -1),
              },
              '↑',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn dcf-btn-mini',
                title: t.moveDown,
                disabled: locked || index === total - 1,
                onClick: () => onMove(chainIndex, index, 1),
              },
              '↓',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn dcf-btn-mini dcf-btn-danger',
                title: t.remove,
                // v0.5.0 起链允许没有候选（面板会提示「先加一个」），
                // 所以这里不再因为「只剩一个」而禁用 —— 用户可以清空重配。
                disabled: locked,
                onClick: () => onRemove(chainIndex, index),
              },
              t.remove,
            ),
          ),
        )
      }

      /** 添加模型的浮层：渠道筛选 + 模型清单。 */
      function Picker({ pickerState, provider, t, taken, onPickProvider, onAdd, onClose }) {
        if (pickerState.phase === 'loading') {
          return h(
            'div',
            { className: 'dcf-picker' },
            h('div', { className: 'dcf-picker-head' },
              h('span', { className: 'dcf-picker-title' }, t.pickerTitle),
              h('button', { type: 'button', className: 'dcf-btn dcf-btn-mini', onClick: onClose }, t.pickerClose)),
            h('p', { className: 'dcf-note' }, t.pickerLoading),
          )
        }
        if (pickerState.phase === 'error') {
          return h(
            'div',
            { className: 'dcf-picker' },
            h('div', { className: 'dcf-picker-head' },
              h('span', { className: 'dcf-picker-title' }, t.pickerTitle),
              h('button', { type: 'button', className: 'dcf-btn dcf-btn-mini', onClick: onClose }, t.pickerClose)),
            h('p', { className: 'dcf-note dcf-bar-error' }, pickerState.error),
          )
        }

        const models = Array.isArray(pickerState.models) ? pickerState.models : []
        const failed = Array.isArray(pickerState.failed) ? pickerState.failed : []
        const providers = []
        for (const model of models) {
          if (!providers.includes(model.provider)) providers.push(model.provider)
        }
        providers.sort()
        const visible = provider === undefined ? models : models.filter((model) => model.provider === provider)

        return h(
          'div',
          { className: 'dcf-picker' },
          h('div', { className: 'dcf-picker-head' },
            h('span', { className: 'dcf-picker-title' }, t.pickerTitle),
            h('button', { type: 'button', className: 'dcf-btn dcf-btn-mini', onClick: onClose }, t.pickerClose)),
          h(
            'div',
            { className: 'dcf-chips' },
            h(
              'button',
              {
                type: 'button',
                className: provider === undefined ? 'dcf-chip dcf-chip-on' : 'dcf-chip',
                onClick: () => onPickProvider(undefined),
              },
              t.pickerFilterAll,
            ),
            ...providers.map((id) => h(
              'button',
              {
                key: id,
                type: 'button',
                className: provider === id ? 'dcf-chip dcf-chip-on' : 'dcf-chip',
                onClick: () => onPickProvider(id),
              },
              id,
            )),
          ),
          failed.length === 0 ? null : h(
            'p',
            { className: 'dcf-note dcf-bar-warn' },
            fill(t.pickerFailed, failed.map((entry) => entry.provider).join(', ')),
          ),
          visible.length === 0
            ? h('p', { className: 'dcf-note' }, t.pickerEmpty)
            : h(
              'div',
              { className: 'dcf-models' },
              ...visible.map((model) => {
                const added = taken.has(labelOf(model))
                return h(
                  'div',
                  { key: labelOf(model), className: 'dcf-model' },
                  h(
                    'div',
                    { className: 'dcf-model-main' },
                    h('span', { className: 'dcf-model-id' }, model.model),
                    h('span', { className: 'dcf-model-where' }, model.provider),
                    model.name === undefined || model.name === model.model
                      ? null
                      : h('span', { className: 'dcf-model-name' }, model.name),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dcf-btn dcf-btn-mini',
                      disabled: added,
                      onClick: () => onAdd(model),
                    },
                    added ? t.pickerAdded : t.addModel,
                  ),
                )
              }),
            ),
        )
      }

      function Tile({ value, label, hint }) {
        return h(
          'div',
          { className: 'dcf-tile' },
          h('div', { className: 'dcf-tile-value' }, String(value)),
          h('div', { className: 'dcf-tile-label' }, label),
          hint === undefined ? null : h('div', { className: 'dcf-tile-hint' }, hint),
        )
      }

      function Page() {
        const t = text()
        const [phase, setPhase] = React.useState('loading')
        const [snapshot, setSnapshot] = React.useState(undefined)
        const [draft, setDraft] = React.useState(undefined)
        const [picker, setPicker] = React.useState(undefined)
        const [pickerState, setPickerState] = React.useState({ phase: 'idle' })
        const [savePhase, setSavePhase] = React.useState('idle')
        const [resetArmed, setResetArmed] = React.useState(false)
        // 连通测试的状态，按 `labelOf(candidate)` 键：
        // `{phase: 'running'|'ok'|'fail', totalMs?, error?, code?}`。
        // 键在测试结束后保留 —— 徽章一直显示，直到同一行再测一次。
        const [tests, setTests] = React.useState({})
        // 每个候选支持的推理档位，按 `labelOf(candidate)` 键：
        // `{phase: 'loading'|'ready', efforts: [{id,name}], defaultEffort?, error?}`。
        // 后端 `/efforts` 查不到就 `error` 有值 —— 此时下拉是空的，不假装有档位。
        const [efforts, setEfforts] = React.useState({})

        const load = React.useCallback(async () => {
          setPhase((current) => (current === 'ready' ? 'refreshing' : 'loading'))
          try {
            const next = await readJson('/state')
            setSnapshot(next)
            setDraft(cloneChains(next.chains))
            setPhase('ready')
            setSavePhase('idle')
            setResetArmed(false)
            setEfforts({})
          } catch (error) {
            setSnapshot(undefined)
            setDraft(undefined)
            setPhase(`error:${error instanceof Error ? error.message : String(error)}`)
          }
        }, [])

        React.useEffect(() => {
          void load()
        }, [load])

        const busy = phase === 'loading' || phase === 'refreshing'
        const saving = savePhase === 'saving'

        // 编辑动作全部走函数式更新：连续点两下「下移」不会互相吞掉。
        const editCandidates = (chainIndex, fn) => {
          setDraft((current) => {
            if (!Array.isArray(current)) return current
            return current.map((chain, index) => (
              index === chainIndex ? { ...chain, candidates: fn(chain.candidates) } : chain
            ))
          })
          setSavePhase('idle')
        }

        /** 改整条链（链名、链级档位）—— 和改候选分开，语义不同。 */
        const editChain = (chainIndex, patch) => {
          setDraft((current) => {
            if (!Array.isArray(current)) return current
            return current.map((chain, index) => (index === chainIndex ? { ...chain, ...patch } : chain))
          })
          setSavePhase('idle')
        }

        /**
         * 改链名要同时换 id：id 就是模型选择器里的 model id，同名不同 id
         * 会让选择器里出现两个看不出区别的条目。新 id 由 `nextChainId`
         * 按新名字 slug 出来并避开已有 id。
         */
        const renameChain = (chainIndex, value) => {
          setDraft((current) => {
            if (!Array.isArray(current)) return current
            const next = current.map((chain, index) => (index === chainIndex ? { ...chain, name: value } : chain))
            const renamed = { ...next[chainIndex], id: nextChainId(value, next.filter((_, at) => at !== chainIndex)) }
            next[chainIndex] = renamed
            return next
          })
          setSavePhase('idle')
        }

        const addChain = () => {
          setDraft((current) => {
            const list = Array.isArray(current) ? current : []
            const name = fill(t.newChainName, list.length + 1)
            const chain = { id: nextChainId(name, list), name, candidates: [] }
            return [...list, chain]
          })
          setSavePhase('idle')
        }

        const removeChain = (chainIndex) => {
          setDraft((current) => {
            if (!Array.isArray(current) || current.length <= 1) return current
            return current.filter((_, index) => index !== chainIndex)
          })
          setSavePhase('idle')
        }

        const moveCandidate = (chainIndex, index, delta) => {
          editCandidates(chainIndex, (list) => {
            const target = index + delta
            if (target < 0 || target >= list.length) return list
            const next = list.slice()
            const [moved] = next.splice(index, 1)
            next.splice(target, 0, moved)
            return next
          })
        }

        const removeCandidate = (chainIndex, index) => {
          editCandidates(chainIndex, (list) => list.filter((_, at) => at !== index))
        }

        /**
         * 改某一站固定的档位。
         *
         * 三态：
         *   · `''`   → 删掉字段（不指定，跟随链级/调用方）；
         *   · `'auto'` → 存成 `null`（这一站用它自己的默认档位，不再往下继承）；
         *   · 其它   → 固定档位 id。
         */
        const setCandidateEffort = (chainIndex, index, value) => {
          editCandidates(chainIndex, (list) => list.map((candidate, at) => {
            if (at !== index) return candidate
            const next = { ...candidate }
            if (value === '') delete next.reasoningEffort
            else if (value === 'auto') next.reasoningEffort = null
            else next.reasoningEffort = value
            return next
          }))
        }

        /** 改链级档位；三态同上（`'auto'` → `null` = 整条链自动）。 */
        const setChainEffort = (chainIndex, value) => {
          setDraft((current) => {
            if (!Array.isArray(current)) return current
            return current.map((chain, index) => {
              if (index !== chainIndex) return chain
              const next = { ...chain }
              if (value === '') delete next.reasoningEffort
              else if (value === 'auto') next.reasoningEffort = null
              else next.reasoningEffort = value
              return next
            })
          })
          setSavePhase('idle')
        }

        /** 开关「切换前测速」。 */
        const setSpeedProbe = (chainIndex, on) => {
          setDraft((current) => {
            if (!Array.isArray(current)) return current
            return current.map((chain, index) => {
              if (index !== chainIndex) return chain
              const next = { ...chain }
              if (on) next.speedProbe = true
              else delete next.speedProbe
              return next
            })
          })
          setSavePhase('idle')
        }

        /**
         * 懒查某一站支持的档位（`GET /efforts?provider=&model=`）。
         *
         * 查过就缓存（键是 `labelOf`）；查失败也缓存，`error` 里带原因，
         * 这样用户能看到「查不到」而不是一个永远转圈的下拉。
         */
        const loadEfforts = async (candidate) => {
          const key = labelOf(candidate)
          setEfforts((current) => (current[key] === undefined ? { ...current, [key]: { phase: 'loading', efforts: [] } } : current))
          try {
            const query = `?provider=${encodeURIComponent(candidate.provider)}&model=${encodeURIComponent(candidate.model)}`
            const data = await readJson(`/efforts${query}`, 15000)
            setEfforts((current) => ({
              ...current,
              [key]: {
                phase: 'ready',
                efforts: Array.isArray(data.efforts) ? data.efforts : [],
                defaultEffort: typeof data.defaultEffort === 'string' ? data.defaultEffort : undefined,
                error: typeof data.error === 'string' ? data.error : undefined,
              },
            }))
          } catch (error) {
            setEfforts((current) => ({
              ...current,
              [key]: { phase: 'ready', efforts: [], error: error?.message ?? String(error) },
            }))
          }
        }

        /**
         * 面板一有链，就把所有候选的档位查一遍（串行 —— 后端每个查询都要
         * 打一次上游 `resolveModelInfo`，并发会一起超时）。
         */
        React.useEffect(() => {
          if (!Array.isArray(draft)) return undefined
          let cancelled = false
          void (async () => {
            for (const chain of draft) {
              for (const candidate of chain.candidates ?? []) {
                if (cancelled) return
                if (typeof candidate?.provider !== 'string' || typeof candidate?.model !== 'string') continue
                if (efforts[labelOf(candidate)] !== undefined) continue
                await loadEfforts(candidate)
              }
            }
          })()
          return () => {
            cancelled = true
          }
        }, [draft, efforts])

        /**
         * 连通测试：POST /test，成功/失败都长成徽章。
         *
         * 用 `labelOf` 当键 —— 同一模型的旧结果被新一轮测试覆盖；
         * `running` 状态下按钮禁用（后端还有 409 护栏兜底）。
         */
        const testCandidate = async (candidate) => {
          const key = labelOf(candidate)
          setTests((current) => ({ ...current, [key]: { phase: 'running' } }))
          try {
            const data = await postJson('/test', { provider: candidate.provider, model: candidate.model })
            setTests((current) => ({
              ...current,
              [key]: data.ok === true
                ? { phase: 'ok', totalMs: data.totalMs }
                : { phase: 'fail', error: data.error, code: data.code },
            }))
          } catch (error) {
            // `.message` 优先：跨 realm（测试替身）抛来的 Error 不吃
            // `instanceof Error`，但 `.message` 照样在；真浏览器里两者等价。
            setTests((current) => ({
              ...current,
              [key]: { phase: 'fail', error: error?.message ?? String(error) },
            }))
          }
        }

        const openPicker = async (chainIndex) => {
          setPicker({ chainIndex, provider: undefined })
          setPickerState({ phase: 'loading' })
          try {
            const data = await readJson('/models', 30000)
            setPickerState({
              phase: 'ready',
              models: Array.isArray(data.models) ? data.models : [],
              failed: Array.isArray(data.failed) ? data.failed : [],
            })
          } catch (error) {
            setPickerState({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
          }
        }

        const addCandidate = (model) => {
          if (picker === undefined) return
          editCandidates(picker.chainIndex, (list) => {
            if (list.some((candidate) => labelOf(candidate) === labelOf(model))) return list
            return [...list, { provider: model.provider, model: model.model }]
          })
          setPicker(undefined)
          setPickerState({ phase: 'idle' })
        }

        const save = async () => {
          if (!Array.isArray(draft)) return
          setSavePhase('saving')
          setResetArmed(false)
          try {
            const next = await postJson('/chains', { chains: draft })
            setSnapshot(next)
            setDraft(cloneChains(next.chains))
            setSavePhase('saved')
          } catch (error) {
            setSavePhase(`error:${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const restore = async () => {
          setSavePhase('saving')
          setResetArmed(false)
          try {
            const next = await postJson('/chains', { reset: true })
            setSnapshot(next)
            setDraft(cloneChains(next.chains))
            setSavePhase('saved')
          } catch (error) {
            setSavePhase(`error:${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const header = h(
          'div',
          { className: 'dcf-head' },
          h(
            'div',
            {},
            h('h2', { className: 'dcf-title' }, t.title),
            h('p', { className: 'dcf-intro' }, t.intro),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dcf-btn',
              onClick: () => void load(),
              disabled: busy || saving,
            },
            phase === 'refreshing' ? t.refreshing : t.refresh,
          ),
        )

        if (phase === 'loading') {
          return h('div', { className: 'dcf-page' }, header, h('p', { className: 'dcf-note' }, t.refreshing))
        }

        if (typeof phase === 'string' && phase.startsWith('error:')) {
          return h(
            'div',
            { className: 'dcf-page' },
            header,
            h(
              'div',
              { className: 'dcf-error' },
              h('p', { className: 'dcf-error-title' }, `${t.loadFailed} —— ${phase.slice(6)}`),
              h('p', { className: 'dcf-error-hint' }, t.loadFailedHint),
            ),
          )
        }

        if (snapshot === undefined) {
          return h('div', { className: 'dcf-page' }, header, h('p', { className: 'dcf-note' }, t.loadFailed))
        }

        if (snapshot.enabled === false) {
          return h(
            'div',
            { className: 'dcf-page' },
            header,
            h('div', { className: 'dcf-error' }, h('p', { className: 'dcf-error-title' }, t.disabled)),
          )
        }

        const totals = snapshot.totals ?? {}
        const chains = Array.isArray(draft) ? draft : cloneChains(snapshot.chains)
        const events = Array.isArray(snapshot.events) ? snapshot.events.slice().reverse() : []
        const baseline = JSON.stringify(cloneChains(snapshot.chains))
        const dirty = JSON.stringify(chains) !== baseline
        const editable = snapshot.editable === true

        const taken = new Set()
        if (picker !== undefined && Array.isArray(chains[picker.chainIndex]?.candidates)) {
          for (const candidate of chains[picker.chainIndex].candidates) taken.add(labelOf(candidate))
        }

        // 倍率来自后端快照（`publicChains` 把渠道显示名里的「x0.08」解析出来
        // 挂在候选上）。草稿会丢掉这些只读字段，所以按 `provider/model` 建索引。
        const rates = {}
        for (const chain of Array.isArray(snapshot.chains) ? snapshot.chains : []) {
          for (const candidate of Array.isArray(chain?.candidates) ? chain.candidates : []) {
            if (typeof candidate?.provider !== 'string' || typeof candidate?.model !== 'string') continue
            rates[`${candidate.provider}/${candidate.model}`] = candidate
          }
        }

        /**
         * 一条链可选的档位 = 链上各站支持档位的并集。
         *
         * 为什么不只取链头：链级档位要在每一站都合法，否则切到某一站就被宿主
         * 以 `UNSUPPORTED_REASONING_EFFORT` 拒掉。取并集至少能让用户看见全貌，
         * 具体哪站不支持由 `pickEffort` 在运行时降级。
         */
        const chainEffortsOf = (chain) => {
          const merged = new Map()
          for (const candidate of Array.isArray(chain?.candidates) ? chain.candidates : []) {
            const state = efforts[labelOf(candidate)]
            for (const effort of Array.isArray(state?.efforts) ? state.efforts : []) {
              if (typeof effort?.id === 'string' && effort.id !== '' && !merged.has(effort.id)) merged.set(effort.id, effort)
            }
          }
          return [...merged.values()]
        }

        // 保存结果与「有未保存改动」是两件事，可以同时为真：保存失败了，草稿
        // 仍然脏。把失败原因盖住「有改动」会让人以为改动没了，所以并排显示。
        const saveNote = (() => {
          if (typeof savePhase === 'string' && savePhase.startsWith('error:')) {
            return {
              className: 'dcf-bar-note dcf-bar-error',
              text: dirty ? `${savePhase.slice(6)} · ${t.dirtyHint}` : savePhase.slice(6),
            }
          }
          if (savePhase === 'saved') return { className: 'dcf-bar-note dcf-bar-ok', text: t.savedOk }
          if (dirty) return { className: 'dcf-bar-note dcf-bar-warn', text: t.dirtyHint }
          return undefined
        })()

        const sourceNote = snapshot.source === 'file'
          ? `${t.sourceFile}${snapshot.savedAt === undefined ? '' : ` · ${fill(t.savedAt, stampTime(snapshot.savedAt))}`}`
          : t.sourceConfig

        return h(
          'div',
          { className: 'dcf-page' },
          header,

          h(
            'p',
            { className: 'dcf-note' },
            sourceNote,
            ' · ',
            fill(t.revision, Number.isFinite(snapshot.revision) ? snapshot.revision : 0),
            snapshot.file === undefined ? null : h('span', { className: 'dcf-mono' }, ` · ${t.file}: ${snapshot.file}`),
          ),

          h(
            'div',
            { className: 'dcf-section' },
            h(
              'div',
              { className: 'dcf-section-bar' },
              h('h3', { className: 'dcf-section-title' }, t.chainTitle),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dcf-btn dcf-btn-mini',
                  disabled: !editable || saving,
                  onClick: addChain,
                },
                t.newChain,
              ),
            ),
            h('p', { className: 'dcf-note' }, t.howto),
            chains.length === 0
              ? h('p', { className: 'dcf-note' }, t.noChains)
              : h(
                'div',
                { className: 'dcf-section' },
                ...chains.map((chain, chainIndex) => {
                  const chainEfforts = chainEffortsOf(chain)
                  return h(
                  'div',
                  { key: `${chain.id ?? chain.name}-${chainIndex}`, className: 'dcf-card' },
                  h(
                    'div',
                    { className: 'dcf-chain-head' },
                    h('input', {
                      type: 'text',
                      className: 'dcf-input dcf-chain-name',
                      value: chain.name,
                      title: t.chainNameHint,
                      placeholder: t.chainName,
                      disabled: !editable || saving,
                      onChange: (event) => renameChain(chainIndex, event.target.value),
                    }),
                    h(
                      'select',
                      {
                        className: 'dcf-select dcf-chain-effort',
                        title: t.effortHint,
                        value: chain.reasoningEffort === null
                          ? 'auto'
                          : typeof chain.reasoningEffort === 'string'
                            ? chain.reasoningEffort
                            : '',
                        disabled: !editable || saving || chainEfforts.length === 0,
                        onChange: (event) => setChainEffort(chainIndex, event.target.value),
                      },
                      h('option', { value: '' }, t.effortDefault),
                      h('option', { value: 'auto' }, t.effortAuto),
                      ...chainEfforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)),
                    ),
                    h(
                      'label',
                      {
                        className: 'dcf-check',
                        title: t.speedProbeHint,
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: chain.speedProbe === true,
                        disabled: !editable || saving,
                        onChange: (event) => setSpeedProbe(chainIndex, event.target.checked),
                      }),
                      ` ${t.speedProbe}`,
                    ),
                    h('span', { className: 'dcf-chain-meta' }, chain.candidates.map((candidate) => candidate.provider).join(' → ')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dcf-btn dcf-btn-mini dcf-btn-danger',
                        title: chains.length <= 1 ? t.onlyOneChain : t.deleteChain,
                        disabled: !editable || saving || chains.length <= 1,
                        onClick: () => removeChain(chainIndex),
                      },
                      // 链的删除按钮用独立文案：候选行里也有一个「删除」，
                      // 同名按钮并排会让用户（和探针）分不清删的是哪个。
                      t.deleteChain,
                    ),
                  ),
                  chain.candidates.length === 0
                    ? h('p', { className: 'dcf-note' }, t.noCandidate)
                    : h(
                      'div',
                      { className: 'dcf-section' },
                      ...chain.candidates.map((candidate, index) => h(CandidateRow, {
                        key: `${chainIndex}-${index}-${labelOf(candidate)}`,
                        chainIndex,
                        index,
                        candidate,
                        total: chain.candidates.length,
                        editable,
                        t,
                        onMove: moveCandidate,
                        onRemove: removeCandidate,
                        onTest: (c) => void testCandidate(c),
                        onEffort: setCandidateEffort,
                        test: tests[labelOf(candidate)],
                        effortState: efforts[labelOf(candidate)],
                        rate: rates[labelOf(candidate)],
                      })),
                    ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dcf-btn dcf-add',
                      disabled: !editable || saving || picker !== undefined,
                      onClick: () => void openPicker(chainIndex),
                    },
                    t.addModel,
                  ),
                  picker !== undefined && picker.chainIndex === chainIndex
                    ? h(Picker, {
                      pickerState,
                      provider: picker.provider,
                      t,
                      taken,
                      onPickProvider: (provider) => setPicker((current) => (current === undefined ? current : { ...current, provider })),
                      onAdd: addCandidate,
                      onClose: () => {
                        setPicker(undefined)
                        setPickerState({ phase: 'idle' })
                      },
                    })
                    : null,
                  )
                }),
              ),
          ),

          h(
            'div',
            { className: 'dcf-bar' },
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn dcf-btn-primary',
                disabled: !editable || saving || !dirty,
                onClick: () => void save(),
              },
              saving ? t.saving : t.save,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn',
                disabled: !editable || saving || !dirty,
                onClick: () => {
                  setDraft(cloneChains(snapshot.chains))
                  setSavePhase('idle')
                },
              },
              t.discard,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn',
                disabled: !editable || saving || resetArmed,
                onClick: () => setResetArmed(true),
              },
              t.restore,
            ),
            saveNote === undefined ? null : h('span', { className: saveNote.className }, saveNote.text),
          ),

          resetArmed
            ? h(
              'div',
              { className: 'dcf-confirm' },
              h('span', {}, t.restoreConfirm),
              h('button', { type: 'button', className: 'dcf-btn dcf-btn-danger dcf-btn-mini', onClick: () => void restore() }, t.restoreYes),
              h('button', { type: 'button', className: 'dcf-btn dcf-btn-mini', onClick: () => setResetArmed(false) }, t.restoreNo),
            )
            : null,

          h(
            'div',
            { className: 'dcf-section' },
            h('h3', { className: 'dcf-section-title' }, t.statsTitle),
            h(
              'div',
              { className: 'dcf-tiles' },
              h(Tile, { key: 'requests', value: totals.requests ?? 0, label: t.requests }),
              h(Tile, { key: 'switches', value: totals.switches ?? 0, label: t.switches }),
              h(Tile, { key: 'wins', value: totals.wins ?? 0, label: t.wins }),
              h(Tile, { key: 'exhausted', value: totals.exhausted ?? 0, label: t.exhausted }),
              h(Tile, { key: 'aborted', value: totals.aborted ?? 0, label: t.aborted }),
              h(Tile, {
                key: 'passthrough',
                value: totals.passthrough ?? 0,
                label: t.passthrough,
                hint: t.passthroughHint,
              }),
            ),
          ),

          h(
            'div',
            { className: 'dcf-section' },
            h('h3', { className: 'dcf-section-title' }, t.eventsTitle),
            events.length === 0
              ? h('p', { className: 'dcf-note' }, t.noEvents)
              : h(
                'div',
                { className: 'dcf-events' },
                ...events.map((event, index) => h(EventRow, { key: `${event.at}-${index}`, event, t })),
              ),
            h(
              'p',
              { className: 'dcf-note' },
              fill(t.eventsLimit, snapshot.maxEvents ?? 0),
              ' · ',
              snapshot.logEnabled === true ? t.logOn : `${t.logOff}（${t.logHint}）`,
            ),
          ),
        )
      }

      // `apply` 在 IIFE 顶层，需要把组件与 createElement 递给它。
      window.__channelFallback = { Page, h }

      return { name, inject, apply }
    },
  })
})()
