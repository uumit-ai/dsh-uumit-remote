// 本机管理页 /uumit-remote/：只应答本机主人。经通道到达的请求在转发前已被拦截（gate.isLocalOnlyPath），
// 这里再校验一遍：回环连接、回环 Host、DSH 浏览器凭据、无远程标记；写操作另需自定义请求头防跨站。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_ONLY_PREFIX, REMOTE_MARKER_HEADER } from '../proxy/gate.js'
import { describeError } from '../agent.js'

const here = dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 16 * 1024
const TIERS = new Set(['disabled', 'private', 'granted', 'public'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PKG_ROOT = join(here, '..', '..')
const STATIC = {
  '/': [join(here, 'static', 'index.html'), 'text/html; charset=utf-8'],
  '/standalone.js': [join(here, 'static', 'standalone.js'), 'text/javascript; charset=utf-8'],
  '/standalone.css': [join(here, 'static', 'standalone.css'), 'text/css; charset=utf-8'],
  // 与 DSH 浏览器端同一份代码（dsh.client 的 ./client 导出）
  '/client.js': [join(PKG_ROOT, 'client.js'), 'text/javascript; charset=utf-8'],
}
// client.js 运行时插入一个 <style> 元素，所以样式允许内联；脚本仍只允许同源文件
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

function isLoopbackAddress(addr) {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/, '')
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a)
}

function isLoopbackHostHeader(host) {
  if (!host) return false
  let u
  try {
    u = new URL(`http://${host}`)
  } catch {
    return false
  }
  const h = u.hostname.replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/** 本机主人判定；返回拒绝状态码或 0。 */
export function ownerRejection(req, connection) {
  if (req.headers[REMOTE_MARKER_HEADER] !== undefined) return 403
  if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHostHeader(req.headers.host)) return 403
  if (!connection || typeof connection.requestRejection !== 'function') return 403
  let rejection
  try {
    rejection = connection.requestRejection({ headers: req.headers })
  } catch {
    return 403
  }
  return rejection === undefined ? 0 : rejection
}

/** 写操作的跨站防护：自定义请求头 + 同源抓取元数据 + JSON。 */
export function writeRejection(req) {
  if (req.headers['x-uumit-remote-ui'] !== '1') return 403
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return 403
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return 415
  return 0
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (d) => {
      size += d.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(d)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        const v = JSON.parse(text)
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload, extra = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...extra,
  })
  res.end(body)
}

const ok = (res, data = null) => send(res, 200, { ok: true, data })
function fail(res, status, error) {
  send(res, status, { ok: false, error })
}

function apiStatus(err) {
  if (err && err.status) return err.status
  if (err && err.httpStatus >= 400 && err.httpStatus < 500) return err.httpStatus
  return 502
}

function requireService(agent) {
  const s = agent.service()
  if (!s) throw Object.assign(new Error('应用还没有登记到 UUMit'), { status: 409, code: 'SERVICE_NOT_REGISTERED' })
  return s.name
}

const UNAUTHORIZED_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>请先打开 DeepSeek Harness</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6"><h1 style="font-size:1.25rem">请先打开 DeepSeek Harness</h1><p>这个页面只给这台电脑的主人使用。请用 <code>dsh web</code> 打印的地址在本机打开 DSH，再点侧栏底部设置按钮旁的 UUMit 图标。</p></body></html>`

/**
 * @param {object} o
 * @param {import('../agent.js').RemoteAgent} o.agent
 * @param {{requestRejection: Function}} o.connection
 * @param {object} [o.log]
 */
