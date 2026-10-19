// DSH 内部凭据：插件在 DSH 进程内用 connection.authenticatedUrl() 兑换一次与回环地址绑定的 dsh-auth-* Cookie，
// 只留在内存里，附在转发到 DSH 的请求上；DSH 返回 401 时作废重换。浏览器永远拿不到它。
import http from 'node:http'
import https from 'node:https'

const EXCHANGE_TIMEOUT_MS = 2500

export class InnerAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InnerAuthError'
  }
}

/** 解析 Set-Cookie，只接受 DSH 签发的 dsh-auth-*：HttpOnly、SameSite=Strict、Path=/、无 Domain。 */
export function parseAuthCookies(setCookies) {
  const pairs = []
  for (const line of setCookies || []) {
    const parts = line.split(';').map((p) => p.trim())
    const eq = parts[0].indexOf('=')
    if (eq <= 0) throw new InnerAuthError('malformed cookie')
    const name = parts[0].slice(0, eq)
    const value = parts[0].slice(eq + 1)
    const attrs = new Map(parts.slice(1).map((p) => {
      const i = p.indexOf('=')
      return i < 0 ? [p.toLowerCase(), ''] : [p.slice(0, i).toLowerCase(), p.slice(i + 1)]
    }))
    if (!name.startsWith('dsh-auth-') || !value) throw new InnerAuthError(`unexpected cookie ${name}`)
    if (!attrs.has('httponly') || (attrs.get('samesite') || '').toLowerCase() !== 'strict' || attrs.has('domain') || (attrs.get('path') || '/') !== '/') {
      throw new InnerAuthError('cookie attributes rejected')
    }
    pairs.push(`${name}=${value}`)
  }
  if (!pairs.length) throw new InnerAuthError('no dsh-auth cookie issued')
  return pairs.join('; ')
}

export class InnerAuth {
  /**
   * @param {{authenticatedUrl: (base: string) => string}} connection DSH 的 connection 服务
   * @param {() => string} origin DSH 自己的监听地址，例如 http://127.0.0.1:3080
   */
  constructor(connection, origin) {
    this.connection = connection
    this.origin = origin
    this.cookie = null
    this.pending = null
  }

  invalidate(stale) {
    if (stale === undefined || stale === this.cookie) this.cookie = null
  }

  async get() {
    if (this.cookie) return this.cookie
    if (!this.pending) {
      this.pending = this._exchange().finally(() => {
        this.pending = null
      })
    }
    return this.pending
  }

  async _exchange() {
    const origin = this.origin()
    const target = new URL(this.connection.authenticatedUrl(`${origin}/`))
    if (target.origin !== new URL(origin).origin || target.pathname !== '/') throw new InnerAuthError('authenticated url does not point at this server')
    const transport = target.protocol === 'https:' ? https : http
    const res = await new Promise((resolve, reject) => {
      const req = transport.request(target, {
        method: 'GET',
        headers: { 'accept-encoding': 'identity' },
        agent: false,
        // 自己的监听地址；证书可能签给别的主机名
        rejectUnauthorized: false,
      }, (r) => {
        r.resume()
        resolve(r)
      })
      req.setTimeout(EXCHANGE_TIMEOUT_MS, () => req.destroy(new InnerAuthError('exchange timed out')))
      req.on('error', reject)
      req.end()
    })
    if (res.statusCode !== 303 && res.statusCode !== 302) throw new InnerAuthError(`exchange returned http ${res.statusCode}`)
    this.cookie = parseAuthCookies(res.headers['set-cookie'])
    return this.cookie
  }
}
