// 经通道到达的请求的准入规则（与 UUMit 连接器本地代理的回环模式规则一致）。
// 网关先剥离外部伪造的身份头再注入；这里只做纵深防御：缺失、重复或格式不对一律拒绝。

export const LOCAL_ONLY_PREFIX = '/uumit-remote'
export const REMOTE_MARKER_HEADER = 'x-uumit-dsh-remote'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** 取同名请求头的全部取值（需要 node:http 的 headersDistinct，才能识别重复）。 */
export function values(headersDistinct, name) {
  const v = headersDistinct[name]
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function single(h, name) {
  const v = values(h, name)
  return v.length === 1 ? v[0] : null
}

function validUUID(v) {
  return typeof v === 'string' && v.length === 36 && UUID_RE.test(v) && v !== NIL_UUID
}

function optionalUUID(h, name) {
  const v = values(h, name)
  if (v.length === 0) return true
  return v.length === 1 && validUUID(v[0])
}

/** 身份门：私有与授权档要求主人，或授权档带唯一合法授权的受邀成员；开放档只要求身份头完整合法。 */
export function identityAllowed(h, tier) {
  if (tier === 'public') {
    const type = single(h, 'x-uumit-caller-type')
    if (!['owner', 'user', 'agent', 'public'].includes(type)) return false
    return optionalUUID(h, 'x-uumit-caller-id') && optionalUUID(h, 'x-uumit-grant-id')
  }
  if (tier !== 'private' && tier !== 'granted') return false
  const type = single(h, 'x-uumit-caller-type')
  const id = single(h, 'x-uumit-caller-id')
  if (type === null || id === null) return false
  if (type === 'owner') {
    if (values(h, 'x-uumit-grant-id').length !== 0) return false
  } else if (type === 'user' && tier === 'granted') {
    if (!validUUID(single(h, 'x-uumit-grant-id'))) return false
  } else {
    return false
  }
  return validUUID(id)
}

/** 只合并 http / https 默认端口与大小写，拒绝 userinfo、路径和非法 authority。 */
export function canonicalAuthority(value, scheme) {
  if (!value || /[/?#@ \\\t\r\n]/.test(value)) return ''
  let u
  try {
    u = new URL(`${scheme}://${value}`)
  } catch {
    return ''
  }
  if (!u.hostname || u.username || u.password) return ''
  const host = u.hostname.toLowerCase()
  return u.port ? `${host}:${u.port}` : host
}

function schemeAllowed(configured, actual) {
  return (actual === 'http' || actual === 'https') && (configured === actual || (configured === 'http' && actual === 'https'))
}

function temporarySharingHost(host, legacy) {
  if (!host.startsWith('tmp-')) return false
  const rest = host.slice(4)
  const i = rest.indexOf('--')
  if (i < 0) return false
  const label = rest.slice(0, i)
  return rest.slice(i + 2) === legacy && /^[a-z0-9]{24}$/.test(label)
}

/**
 * 公网主机校验：必须是本应用的独立网址、双横线别名、旧路径入口或临时分享主机。
 * @param {{scheme: string, legacyHost: string, aliasHost: string|null, oldAliasHost: string}} entry
 * @returns {{host: string, scheme: string, legacy: boolean}|null}
 */
export function sharingMetadata(entry, h) {
  if (!entry) return null
  const host = single(h, 'x-uumit-public-host')
  const scheme = single(h, 'x-uumit-public-proto')
  if (host === null || scheme === null || !schemeAllowed(entry.scheme, scheme)) return null
  const canon = canonicalAuthority(host, scheme)
  if (!canon) return null
  const legacy = canonicalAuthority(entry.legacyHost, scheme)
  const alias = entry.aliasHost ? canonicalAuthority(entry.aliasHost, scheme) : ''
  const oldAlias = canonicalAuthority(entry.oldAliasHost, scheme)
  if (canon !== alias && canon !== oldAlias && canon !== legacy && !temporarySharingHost(canon, legacy)) return null
  return { host: canon, scheme, legacy: canon === legacy }
}

function crossSiteNavigation(h) {
  return values(h, 'origin').length === 0 && single(h, 'sec-fetch-mode') === 'navigate' && single(h, 'sec-fetch-dest') === 'document'
}

/** 浏览器上下文：跨站只放行顶层导航；有 Origin 时必须是本应用的公网地址。 */
export function browserContextAllowed(h, meta) {
  for (const n of ['sec-fetch-site', 'origin', 'sec-fetch-mode', 'sec-fetch-dest']) if (values(h, n).length > 1) return false
  const site = single(h, 'sec-fetch-site') || ''
  if (site === 'cross-site') {
    if (!crossSiteNavigation(h)) return false
  } else if (!['', 'same-origin', 'same-site', 'none'].includes(site)) {
    return false
  }
  const origin = single(h, 'origin')
  if (origin) {
    let u
    try {
      u = new URL(origin)
    } catch {
      return false
    }
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return false
    if (u.protocol !== `${meta.scheme}:` || canonicalAuthority(u.host, meta.scheme) !== meta.host) return false
  }
  return true
}

export function isLocalOnlyPath(pathname) {
  return pathname === LOCAL_ONLY_PREFIX || pathname.startsWith(LOCAL_ONLY_PREFIX + '/')
}

export function isUpgrade(req) {
  if (req.headers.upgrade) return true
  return String(req.headers.connection || '')
    .split(',')
    .some((t) => t.trim().toLowerCase() === 'upgrade')
}

export function isIndexRequest(req, pathname) {
  return (req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html') && !isUpgrade(req)
}

// --- 主人桌面动作：远程点了只会在主人电脑上打开应用或文件，一律隐藏 ---

export const HOST_DESKTOP_PATH = '/api/session/workspaceDesktop'
const RPC_FAILURES = new Set(['/api/session/openWorkspacePath', '/api/settings/openSettingsDocument'])
const RPC_VALUES = new Map([
  ['/api/session/canOpenWorkspacePath', 'false'],
  ['/api/session/workspacePathApplications', '[]'],
])
const UNAVAILABLE = { code: 'host-desktop-unavailable', message: 'opening on the host desktop is unavailable over remote access' }

/** 需要直接应答的主人桌面动作：返回 {status, body} 或 null（照常转发）。POST RPC 需要读请求体。 */
export function hostDesktopAction(method, pathname, body) {
  if (pathname === '/open-in-app/apps' && method === 'GET') return { status: 200, body: '{"apps":[]}' }
  if (pathname === '/open-in-app/open' || pathname === '/api/present.open' || pathname === '/api/changes.open') return { status: 403, body: JSON.stringify(UNAVAILABLE) }
  const isValue = RPC_VALUES.has(pathname)
  if (method !== 'POST' || (!isValue && !RPC_FAILURES.has(pathname))) return null
  let msg
  try {
    msg = JSON.parse(body || '')
  } catch {
    return { status: 400, body: '' }
  }
  if (!msg || msg.type !== 'client-request' || !msg.rpcId) return { status: 400, body: '' }
  const result = isValue ? `{"ok":true,"value":${RPC_VALUES.get(pathname)}}` : JSON.stringify({ ok: false, error: { ...UNAVAILABLE, details: {} } })
  return { status: 200, body: `{"type":"server-response","rpcId":${JSON.stringify(String(msg.rpcId))},"result":${result}}` }
}

export function needsHostDesktopBody(method, pathname) {
  return method === 'POST' && (RPC_VALUES.has(pathname) || RPC_FAILURES.has(pathname))
}

/** 保留主机名等信息，只把「可在主人桌面打开」置为不可用。 */
export function disableHostDesktop(text) {
  try {
    const env = JSON.parse(text)
    if (env && env.result && env.result.value && typeof env.result.value === 'object') {
      env.result.value.available = false
      return JSON.stringify(env)
    }
  } catch {
    // 不认识的结构原样返回
  }
  return text
}

const HOST_MODE_SCRIPT = '<script>window.__DSH_TRANSPORT__=Object.assign(window.__DSH_TRANSPORT__||{},{ownsHost:true});</script>'

/** 在 <head> 开标签之后注入宿主模式开关（设置写回主人电脑）。 */
export function injectHostMode(html) {
  const lower = html.toLowerCase()
  const start = lower.indexOf('<head')
  if (start < 0) return html
  const end = html.indexOf('>', start)
  if (end < 0) return html
  return html.slice(0, end + 1) + HOST_MODE_SCRIPT + html.slice(end + 1)
}
