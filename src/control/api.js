// 平台接口客户端（连接器接口与服务登记）：只做 HTTP 与信封映射，不含业务分支。
// 直接使用 node:http / node:https：DSH 会替换全局 fetch 的调度器（dsh-http-proxy），这里不依赖它。
import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'

const CONNECTOR_PREFIX = '/api/v1/agent-address/connector'
const REQUEST_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 4 * 1024 * 1024
const RETRY_DELAYS_MS = [200, 400, 800]
const DESKTOP_PAGE_LIMIT = 100
const DESKTOP_MAX_PAGES = 10

export const ERR = Object.freeze({
  RATE_LIMITED: 'RATE_LIMITED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_CREDENTIAL_INVALID: 'DEVICE_CREDENTIAL_INVALID',
  PAIR_CODE_INVALID: 'PAIR_CODE_INVALID',
  FEATURE_REQUIRED: 'FEATURE_REQUIRED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  VISIBILITY_NOT_ALLOWED: 'VISIBILITY_NOT_ALLOWED',
  SERVICE_NOT_PUBLISHED: 'SERVICE_NOT_PUBLISHED',
  SERVICE_LIMIT_REACHED: 'SERVICE_LIMIT_REACHED',
})

export class APIError extends Error {
  constructor({ httpStatus = 0, code = null, errorCode = '', message = '', data = null, retryAfterMs = 0, traceId = '', cause } = {}) {
    super(errorCode ? `platform error ${errorCode} (http ${httpStatus}): ${message}` : cause ? `platform request failed: ${cause.message}` : `platform request failed: http ${httpStatus}`)
    this.name = 'APIError'
    this.httpStatus = httpStatus
    this.code = code
    this.errorCode = errorCode
    this.platformMessage = message
    this.data = data
    this.retryAfterMs = retryAfterMs
    this.traceId = traceId
    this.cause = cause
  }

  get network() {
    return this.httpStatus === 0 && !this.errorCode
  }

  get retryable() {
    return this.errorCode === ERR.RATE_LIMITED || this.httpStatus === 429 || this.httpStatus >= 500 || this.network
  }
}

export function isCode(err, code) {
  return err instanceof APIError && err.errorCode === code
}

/** 设备凭证无效或已撤销：进入「需要重新连接」的唯一依据。 */
export function isCredentialRejected(err) {
  return isCode(err, ERR.DEVICE_REVOKED) || isCode(err, ERR.DEVICE_CREDENTIAL_INVALID)
}

/** 每次服务登记都换新的幂等键：只保护本次请求自身的网络重试。 */
export function newIdempotencyKey(prefix) {
  return `${prefix}-${randomBytes(12).toString('hex')}`
}

function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.test')) return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** 平台入口只允许 https；http 只给本机与内网联调。返回规范化的 origin。 */
export function normalizeAPIBase(raw) {
  let u
  try {
    u = new URL(String(raw).trim())
  } catch {
    throw new Error('invalid apiBase')
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('apiBase must be an origin')
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && isPrivateHost(u.hostname)) return u.origin
  throw new Error('apiBase must use https')
}

