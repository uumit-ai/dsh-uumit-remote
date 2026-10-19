// 回环代理（回环模式）：通道工作连接 → 进程内 http.Server → 准入 → 改写为本机形态 → DSH 自己的监听地址。
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import {
  HOST_DESKTOP_PATH,
  REMOTE_MARKER_HEADER,
  browserContextAllowed,
  canonicalAuthority,
  disableHostDesktop,
  hostDesktopAction,
  identityAllowed,
  injectHostMode,
  isIndexRequest,
  isLocalOnlyPath,
  needsHostDesktopBody,
  sharingMetadata,
} from './gate.js'

const MAX_INDEX_BYTES = 4 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 3000
// RFC 7230 逐跳头，加上浏览器凭据与来源：一律不转给 DSH
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'host',
  'cookie',
  'origin',
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-proto',
])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie'])

export const SIGNAL = Object.freeze({ HEADER: 'X-UUMit-Upstream-Error', REFUSED: 'connect_refused', TIMEOUT: 'timeout' })

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"

function page(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6;color:#1f2328"><h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body></html>`
}

const PAGES = {
  forbidden: [403, '没有权限访问这个应用', '请使用应用主人发出的邀请，并登录被邀请的 UUMit 账号后再打开。'],
  legacy: [400, '请使用应用的独立网址', 'DeepSeek Harness 需要独立网址才能完整使用。请应用主人在 UUMit 网页或 DSH 的「UUMit 远程访问」里为它开启独立网址后，再从新网址打开。'],
  stale: [503, '应用暂时无法打开', '这台电脑上的 DeepSeek Harness 暂时无法验证远程访问，请稍后刷新本页；仍不行时请主人重启 DSH。'],
}

function rejectPayload(kind) {
  const [status, title, detail] = PAGES[kind]
  return { status, body: page(title, detail), headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff' } }
}

function wantsHTML(req) {
  return String(req.headers.accept || '').toLowerCase().includes('text/html')
}

/** 浏览器顶层页面导航（不含接口、资源与 WebSocket）。 */
function isPageNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (req.headers.upgrade) return false
  const mode = req.headersDistinct['sec-fetch-mode']
  if (mode && mode.length) return mode.length === 1 && mode[0] === 'navigate' && (req.headers['sec-fetch-dest'] || 'document') === 'document'
  return wantsHTML(req)
}

/**
 * 旧路径入口（<地址>/s/<应用>/）上的页面导航改跳到独立网址的同一路径；网关已去掉 /s/<应用> 前缀。
 * 独立网址未开启、不是页面导航或身份头不合规时返回 null，仍按旧路径拒绝。
 */
