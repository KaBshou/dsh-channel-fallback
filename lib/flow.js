/**
 * 流收尾的两个小工具。
 *
 * 这两个函数以前住在 `index.js` 里，现在链的执行搬到了虚拟 provider
 * （`provider.js`），两边都要用，就提到这个独立的小文件里 —— 免得为了
 * 共享几行代码而让 provider 反过来依赖 index（那会绕成环）。
 *
 * 这个文件刻意不 import 任何 DSH 内部包：插件目录被 Junction 链进 profile
 * 的 node_modules，能否解析宿主包取决于宿主版本，刻意不 import 才稳。
 */

/**
 * 把迭代器剩下的内容原样吐出去。
 *
 * 显式 `for(;;)` 而不是 `for await`：`for await` 在调用方 break 时会自动
 * 调 `return()`，看起来更省事，但那样一来「调用方正常打断」和「上游报错」
 * 就走同一条路了，这里要自己控制收尾。
 *
 * **`finally` 是必须的**：一旦开始回答，收尾责任就落到这里。消费方若提前
 * `break` / 抛错，这个 generator 会被 `return()`，`finally` 里的
 * `closeQuietly` 才是唯一能关掉上游 HTTP 流的地方 —— 少了它，socket 会一直
 * 跑到流自然结束。
 *
 * @param {AsyncIterator<any>} iterator
 * @returns {AsyncGenerator<any>}
 */
export async function* restOf(iterator) {
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    await closeQuietly(iterator);
  }
}

/**
 * 关掉上游迭代器；关不掉也不该掩盖真正的失败。
 *
 * @param {AsyncIterator<any>|undefined} iterator
 */
export async function closeQuietly(iterator) {
  const close = iterator?.return;
  if (typeof close !== 'function') return;
  try {
    await close.call(iterator);
  } catch {
    // 忽略：我们要么已经有更重要的失败要上报，要么已经成功返回。
  }
}
