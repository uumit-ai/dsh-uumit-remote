import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {
  identityAllowed,
  sharingMetadata,
  browserContextAllowed,
  hostDesktopAction,
  injectHostMode,
  disableHostDesktop,
  canonicalAuthority,
  isLocalOnlyPath,
} from '../src/proxy/gate.js'
import { parseAuthCookies, InnerAuth } from '../src/proxy/inner-auth.js'
import { LoopbackProxy, createTunnelServer, cleanPath } from '../src/proxy/loopback.js'
import { serviceEntry } from '../src/control/entry.js'

const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a'
const MEMBER = 'bbbbbbbb-0000-4000-8000-00000000000b'
const GRANT = 'cccccccc-0000-4000-8000-00000000000c'
const H = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]))

test('身份门：私有档只放主人，授权档放带唯一合法授权的成员', () => {
  assert.ok(identityAllowed(H({ 'x-uumit-caller-type': 'owner', 'x-uumit-caller-id': OWNER }), 'private'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'owner', 'x-uumit-caller-id': OWNER, 'x-uumit-grant-id': GRANT }), 'private'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': GRANT }), 'private'))
  assert.ok(identityAllowed(H({ 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': GRANT }), 'granted'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER }), 'granted'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': [GRANT, GRANT] }), 'granted'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': ['owner', 'owner'], 'x-uumit-caller-id': OWNER }), 'private'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'owner', 'x-uumit-caller-id': 'not-a-uuid' }), 'private'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'owner', 'x-uumit-caller-id': '00000000-0000-0000-0000-000000000000' }), 'private'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'agent', 'x-uumit-caller-id': OWNER }), 'granted'))
  assert.ok(!identityAllowed(H({}), 'private'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'owner', 'x-uumit-caller-id': OWNER }), 'disabled'))
})

test('身份门：开放档只要求身份类型唯一合法，其余身份头出现时唯一且为 UUID', () => {
  assert.ok(identityAllowed(H({ 'x-uumit-caller-type': 'public' }), 'public'))
  assert.ok(identityAllowed(H({ 'x-uumit-caller-type': 'agent', 'x-uumit-caller-id': OWNER }), 'public'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'anonymous' }), 'public'))
  assert.ok(!identityAllowed(H({}), 'public'))
  assert.ok(!identityAllowed(H({ 'x-uumit-caller-type': 'public', 'x-uumit-caller-id': 'x' }), 'public'))
})

const entry = serviceEntry('https://my-mac.uumit.cn', 'my-mac', 'dsh', true)

test('公网主机：独立网址、旧路径、临时分享；拒绝他人主机与协议降级', () => {
  assert.deepEqual(sharingMetadata(entry, H({ 'x-uumit-public-host': 'DSH--my-mac.uumit.cn:443', 'x-uumit-public-proto': 'https' })), { host: 'dsh--my-mac.uumit.cn', scheme: 'https', legacy: false })
  assert.equal(sharingMetadata(entry, H({ 'x-uumit-public-host': 'my-mac.uumit.cn', 'x-uumit-public-proto': 'https' })).legacy, true)
  assert.ok(sharingMetadata(entry, H({ 'x-uumit-public-host': `tmp-${'a'.repeat(24)}--my-mac.uumit.cn`, 'x-uumit-public-proto': 'https' })))
  assert.equal(sharingMetadata(entry, H({ 'x-uumit-public-host': 'dsh--other.uumit.cn', 'x-uumit-public-proto': 'https' })), null)
  assert.equal(sharingMetadata(entry, H({ 'x-uumit-public-host': 'dsh--my-mac.uumit.cn', 'x-uumit-public-proto': 'http' })), null)
  assert.equal(sharingMetadata(entry, H({ 'x-uumit-public-host': ['dsh--my-mac.uumit.cn', 'x'], 'x-uumit-public-proto': 'https' })), null)
  assert.equal(sharingMetadata(entry, H({ 'x-uumit-public-proto': 'https' })), null)
  assert.equal(canonicalAuthority('u@h', 'https'), '')
})

