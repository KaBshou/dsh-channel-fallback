/**
 * 链配置的**可写**持久层。
 *
 * 为什么自己存一份 JSON，而不是回写 `cordis.patch.yml`：
 *
 *   ① `cordis.patch.yml` 是**用户手写的、带注释的**配置文件。机械回写会吃掉注释、
 *      打乱顺序，而 DSH 的 patch 文件里还夹着别的插件条目（qq-bridge 那段明确写着
 *      「会被整体替换，请勿手工编辑内部条目」）。让面板去改它，等于让一个 UI 动作
 *      拥有破坏整份 profile 配置的能力 —— 代价远大于收益。
 *   ② 官方没有「插件写回自己的 config」的机制：config 是启动时的只读输入。
 *      本机两个先例都是「自己在 `~/.dsh/<插件名>/` 下存状态文件」：
 *        · `~/.dsh/channel-pack/state.json`（账号开关）
 *        · `~/.dsh/our-free-model/settings.json`（combos）
 *      本模块照同一套路走。
 *   ③ 于是规则很清楚：**配置文件是默认值，状态文件是用户覆盖**。删掉状态文件
 *      就回到配置文件的样子（面板上那个「恢复默认」按钮做的就是这件事）。
 *
 * 写盘用「临时文件 + rename」：rename 是原子的，中途断电最多留下一个临时文件，
 * 不会出现半截 JSON 把插件配置读崩。
 *
 * 所有读函数**永不抛错**：配置读坏了最坏是回到默认链，绝不能让插件起不来。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 状态文件格式版本。将来改结构时靠它判断要不要迁移。 */
export const STATE_VERSION = 1;

/** 单次请求体上限（面板只保存几十个候选，64KB 绰绰有余）。 */
export const MAX_BODY_BYTES = 65536;

/**
 * 状态文件路径。
 *
 * 允许用 `DSH_CHANNEL_FALLBACK_STATE` 覆盖 —— 探针要在临时目录里跑真实读写，
 * 不能碰用户真正的配置。
 *
 * @returns {string}
 */
export function stateFilePath() {
  const override = process.env.DSH_CHANNEL_FALLBACK_STATE;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh', 'channel-fallback', 'chains.json');
}

/**
 * 读状态文件。
 *
 * 三种结果刻意分开，调用方才能决定要不要吭声：
 *   · `missing` —— 用户还没在面板上保存过，正常的初始状态；
 *   · `ok` —— 读到了；
 *   · `invalid` —— 文件在但读不懂（手改坏了 / 半截 JSON），值得记一条日志。
 *
 * @param {string} file
 * @returns {{kind: 'missing'|'ok'|'invalid', chains?: unknown, updatedAt?: string, reason?: string}}
 */
export function readChainFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'invalid', reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 宽容两种写法：完整信封 `{version, chains}` 和裸数组 `[...]`（手写起来方便）。
  const chains = Array.isArray(parsed) ? parsed : parsed?.chains;
  if (!Array.isArray(chains)) {
    return { kind: 'invalid', reason: '文件里没有 chains 数组' };
  }
  const updatedAt = typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined;
  return { kind: 'ok', chains, ...(updatedAt === undefined ? {} : { updatedAt }) };
}

/**
 * 原子写状态文件。
 *
 * @param {string} file
 * @param {ReadonlyArray<object>} chains - **已经归一化过**的链。
 * @param {{now?: () => number}} [options]
 * @throws 写入失败时抛错（调用方要如实报给用户，不能假装保存成功）
 */
export function writeChainFile(file, chains, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const payload = {
    version: STATE_VERSION,
    updatedAt: new Date(now()).toISOString(),
    chains,
  };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    // 临时文件留着没意义，清掉；清不掉也不影响原始错误的报告。
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
  return payload.updatedAt;
}

/**
 * 删掉状态文件（= 恢复成配置文件里的链）。
 *
 * @param {string} file
 * @returns {boolean} 是否真的删掉了（本来就不存在时为 false）
 */
export function removeChainFile(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 校验并归一化一份「面板提交上来的链」。
 *
 * 这里**不静默丢弃**任何东西 —— 这是用户点「保存」时提交的数据，悄悄丢掉一个
 * 候选会让用户以为保存成功了、实际链路少了一站。任何不合法都必须变成一条
 * 明确的错误让 UI 显示出来。
 *
 * @param {unknown} body - 请求体（已 JSON.parse）。
 * @param {(raw: unknown, options: object) => Array<object>} normalize - `normalizeChains`。
 * @returns {{ok: true, chains: Array<object>} | {ok: false, error: string}}
 */
export function parseChainsPayload(body, normalize) {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  if (body.reset === true) return { ok: true, chains: [], reset: true };

  const raw = body.chains;
  if (!Array.isArray(raw)) return { ok: false, error: 'chains 必须是数组' };
  if (raw.length === 0) return { ok: false, error: '至少要有一条链' };

  let submitted = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const label = `第 ${index + 1} 条链`;
    if (entry === null || typeof entry !== 'object') return { ok: false, error: `${label}不是对象` };
    const list = Array.isArray(entry.candidates) ? entry.candidates : entry.chain;
    if (!Array.isArray(list)) return { ok: false, error: `${label}缺少 candidates 数组` };
    // 单候选是合法的（面板允许删到只剩一个），但**零候选**说明链已经空了。
    if (list.length === 0) return { ok: false, error: `${label}没有任何候选模型` };
    for (const item of list) {
      if (item === null || typeof item !== 'object') return { ok: false, error: `${label}里有非对象的候选` };
      const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
      const model = typeof item.model === 'string' ? item.model.trim() : '';
      if (provider === '' || model === '') return { ok: false, error: `${label}里有候选缺 provider 或 model` };
      submitted += 1;
    }
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    return { ok: false, error: 'name 必须是字符串' };
  }

  const chains = normalize(raw, { minCandidates: 1 });
  if (chains.length !== raw.length) {
    return { ok: false, error: `有 ${raw.length - chains.length} 条链归一化后不成立（可能缺候选或 head 非法）` };
  }
  const kept = chains.reduce((sum, chain) => sum + chain.candidates.length, 0);
  if (kept !== submitted) {
    return {
      ok: false,
      error: `有 ${submitted - kept} 个候选归一化后被合并或丢弃（相邻同名候选会合并）`,
    };
  }
  return { ok: true, chains };
}