function retryAfterMs(header) {
  if (!header) return 0
  const s = Number(header)
  if (Number.isFinite(s) && s >= 0) return s * 1000
  const t = Date.parse(header)
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class PlatformClient {
  /**
   * @param {object} o
   * @param {string} o.base 平台入口 origin
   * @param {() => Promise<string>|string} [o.credential] 设备凭证（dvc_…）
   * @param {string} [o.userAgent]
   * @param {(ms:number)=>Promise<void>} [o.sleep]
   */
  constructor({ base, credential, userAgent = '', sleep: sleepFn = sleep }) {
    this.base = normalizeAPIBase(base)
    this.credential = credential
    this.userAgent = userAgent
    this.sleep = sleepFn
    const isHttps = this.base.startsWith('https:')
    this.transport = isHttps ? https : http
    this.agent = new this.transport.Agent({ keepAlive: true, maxSockets: 4 })
  }

  // --- 配对 ---

  /** 发起浏览器确认配对；旧请求到期自然失效，网络失败可直接重试。 */
  createPairRequest(body) {
    return this._do({ method: 'POST', path: '/pair-requests', body, retryNetwork: true })
  }

  /** 轮询确认结果；设备凭证只在批准后的下一次轮询返回一次。 */
  pollPairRequest(deviceCode) {
    return this._do({ method: 'POST', path: '/pair-requests/poll', body: { device_code: deviceCode }, retryNetwork: true })
  }

  /** 配对码连接；同一码只能成功一次，请求发出后的网络错误不自动重试。 */
  pairWithCode(body) {
    return this._do({ method: 'POST', path: '/pair', body, retryNetwork: false })
  }

  // --- 运行期 ---

  getConfig() {
    return this._do({ method: 'GET', path: '/config', auth: true, retryNetwork: true })
  }

  reportStatus(body) {
    return this._do({ method: 'POST', path: '/status', body, auth: true, retryNetwork: true })
  }

  registerService(handle, body) {
    return this._do({
      method: 'POST',
      fullPath: `/api/v1/agent-address/handles/${encodeURIComponent(handle)}/services`,
      body,
      auth: true,
      retryNetwork: true,
      idempotencyKey: newIdempotencyKey('svc'),
    })
  }

  /** 断开这台电脑；重试时平台返回 DEVICE_REVOKED（上一次已成功）也视为成功。 */
  async unpair() {
    try {
      return await this._do({ method: 'POST', path: '/unpair', body: {}, auth: true, retryNetwork: true })
    } catch (err) {
      if (isCode(err, ERR.DEVICE_REVOKED)) return null
      throw err
    }
  }

  // --- 本机管理：谁能用、邀请与授权 ---

  async desktopManagement(name) {
    let out = null
    let grantsCursor = ''
    let invitesCursor = ''
    let grantsDone = false
    let invitesDone = false
    for (let page = 0; page < DESKTOP_MAX_PAGES && (page === 0 || !grantsDone || !invitesDone); page++) {
      const q = new URLSearchParams({ limit: String(DESKTOP_PAGE_LIMIT) })
      if (grantsCursor) q.set('grants_cursor', grantsCursor)
      if (invitesCursor) q.set('invites_cursor', invitesCursor)
      const pg = await this._do({ method: 'GET', path: `${desktopPath(name, 'management')}?${q}`, auth: true, retryNetwork: true })
      if (page === 0) out = { ...pg, grants: [], invites: [] }
      if (!grantsDone) {
        out.grants.push(...(pg.grants || []))
        grantsCursor = pg.grants_next_cursor || ''
        grantsDone = !grantsCursor
      }
      if (!invitesDone) {
        out.invites.push(...(pg.invites || []))
        invitesCursor = pg.invites_next_cursor || ''
        invitesDone = !invitesCursor
      }
    }
    out.grants_next_cursor = null
    out.invites_next_cursor = null
    return out
  }

  desktopSetExposure(name, { tier, confirm = null, triggerReason = null }) {
    return this._do({ method: 'POST', path: desktopPath(name, 'exposure'), body: { tier, confirm, trigger_reason: triggerReason }, auth: true, retryNetwork: true })
  }

  desktopLookupMember(name, phone) {
    return this._do({ method: 'POST', path: desktopPath(name, 'members/lookup'), body: { phone }, auth: true, retryNetwork: true })
  }

  desktopGrant(name, { userId, expiresAt = null, note = null }) {
    return this._do({
      method: 'POST',
      path: desktopPath(name, 'grants'),
      body: { user_id: userId, expires_at: expiresAt, note },
      auth: true,
      retryNetwork: true,
      idempotencyKey: newIdempotencyKey('grant'),
    })
  }

  desktopRevokeGrant(name, grantId) {
    return this._do({ method: 'POST', path: desktopPath(name, `grants/${encodeURIComponent(grantId)}/revoke`), body: {}, auth: true, retryNetwork: true })
  }

  desktopInvite(name, { expiresInDays, maxUses, note = null }) {
    return this._do({
      method: 'POST',
      path: desktopPath(name, 'invites'),
      body: { expires_in_days: expiresInDays, max_uses: maxUses, note },
      auth: true,
      retryNetwork: true,
      idempotencyKey: newIdempotencyKey('invite'),
    })
  }

  desktopRevokeInvite(name, inviteId) {
    return this._do({ method: 'POST', path: desktopPath(name, `invites/${encodeURIComponent(inviteId)}/revoke`), body: {}, auth: true, retryNetwork: true })
  }

  close() {
    this.agent.destroy()
  }

  async _do(call) {
    const payload = call.body === undefined ? null : Buffer.from(JSON.stringify(call.body))
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._once(call, payload)
      } catch (err) {
        if (!(err instanceof APIError)) throw err
        if (!err.retryable || (err.network && !call.retryNetwork) || attempt >= RETRY_DELAYS_MS.length) throw err
        await this.sleep(err.retryAfterMs > 0 ? err.retryAfterMs : RETRY_DELAYS_MS[attempt])
      }
    }
  }

  async _once(call, payload) {
    const url = new URL((call.fullPath || CONNECTOR_PREFIX + call.path), this.base)
    const headers = { accept: 'application/json' }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    if (this.userAgent) headers['user-agent'] = this.userAgent
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey
    if (call.auth) {
      if (!this.credential) throw new Error('device credential source not configured')
      const cred = await this.credential()
      if (!cred) throw new APIError({ httpStatus: 401, errorCode: ERR.DEVICE_CREDENTIAL_INVALID, message: 'no local device credential' })
      headers.authorization = `Device ${cred}`
    }
    const { status, resHeaders, raw } = await new Promise((resolve, reject) => {
      const req = this.transport.request(url, { method: call.method, headers, agent: this.agent }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (d) => {
          size += d.length
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error('response too large'))
            return
          }
          chunks.push(d)
        })
        res.on('end', () => resolve({ status: res.statusCode, resHeaders: res.headers, raw: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      const overall = setTimeout(() => req.destroy(new Error('request timed out')), REQUEST_TIMEOUT_MS)
      req.on('socket', (sock) => {
        if (sock.connecting) {
          const t = setTimeout(() => req.destroy(new Error('connect timed out')), CONNECT_TIMEOUT_MS)
          sock.once('connect', () => clearTimeout(t))
          sock.once('secureConnect', () => clearTimeout(t))
          sock.once('close', () => clearTimeout(t))
        }
      })
      req.on('close', () => clearTimeout(overall))
      req.on('error', (err) => reject(new APIError({ cause: err })))
      if (payload) req.write(payload)
      req.end()
    })
    const traceId = String(resHeaders['x-trace-id'] || '')
    const retryAfter = retryAfterMs(resHeaders['retry-after'])
    let env = null
    try {
      env = JSON.parse(raw.toString('utf8'))
    } catch {
      env = null
    }
    if (!env || typeof env !== 'object' || typeof env.code !== 'number') {
      throw new APIError({ httpStatus: status, traceId, retryAfterMs: retryAfter, cause: status < 300 ? new Error('response is not a platform envelope') : undefined })
    }
    if (status < 300 && env.code === 0) return env.data ?? null
    throw new APIError({
      httpStatus: status,
      code: env.code,
      errorCode: String(env.error_code || ''),
      message: String(env.message || ''),
      data: env.data ?? null,
      retryAfterMs: retryAfter,
      traceId,
    })
  }
}

function desktopPath(name, action) {
  return `/desktop/services/${encodeURIComponent(name)}/${action}`
}