test('浏览器上下文：跨站只放顶层导航，Origin 必须是本应用', () => {
  const meta = { host: 'dsh--my-mac.uumit.cn', scheme: 'https' }
  assert.ok(browserContextAllowed(H({ 'sec-fetch-site': 'same-origin', origin: 'https://dsh--my-mac.uumit.cn' }), meta))
  assert.ok(browserContextAllowed(H({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), meta))
  assert.ok(!browserContextAllowed(H({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }), meta))
  assert.ok(!browserContextAllowed(H({ origin: 'https://evil.example' }), meta))
  assert.ok(!browserContextAllowed(H({ origin: 'http://dsh--my-mac.uumit.cn' }), meta))
  assert.ok(!browserContextAllowed(H({ 'sec-fetch-site': 'bogus' }), meta))
})

test('主人桌面动作与首页注入', () => {
  assert.deepEqual(hostDesktopAction('GET', '/open-in-app/apps', null), { status: 200, body: '{"apps":[]}' })
  assert.equal(hostDesktopAction('POST', '/api/present.open', null).status, 403)
  const v = hostDesktopAction('POST', '/api/session/canOpenWorkspacePath', '{"type":"client-request","rpcId":"r1"}')
  assert.deepEqual(JSON.parse(v.body), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: false } })
  const f = JSON.parse(hostDesktopAction('POST', '/api/session/openWorkspacePath', '{"type":"client-request","rpcId":"r2"}').body)
  assert.equal(f.result.ok, false)
  assert.equal(hostDesktopAction('POST', '/api/session/openWorkspacePath', 'x').status, 400)
  assert.equal(hostDesktopAction('GET', '/api/x', null), null)
  assert.match(injectHostMode('<html><HEAD lang="x"><title>t</title>'), /<HEAD lang="x"><script>window\.__DSH_TRANSPORT__/)
  assert.equal(injectHostMode('no head'), 'no head')
  assert.equal(JSON.parse(disableHostDesktop('{"result":{"value":{"available":true,"host":"m"}}}')).result.value.available, false)
  assert.ok(isLocalOnlyPath('/uumit-remote') && isLocalOnlyPath('/uumit-remote/api/status') && !isLocalOnlyPath('/uumit-remotex'))
  assert.equal(cleanPath('/?token=abc&x=1'), '/?x=1')
  assert.equal(cleanPath('/a?token=abc'), '/a?token=abc')
})

test('内部凭据：只接受 HttpOnly、SameSite=Strict 的 dsh-auth-*', () => {
  assert.equal(parseAuthCookies(['dsh-auth-3080=abc; Path=/; HttpOnly; SameSite=Strict']), 'dsh-auth-3080=abc')
  assert.throws(() => parseAuthCookies(['other=1; HttpOnly; SameSite=Strict']))
  assert.throws(() => parseAuthCookies(['dsh-auth-x=1; SameSite=Strict']))
  assert.throws(() => parseAuthCookies(['dsh-auth-x=1; HttpOnly; SameSite=Lax']))
  assert.throws(() => parseAuthCookies(['dsh-auth-x=1; HttpOnly; SameSite=Strict; Domain=evil']))
  assert.throws(() => parseAuthCookies([]))
})

// --- 端到端：假 DSH + 回环代理 + 进程内服务器 ---

function fakeDSH() {
  const seen = []
  let issued = 0
  let reject401 = 0
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/' && u.searchParams.get('token') === 'launch') {
      issued++
      res.writeHead(303, { location: './', 'set-cookie': `dsh-auth-test=c${issued}; Path=/; HttpOnly; SameSite=Strict` })
      return res.end()
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers })
    if (!String(req.headers.cookie || '').startsWith('dsh-auth-test=') || reject401 > 0) {
      reject401 = Math.max(0, reject401 - 1)
      res.writeHead(401, { 'content-type': 'text/plain' })
      return res.end('dsh web authentication required; reopen the URL printed by dsh web.')
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'leak=1', etag: 'W/1' })
      return res.end('<!doctype html><html><head><title>DSH</title></head><body></body></html>')
    }
    if (u.pathname === '/api/session/workspaceDesktop') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"type":"server-response","result":{"ok":true,"value":{"available":true,"hostname":"mac"}}}')
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=2' })
    res.end(JSON.stringify({ path: u.pathname }))
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ method: 'UPGRADE', url: req.url, headers: req.headers })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        seen,
        issued: () => issued,
        reject: (n) => (reject401 = n),
        close: () => server.close(),
      }),
    ),
  )
}

