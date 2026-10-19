// 应用入口推导（与 UUMit 连接器相同）：只从可信平台地址构造，保留端口。
export const DNS_LABEL_MAX = 63
const NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/

/** 应用名规则：2—32 位小写字母、数字、-，字母开头，字母或数字结尾，无 "--"，不以 "tmp-" 开头。 */
export function validServiceName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('--') && !name.startsWith('tmp-')
}

export function aliasFits(handle, name) {
  return name.length + 2 + handle.length <= DNS_LABEL_MAX
}

function parseAddress(address, handle) {
  let u
  try {
    u = new URL(address)
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host || u.username || u.password || u.search || u.hash) return null
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return null
  if (!handle || !u.hostname.startsWith(`${handle}.`)) return null
  return u
}

/**
 * 应用的公网主机与入口。
 * @returns {{scheme: string, legacyHost: string, aliasHost: string|null, entryURL: string, oldAliasHost: string}|null}
 */
export function serviceEntry(address, handle, name, aliasEnabled) {
  if (!validServiceName(name)) return null
  const u = parseAddress(address, handle)
  if (!u) return null
  const scheme = u.protocol.slice(0, -1)
  const legacyHost = u.host.toLowerCase()
  const aliasHost = aliasEnabled && aliasFits(handle, name) ? `${name}--${legacyHost}` : null
  return {
    scheme,
    legacyHost,
    aliasHost,
    oldAliasHost: `${name}--${legacyHost}`,
    entryURL: aliasHost ? `${scheme}://${aliasHost}/` : `${scheme}://${legacyHost}/s/${name}/`,
  }
}