export function legacyRedirect(req, rule, meta) {
  const alias = rule.entry && rule.entry.aliasHost ? canonicalAuthority(rule.entry.aliasHost, meta.scheme) : ''
  if (!alias || !isPageNavigation(req) || !identityAllowed(req.headersDistinct, rule.tier)) return null
  const u = new URL(req.url, 'http://x')
  return {
    status: 302,
    body: '',
    headers: { location: `${meta.scheme}://${alias}${u.pathname}${u.search}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  }
}

function isTimeout(err) {
  return err && (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || /timed? ?out/i.test(err.message || ''))
}

/** 构造发往 DSH 的请求头（扁平数组，保留同名多值）。 */
export function rewriteHeaders(req, { origin, cookie, meta, index, upgrade }) {
  const out = []
  const raw = req.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase()
    if (DROP_REQUEST.has(name) || name.startsWith('sec-fetch-') || name.startsWith('x-uumit-')) continue
    if (name === 'x-forwarded-for' || name === 'accept-encoding') continue
    out.push(raw[i], raw[i + 1])
  }
  const host = new URL(origin).host
  out.push('Host', host, 'Sec-Fetch-Site', 'same-origin', 'Cookie', cookie, REMOTE_MARKER_HEADER, '1')
  const xff = req.headersDistinct['x-forwarded-for']
  if (xff && xff.length) out.push('X-Forwarded-For', xff.join(', '))
  out.push('X-Forwarded-Host', meta.host, 'X-Forwarded-Proto', meta.scheme)
  const ae = req.headers['accept-encoding']
  if (!index && ae) out.push('Accept-Encoding', ae)
  else out.push('Accept-Encoding', 'identity')
  if (upgrade) {
    out.push('Connection', 'Upgrade')
    if (req.headers.upgrade) out.push('Upgrade', req.headers.upgrade)
  }
  return out
}

/** 根路径去掉 token 查询参数（DSH 启动凭据不经远程传入）。 */
export function cleanPath(rawUrl) {
  const u = new URL(rawUrl, 'http://x')
  if (u.pathname === '/' && u.searchParams.has('token')) u.searchParams.delete('token')
  return u.pathname + u.search
}

function filterResponseHeaders(rawHeaders, drop = new Set()) {
  const out = []
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const n = rawHeaders[i].toLowerCase()
    if (DROP_RESPONSE.has(n) || drop.has(n)) continue
    out.push(rawHeaders[i], rawHeaders[i + 1])
  }
  out.push('X-UUMit-Tunnel', '1')
  return out
}

export class LoopbackProxy {
  /**
   * @param {object} o
   * @param {() => string} o.origin DSH 监听地址
   * @param {import('./inner-auth.js').InnerAuth} o.innerAuth
   * @param {object} [o.log]
   */
  constructor({ origin, innerAuth, log = {} }) {
    this.origin = origin
    this.innerAuth = innerAuth
    this.log = log
    this.agents = { http: new http.Agent({ keepAlive: true, maxSockets: 64 }), https: new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false }) }
  }

  close() {
    this.agents.http.destroy()
    this.agents.https.destroy()
  }

  /** 准入检查；返回 {meta} 或 {reject}。 */
  admit(req, rule, pathname) {
    const h = req.headersDistinct
    const meta = sharingMetadata(rule.entry, h)
    if (!meta) return { reject: { status: 400, body: 'invalid application sharing address', headers: { 'content-type': 'text/plain; charset=utf-8' } } }
    if (meta.legacy) return { reject: legacyRedirect(req, rule, meta) || rejectPayload('legacy') }
    if (isLocalOnlyPath(pathname)) return { reject: { status: 404, body: 'not found', headers: { 'content-type': 'text/plain; charset=utf-8' } } }
    if (!identityAllowed(h, rule.tier) || !browserContextAllowed(h, meta)) return { reject: rejectPayload('forbidden') }
    return { meta }
  }

  async handleRequest(req, res, rule) {
    const pathname = new URL(req.url, 'http://x').pathname
    const { meta, reject } = this.admit(req, rule, pathname)
    if (reject) return this._send(res, reject)
    let bodyText = null
    if (needsHostDesktopBody(req.method, pathname)) {
      bodyText = await readBody(req, 64 * 1024)
      const answer = hostDesktopAction(req.method, pathname, bodyText)
      if (answer) return this._send(res, { status: answer.status, body: answer.body, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    } else {
      const answer = hostDesktopAction(req.method, pathname, null)
      if (answer) return this._send(res, { status: answer.status, body: answer.body, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
    let cookie
    try {
      cookie = await this.innerAuth.get()
    } catch (err) {
      this.log.warn?.(`inner credential unavailable: ${err.message}`)
      return this._stale(req, res)
    }
    const index = isIndexRequest(req, pathname)
    const hasBody = !(req.method === 'GET' || req.method === 'HEAD') || Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding']
    const forward = (cookieValue, body) =>
      new Promise((resolve, reject) => {
        const origin = this.origin()
        const target = new URL(origin)
        const transport = target.protocol === 'https:' ? https : http
        const up = transport.request({
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: cleanPath(req.url),
          headers: rewriteHeaders(req, { origin, cookie: cookieValue, meta, index, upgrade: false }),
          agent: target.protocol === 'https:' ? this.agents.https : this.agents.http,
          setHost: false,
        })
        up.on('socket', (s) => {
          if (s.connecting) {
            const t = setTimeout(() => up.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS)
            s.once('connect', () => clearTimeout(t))
            s.once('close', () => clearTimeout(t))
          }
        })
        up.on('response', resolve)
        up.on('error', reject)
        if (body !== null) up.end(body)
        else if (hasBody) req.pipe(up)
        else up.end()
      })
    let upRes
    try {
      upRes = await forward(cookie, bodyText)
      if (upRes.statusCode === 401 && !hasBody) {
        upRes.resume()
        this.innerAuth.invalidate(cookie)
        cookie = await this.innerAuth.get()
        upRes = await forward(cookie, null)
      } else if (upRes.statusCode === 401) {
        this.innerAuth.invalidate(cookie)
      }
    } catch (err) {
      return this._upstreamError(res, err)
    }
    const isHostDesktop = pathname === HOST_DESKTOP_PATH
    const ct = String(upRes.headers['content-type'] || '').toLowerCase()
    const injectable = index && req.method === 'GET' && upRes.statusCode === 200 && ct.startsWith('text/html') && !upRes.headers['content-encoding'] && !upRes.headers['content-security-policy']
    if (injectable || (isHostDesktop && upRes.statusCode === 200 && !upRes.headers['content-encoding'])) {
      const buf = await readBuffer(upRes, MAX_INDEX_BYTES + 1)
      let text = buf.toString('utf8')
      if (injectable && buf.length <= MAX_INDEX_BYTES) text = injectHostMode(text)
      if (isHostDesktop) text = disableHostDesktop(text)
      const out = Buffer.from(text, 'utf8')
      const headers = filterResponseHeaders(upRes.rawHeaders, new Set(['content-length', 'etag', 'cache-control']))
      headers.push('Content-Length', String(out.length))
      if (injectable) headers.push('Cache-Control', 'no-store')
      res.writeHead(upRes.statusCode, headers)
      res.end(out)
      return
    }
    res.writeHead(upRes.statusCode, upRes.statusMessage, filterResponseHeaders(upRes.rawHeaders))
    upRes.pipe(res)
    res.on('close', () => {
      if (!upRes.complete) upRes.destroy()
    })
  }

  async handleUpgrade(req, socket, head, rule) {
    const pathname = new URL(req.url, 'http://x').pathname
    const { meta, reject } = this.admit(req, rule, pathname)
    if (reject) return writeRaw(socket, reject)
    let cookie
    try {
      cookie = await this.innerAuth.get()
    } catch {
      return writeRaw(socket, { status: 503, body: 'dsh unavailable', headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    const origin = this.origin()
    const target = new URL(origin)
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const up = target.protocol === 'https:' ? tls.connect({ host, port, rejectUnauthorized: false }) : net.connect({ host, port })
    const headers = rewriteHeaders(req, { origin, cookie, meta, index: false, upgrade: true })
    let lines = `${req.method} ${cleanPath(req.url)} HTTP/1.1\r\n`
    for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`
    up.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      up.write(lines + '\r\n')
      if (head && head.length) up.write(head)
      up.once('data', (first) => {
        // DSH 拒绝内部凭据时作废缓存，下一次升级重新兑换
        if (/^HTTP\/1\.1 401/.test(first.toString('latin1', 0, 16))) this.innerAuth.invalidate(cookie)
        socket.write(first)
        up.pipe(socket)
        socket.pipe(up)
      })
    })
    up.on('error', (err) => {
      this.log.warn?.(`websocket upstream failed: ${err.message}`)
      socket.destroy()
    })
    socket.on('error', () => up.destroy())
    socket.on('close', () => up.destroy())
    up.on('close', () => socket.destroy())
  }

  _send(res, { status, body, headers = {} }) {
    res.writeHead(status, { ...headers, 'x-uumit-tunnel': '1' })
    res.end(body)
  }

  _stale(req, res) {
    if (isIndexRequest(req, new URL(req.url, 'http://x').pathname) && wantsHTML(req)) return this._send(res, rejectPayload('stale'))
    this._send(res, { status: 503, body: '{"code":"dsh_unavailable","message":"DeepSeek Harness could not verify remote access; retry later"}', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }

  _upstreamError(res, err) {
    const timeout = isTimeout(err)
    this.log.warn?.(`local DSH unreachable: ${err.message}`)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(timeout ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8', 'x-uumit-tunnel': '1', [SIGNAL.HEADER]: timeout ? SIGNAL.TIMEOUT : SIGNAL.REFUSED })
    res.end('local service unreachable')
  }
}

function writeRaw(socket, { status, body, headers = {} }) {
  const text = http.STATUS_CODES[status] || 'Error'
  const b = Buffer.from(body)
  let out = `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: ${b.length}\r\nX-UUMit-Tunnel: 1\r\n`
  for (const [k, v] of Object.entries(headers)) out += `${k}: ${v}\r\n`
  socket.end(Buffer.concat([Buffer.from(out + '\r\n'), b]))
}

function readBuffer(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    stream.on('data', (d) => {
      if (n < limit) chunks.push(d)
      n += d.length
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

async function readBody(req, limit) {
  const buf = await readBuffer(req, limit)
  return buf.toString('utf8')
}

/** 进程内 http.Server：不监听端口，只接收通道交来的工作连接。 */
export function createTunnelServer(proxy, log = {}) {
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 60_000 })
  server.keepAliveTimeout = 60_000
  const ruleOf = (socket) => (typeof socket.uumitRule === 'function' ? socket.uumitRule() : null)
  server.on('request', (req, res) => {
    const rule = ruleOf(req.socket)
    if (!rule) {
      res.writeHead(404, { 'x-uumit-tunnel': '1' }).end()
      return
    }
    proxy.handleRequest(req, res, rule).catch((err) => {
      log.warn?.(`remote request failed: ${err.message}`)
      if (!res.headersSent) res.writeHead(502, { 'x-uumit-tunnel': '1' })
      res.end()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const rule = ruleOf(socket)
    if (!rule) {
      socket.destroy()
      return
    }
    proxy.handleUpgrade(req, socket, head, rule).catch(() => socket.destroy())
  })
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  return {
    server,
    /** @param {() => object|null} ruleOf 每个请求调用一次，返回当前规则；为空表示应用已不再开放 */
    accept(stream, ruleOfStream) {
      stream.uumitRule = ruleOfStream
      stream.on('error', () => {})
      server.emit('connection', stream)
    },
  }
}