async function harness(initial = { service: 'dsh', tier: 'private', proxy: 'my-mac--dsh', entry }) {
  let rule = initial
  const dsh = await fakeDSH()
  const connection = { authenticatedUrl: (base) => `${base}?token=launch` }
  const innerAuth = new InnerAuth(connection, () => dsh.origin)
  const proxy = new LoopbackProxy({ origin: () => dsh.origin, innerAuth })
  const tunnel = createTunnelServer(proxy)
  const front = net.createServer((sock) => tunnel.accept(sock, () => rule))
  await new Promise((r) => front.listen(0, '127.0.0.1', r))
  const port = front.address().port
  const request = (path, headers = {}, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  return {
    dsh,
    port,
    request,
    setRule: (r) => (rule = r),
    close: () => {
      front.close()
      proxy.close()
      dsh.close()
    },
  }
}

const ownerHeaders = {
  'x-uumit-caller-type': 'owner',
  'x-uumit-caller-id': OWNER,
  'x-uumit-public-host': 'dsh--my-mac.uumit.cn',
  'x-uumit-public-proto': 'https',
  'x-forwarded-for': '203.0.113.9',
}

test('回环代理：改写为本机形态、附内部凭据、删除 Set-Cookie、首页注入宿主模式', async () => {
  const h = await harness()
  try {
    const r = await h.request('/?token=evil', { ...ownerHeaders, cookie: 'uu_aa_s=platform', origin: 'https://dsh--my-mac.uumit.cn', 'sec-fetch-site': 'same-origin', accept: 'text/html' })
    assert.equal(r.status, 200)
    assert.match(r.body, /<head><script>window\.__DSH_TRANSPORT__/)
    assert.equal(r.headers['set-cookie'], undefined)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers.etag, undefined)
    assert.equal(r.headers['x-uumit-tunnel'], '1')
    const seen = h.dsh.seen.at(-1)
    assert.equal(seen.url, '/')
    assert.equal(seen.headers.host, new URL(h.dsh.origin).host)
    assert.equal(seen.headers.cookie, 'dsh-auth-test=c1')
    assert.equal(seen.headers.origin, undefined)
    assert.equal(seen.headers['sec-fetch-site'], 'same-origin')
    assert.equal(seen.headers['x-uumit-caller-id'], undefined)
    assert.equal(seen.headers['x-uumit-dsh-remote'], '1')
    assert.equal(seen.headers['x-forwarded-host'], 'dsh--my-mac.uumit.cn')
    assert.equal(seen.headers['x-forwarded-proto'], 'https')
    assert.equal(seen.headers['x-forwarded-for'], '203.0.113.9')
    assert.equal(seen.headers['accept-encoding'], 'identity')

    const api = await h.request('/api/session/list', { ...ownerHeaders, 'content-type': 'application/json' }, 'POST', '{"a":1}')
    assert.equal(api.status, 200)
    assert.equal(api.headers['set-cookie'], undefined)
    assert.equal(h.dsh.issued(), 1, 'cookie cached across requests')

    const desk = await h.request('/api/session/workspaceDesktop', ownerHeaders, 'POST', '{"type":"client-request","rpcId":"x"}')
    assert.equal(JSON.parse(desk.body).result.value.available, false)
  } finally {
    h.close()
  }
})