export function createManagementHandler({ agent, connection, log = {} }) {
  const files = Object.fromEntries(Object.entries(STATIC).map(([p, [file, type]]) => [p, { body: readFileSync(file), type }]))

  const actions = {
    'GET /api/status': async () => agent.status(),
    'POST /api/pair/start': async () => agent.startPairing(),
    'POST /api/pair/code': async (body) => {
      await agent.pairWithCode(body.code)
      return agent.status()
    },
    'POST /api/pair/cancel': async () => {
      agent.cancelPairing()
      return agent.status()
    },
    'POST /api/unpair': async () => {
      await agent.unpair()
      return agent.status()
    },
    'POST /api/reconnect': async () => {
      await agent.goOnline()
      return agent.status()
    },
    'GET /api/management': async () => agent.api.desktopManagement(requireService(agent)),
    'POST /api/exposure': async (body) => {
      const name = requireService(agent)
      if (!TIERS.has(body.tier)) throw Object.assign(new Error('tier'), { status: 422, code: 'VALIDATION_FAILED' })
      if (body.tier === 'public' && body.confirm !== true) throw Object.assign(new Error('选择「所有人」需要确认'), { status: 422, code: 'CONFIRMATION_REQUIRED' })
      const svc = await agent.api.desktopSetExposure(name, { tier: body.tier, confirm: body.tier === 'public' ? true : null, triggerReason: '在 DSH 本机管理页设置' })
      await agent.refreshConfig()
      return svc
    },
    'POST /api/members/lookup': async (body) => {
      const phone = String(body.phone || '').trim()
      if (phone.length < 5 || phone.length > 20) throw Object.assign(new Error('手机号格式不对'), { status: 422, code: 'VALIDATION_FAILED' })
      return agent.api.desktopLookupMember(requireService(agent), phone)
    },
    'POST /api/grants': async (body) => {
      if (!UUID_RE.test(String(body.user_id || ''))) throw Object.assign(new Error('user_id'), { status: 422, code: 'VALIDATION_FAILED' })
      const note = body.note ? String(body.note).slice(0, 200) : null
      return agent.api.desktopGrant(requireService(agent), { userId: body.user_id, expiresAt: body.expires_at || null, note })
    },
    'POST /api/grants/revoke': async (body) => {
      if (!UUID_RE.test(String(body.grant_id || ''))) throw Object.assign(new Error('grant_id'), { status: 422, code: 'VALIDATION_FAILED' })
      await agent.api.desktopRevokeGrant(requireService(agent), body.grant_id)
      return null
    },
    'POST /api/invites': async (body) => {
      const days = Number(body.expires_in_days)
      const uses = Number(body.max_uses)
      if (!Number.isInteger(days) || days < 1 || !Number.isInteger(uses) || uses < 1) throw Object.assign(new Error('邀请参数不对'), { status: 422, code: 'VALIDATION_FAILED' })
      const note = body.note ? String(body.note).slice(0, 200) : null
      return agent.api.desktopInvite(requireService(agent), { expiresInDays: days, maxUses: uses, note })
    },
    'POST /api/invites/revoke': async (body) => {
      if (!UUID_RE.test(String(body.invite_id || ''))) throw Object.assign(new Error('invite_id'), { status: 422, code: 'VALIDATION_FAILED' })
      await agent.api.desktopRevokeInvite(requireService(agent), body.invite_id)
      return null
    },
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local')
    let sub = url.pathname.slice(LOCAL_ONLY_PREFIX.length)
    if (sub === '') {
      res.writeHead(308, { location: `${LOCAL_ONLY_PREFIX}/`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    const rejected = ownerRejection(req, connection)
    if (rejected) {
      if (req.method === 'GET' && !sub.startsWith('/api/')) {
        res.writeHead(rejected === 401 ? 401 : 403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP })
        res.end(UNAUTHORIZED_PAGE)
        return
      }
      return fail(res, rejected, { error_code: 'LOCAL_OWNER_REQUIRED', message: '只能在这台电脑上、已打开 DSH 的浏览器里操作', data: null })
    }
    if (req.method === 'GET' && files[sub]) {
      const f = files[sub]
      res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
      res.end(f.body)
      return
    }
    const action = actions[`${req.method} ${sub}`]
    if (!action) return fail(res, 404, { error_code: 'NOT_FOUND', message: 'not found', data: null })
    try {
      let body = {}
      if (req.method === 'POST') {
        const w = writeRejection(req)
        if (w) return fail(res, w, { error_code: 'LOCAL_OWNER_REQUIRED', message: '请求来源不被接受', data: null })
        body = await readJSON(req)
      }
      return ok(res, await action(body))
    } catch (err) {
      if (err && err.code && !err.errorCode) return fail(res, err.status || 409, { error_code: err.code, message: err.message, data: null })
      log.warn?.(`management ${req.method} ${sub} failed: ${err && err.message}`)
      return fail(res, apiStatus(err), describeError(err))
    }
  }
}
