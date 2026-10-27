// 面板 API 的请求信任栅栏。
//
// 为什么需要它（这一条是本插件的真实安全边界，别删）：
//
//   webServer 的路由匹配是「先 exact、再**最长前缀**、最后 fallback」
//   （`dsh-host-webserver/lib/index.js:494-501`）。我们注册的前缀
//   `/api/channel-fallback` 比内核自己的 `/api` **更长**，所以我们的 handler
//   会比 `client-connection` 的准入检查**先跑** —— 也就是说，如果这里不做任何
//   检查，任何能连到 127.0.0.1 的进程（以及被 DNS rebinding 骗进本机环回的
//   网页）都能读到面板快照。
//
//   `dsh-our-free-model/src/trust.js` 的注释把同一个坑写得很清楚：
//   「The plugin registers a prefix *longer* than the kernel's `/api`, and
//   webServer dispatch is longest-prefix-wins — so these routes run before the
//   connection service's own admission check and would otherwise answer any
//   loopback caller.」
//
// 两层，按顺序尝试：
//
//   1. 组合里有 `connection` 服务时，直接用它的 `admit()` —— 那正是内核给
//      `/api` 路由用的同一个决定（Host/Origin 栅栏 + 浏览器认证 cookie），
//      所以面板的强度**不低于**应用本身。
//   2. 没有该服务时（精简组合、单测、嵌入式宿主），退到结构复刻版栅栏：
//      只认环回 Host、拒绝 `sec-fetch-site: cross-site`、并且客户端若带了
//      `Origin`/`Referer`，其 authority 必须与 `Host` 一致（桌面端
//      `dsh-app://app` 那个转发 Referer 是唯一例外）。
//
// 注意 `connection` 可能在本插件加载之后才发布，所以调用方传进来的是
// **每次请求都重新求值的 thunk**，不要把服务实例抓一次存起来 ——
// 那会让栅栏永远停留在「服务不存在」的状态。

/** 同机调用方可以合法使用的 Host 名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/**
 * 判定一个请求。返回要拒绝的 HTTP 状态码，放行则返回 `undefined`。
 *
 * @param {{admit?: Function, requestRejection?: Function}|undefined} connection
 *   `connection` 服务（或它的 thunk 求值结果）。
 * @param {{headers?: Record<string, unknown>}} req
 * @returns {number|undefined}
 */
export function rejectionFor(connection, req) {
  try {
    const admit = connection?.admit;
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req);
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined;
      return status === undefined ? undefined : status;
    }
    // dsh 0.1.7 之前的拼写：同一个决定叫 `requestRejection`，直接返回裸状态码。
    const reject = connection?.requestRejection;
    if (typeof reject === 'function') {
      const status = reject.call(connection, req);
      return status === undefined ? undefined : status;
    }
  } catch {
    // 服务已挂载却读失败时**绝不能放行** —— 那等于把浏览器认证关掉。
    return 503;
  }
  return structuralRejection(req);
}

/**
 * 结构复刻版栅栏：没有 `connection` 服务时的兜底。
 *
 * @param {{headers?: Record<string, unknown>}} req
 * @returns {number|undefined}
 */
export function structuralRejection(req) {
  return structuralReason(req) === undefined ? undefined : 403;
}

/**
 * @param {{headers?: Record<string, unknown>}} req
 * @returns {string|undefined} 拒绝原因（固定字符串，绝不回显调用方给的文本）
 */
export function structuralReason(req) {
  const headers = req?.headers ?? {};
  const host = authorityOf(headers.host, 'http');
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback';

  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site';

  for (const header of ['origin', 'referer']) {
    const raw = headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (header === 'referer' && isDesktopRelayReferer(raw)) {
      // 桌面端 `forwardWebRequest` 在转发到本机 HTTP 环回之前会剥掉浏览器标记，
      // 只保留这个 Referer。它不是 Origin 授权，也绝不越过第 1 层。
      if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) {
        return 'desktop-relay-markers';
      }
      continue;
    }
    const authority = authorityOf(raw.trim());
    if (authority === null) return `${header}-invalid`;
    if (
      authority.scheme !== host.scheme
      || authority.hostname !== host.hostname
      || authority.port !== host.port
    ) {
      return `${header}-mismatch`;
    }
  }
  return undefined;
}

/** 只认应用自己的那个页面，不接受任意自定义协议页。 */
function isDesktopRelayReferer(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'dsh-app:'
      && url.hostname === 'app'
      && url.port === ''
      && url.username === ''
      && url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * 把 `Host`/`Origin`/`Referer` 拆成 `{scheme, hostname, port}`。
 *
 * @param {unknown} value
 * @param {string} [defaultScheme]
 * @returns {{scheme: string, hostname: string, port: string}|null}
 */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    const raw = value.trim();
    url = new URL(raw.includes('://') ? raw : `${defaultScheme ?? 'http'}://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}