test('回环代理：旧路径入口的页面导航跳到独立网址同一路径，其余请求仍按旧路径拒绝', async () => {
  const h = await harness({ service: 'dsh', tier: 'granted', proxy: 'my-mac--dsh', entry })
  const legacyHost = { 'x-uumit-public-host': 'my-mac.uumit.cn', 'x-uumit-public-proto': 'https' }
  const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site', accept: 'text/html' }
  const member = { 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': GRANT }
  try {
    const page = await h.request('/sessions/abc?tab=1', { ...member, ...legacyHost, ...nav })
    assert.equal(page.status, 302)
    assert.equal(page.headers.location, 'https://dsh--my-mac.uumit.cn/sessions/abc?tab=1')
    assert.equal(page.headers['cache-control'], 'no-store')

    // 没有 Sec-Fetch 头的老浏览器按 Accept 判断
    const old = await h.request('/', { ...ownerHeaders, ...legacyHost, accept: 'text/html' })
    assert.equal(old.headers.location, 'https://dsh--my-mac.uumit.cn/')

    // 资源、接口、WebSocket 与身份头不合规的导航都不跳转
    const asset = await h.request('/assets/app.js', { ...member, ...legacyHost, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script', accept: 'text/html' })
    assert.equal(asset.status, 400)
    const api = await h.request('/api/a', { ...member, ...legacyHost }, 'POST', '{}')
    assert.equal(api.status, 400)
    const ws = await h.request('/ws', { ...member, ...legacyHost, ...nav, connection: 'Upgrade', upgrade: 'websocket' })
    assert.notEqual(ws.status, 302)
    const noGrant = await h.request('/', { ...legacyHost, ...nav, 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER })
    assert.equal(noGrant.status, 400)
    assert.match(noGrant.body, /独立网址/)

    // 独立网址未开启时保留原提示
    h.setRule({ service: 'dsh', tier: 'granted', proxy: 'my-mac--dsh', entry: serviceEntry('https://my-mac.uumit.cn', 'my-mac', 'dsh', false) })
    const off = await h.request('/', { ...member, ...legacyHost, ...nav })
    assert.equal(off.status, 400)
    assert.equal(h.dsh.seen.length, 0, 'nothing reached DSH')
  } finally {
    h.close()
  }
})

test('回环代理：DSH 返回 401 时重换内部凭据并重试一次 GET', async () => {
  const h = await harness()
  try {
    await h.request('/api/a', ownerHeaders)
    h.dsh.reject(1)
    const r = await h.request('/api/b', ownerHeaders)
    assert.equal(r.status, 200)
    assert.equal(h.dsh.issued(), 2)
  } finally {
    h.close()
  }
})

test('回环代理：拒绝非成员、他人主机、旧路径与本机管理页；DSH 不可达返回信号头', async () => {
  const h = await harness()
  try {
    const member = await h.request('/', { ...ownerHeaders, 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, accept: 'text/html' })
    assert.equal(member.status, 403)
    assert.match(member.body, /没有权限/)
    const other = await h.request('/', { ...ownerHeaders, 'x-uumit-public-host': 'dsh--evil.uumit.cn' })
    assert.equal(other.status, 400)
    const legacy = await h.request('/', { ...ownerHeaders, 'x-uumit-public-host': 'my-mac.uumit.cn' })
    assert.equal(legacy.status, 400)
    assert.match(legacy.body, /独立网址/)
    const local = await h.request('/uumit-remote/api/exposure', ownerHeaders, 'POST', '{}')
    assert.equal(local.status, 404)
    const cross = await h.request('/api/a', { ...ownerHeaders, origin: 'https://evil.example' })
    assert.equal(cross.status, 403)
    assert.equal(h.dsh.seen.length, 0, 'nothing reached DSH')
  } finally {
    h.close()
  }
  const dead = await harness()
  dead.dsh.close()
  try {
    const r = await new Promise((res) => setTimeout(res, 20)).then(() => dead.request('/api/a', ownerHeaders))
    assert.ok(r.status === 502 || r.status === 503)
  } finally {
    dead.close()
  }
})

test('回环代理：授权档成员可访问，WebSocket 升级同样附内部凭据', async () => {
  const h = await harness({ service: 'dsh', tier: 'granted', proxy: 'my-mac--dsh', entry })
  try {
    const r = await h.request('/api/x', { ...ownerHeaders, 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': GRANT })
    assert.equal(r.status, 200)
    const echoed = await new Promise((resolve, reject) => {
      const s = net.connect(h.port, '127.0.0.1', () => {
        const lines = [
          'GET /api/remote.mux HTTP/1.1',
          'Host: whatever',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `X-UUMit-Caller-Type: owner`,
          `X-UUMit-Caller-Id: ${OWNER}`,
          'X-UUMit-Public-Host: dsh--my-mac.uumit.cn',
          'X-UUMit-Public-Proto: https',
          'Origin: https://dsh--my-mac.uumit.cn',
        ]
        s.write(lines.join('\r\n') + '\r\n\r\n')
      })
      let buf = ''
      s.on('data', (d) => {
        buf += d
        if (buf.includes('\r\n\r\n') && !buf.includes('frame')) s.write('frame')
        if (buf.endsWith('frame')) {
          s.destroy()
          resolve(buf)
        }
      })
      s.on('error', reject)
    })
    assert.match(echoed, /^HTTP\/1\.1 101/)
    const up = h.dsh.seen.find((x) => x.method === 'UPGRADE')
    assert.equal(up.headers.cookie, 'dsh-auth-test=c1')
    assert.equal(up.headers.origin, undefined)
    assert.equal(up.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==')
    assert.equal(up.headers.upgrade, 'websocket')
  } finally {
    h.close()
  }
})

test('回环代理：规则逐请求读取，同一条保持连接上的档位变化立即生效', async () => {
  const h = await harness()
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const get = (headers) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: h.port, path: '/api/x', headers, agent }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }).on('error', reject)
    })
  const member = { ...ownerHeaders, 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': GRANT }
  try {
    assert.equal(await get(ownerHeaders), 200)
    assert.equal(await get(member), 403)
    h.setRule({ service: 'dsh', tier: 'granted', proxy: 'my-mac--dsh', entry })
    assert.equal(await get(member), 200)
    h.setRule({ service: 'dsh', tier: 'private', proxy: 'my-mac--dsh', entry })
    assert.equal(await get(member), 403)
    h.setRule(null)
    assert.equal(await get(ownerHeaders), 404)
  } finally {
    agent.destroy()
    h.close()
  }
})
