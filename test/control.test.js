import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlatformClient, APIError, normalizeAPIBase, isCredentialRejected } from '../src/control/api.js'
import { Store } from '../src/control/store.js'
import { fingerprint, deviceName, FINGERPRINT_PREFIX } from '../src/control/device.js'
import { serviceEntry, validServiceName } from '../src/control/entry.js'

function fakePlatform(handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
      calls.push(call)
      const out = handler(call, calls.length)
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) })
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })),
  )
}

const ok = (data) => ({ body: { code: 0, message: 'ok', data } })
const fail = (status, errorCode, data = null) => ({ status, body: { code: 9601, message: errorCode, error_code: errorCode, data } })

test('平台入口：https 必须；http 只给本机与内网；必须是 origin', () => {
  assert.equal(normalizeAPIBase('https://api.uumit.com/'), 'https://api.uumit.com')
  assert.equal(normalizeAPIBase('http://127.0.0.1:8010'), 'http://127.0.0.1:8010')
  assert.equal(normalizeAPIBase('http://192.168.4.58:8010'), 'http://192.168.4.58:8010')
  assert.equal(normalizeAPIBase('http://api.cn.test'), 'http://api.cn.test')
  assert.throws(() => normalizeAPIBase('http://api.uumit.com'))
  assert.throws(() => normalizeAPIBase('https://api.uumit.com/v1'))
  assert.throws(() => normalizeAPIBase('https://u:p@api.uumit.com'))
})

test('接口：设备凭证头、信封解包与错误码映射', async () => {
  const p = await fakePlatform((c) => (c.url.endsWith('/config') ? ok({ handle: 'h' }) : fail(401, 'DEVICE_REVOKED')))
  try {
    const api = new PlatformClient({ base: p.base, credential: async () => 'dvc_x', userAgent: 'ua/1' })
    assert.deepEqual(await api.getConfig(), { handle: 'h' })
    assert.equal(p.calls[0].headers.authorization, 'Device dvc_x')
    assert.equal(p.calls[0].headers['user-agent'], 'ua/1')
    assert.equal(p.calls[0].url, '/api/v1/agent-address/connector/config')
    const err = await api.reportStatus({}).catch((e) => e)
    assert.ok(err instanceof APIError)
    assert.equal(err.errorCode, 'DEVICE_REVOKED')
    assert.ok(isCredentialRejected(err))
    api.close()
  } finally {
    p.close()
  }
})

test('接口：5xx 与 429 按 Retry-After 重试，最多 3 次；配对码不重试网络错误', async () => {
  const p = await fakePlatform((_c, n) => (n === 1 ? { status: 503, body: 'x' } : n === 2 ? { ...fail(429, 'RATE_LIMITED'), headers: { 'retry-after': '2' } } : ok({ status: 'pending' })))
  const sleeps = []
  try {
    const api = new PlatformClient({ base: p.base, sleep: async (ms) => sleeps.push(ms) })
    assert.deepEqual(await api.pollPairRequest('dc_1'), { status: 'pending' })
    assert.deepEqual(sleeps, [200, 2000])
    assert.deepEqual(p.calls[2].body, { device_code: 'dc_1' })
    api.close()
  } finally {
    p.close()
  }
  const dead = new PlatformClient({ base: 'http://127.0.0.1:9', sleep: async () => {} })
  const err = await dead.pairWithCode({ pair_code: 'X' }).catch((e) => e)
  assert.ok(err.network)
  dead.close()
})

test('接口：服务登记与授权、邀请带新的 Idempotency-Key', async () => {
  const p = await fakePlatform(() => ok({}))
  try {
    const api = new PlatformClient({ base: p.base, credential: () => 'dvc_x' })
    await api.registerService('my-mac', { name: 'dsh', kind: 'http', title: 'DeepSeek Harness' })
    await api.registerService('my-mac', { name: 'dsh', kind: 'http', title: 'DeepSeek Harness' })
    await api.desktopGrant('dsh', { userId: 'u' })
    await api.desktopInvite('dsh', { expiresInDays: 7, maxUses: 1 })
    assert.equal(p.calls[0].url, '/api/v1/agent-address/handles/my-mac/services')
    const keys = p.calls.map((c) => c.headers['idempotency-key'])
    assert.equal(new Set(keys).size, 4)
    assert.match(keys[2], /^grant-/)
    assert.deepEqual(p.calls[3].body, { expires_in_days: 7, max_uses: 1, note: null })
    api.close()
  } finally {
    p.close()
  }
})

test('接口：本机管理详情按游标合并两侧分页', async () => {
  const p = await fakePlatform((c) => {
    const u = new URL(c.url, 'http://x')
    if (!u.searchParams.get('grants_cursor')) return ok({ service: { name: 'dsh' }, grants: [{ grant_id: 'g1' }], invites: [{ invite_id: 'i1' }], grants_next_cursor: 'G2', invites_next_cursor: null })
    return ok({ service: { name: 'dsh' }, grants: [{ grant_id: 'g2' }], invites: [{ invite_id: 'i1' }], grants_next_cursor: null, invites_next_cursor: null })
  })
  try {
    const api = new PlatformClient({ base: p.base, credential: () => 'dvc_x' })
    const m = await api.desktopManagement('dsh')
    assert.deepEqual(m.grants.map((g) => g.grant_id), ['g1', 'g2'])
    assert.deepEqual(m.invites.map((i) => i.invite_id), ['i1'])
    assert.equal(p.calls.length, 2)
    api.close()
  } finally {
    p.close()
  }
})

test('本地状态：目录 0700、文件 0600、配置快照不含 tunnel_token、断开保留非秘密设置', { skip: process.platform === 'win32' }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'uumit-store-')), 'uumit-remote')
  try {
    const s = new Store(dir)
    s.saveCredentials({ deviceId: 'd', deviceCredential: 'dvc_secret', tunnelToken: 'tok' })
    s.saveConfig({ handle: 'h', tunnel_token: 'tok', node: {} })
    s.saveSettings({ api_base: 'https://api.uumit.com', web_base: 'https://uumit.com', handle: 'h', device_name: 'Mac · DSH' })
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(s.path('credentials')).mode & 0o777, 0o600)
    assert.equal(statSync(s.path('config')).mode & 0o777, 0o600)
    assert.ok(!readFileSync(s.path('config'), 'utf8').includes('tok'))
    assert.deepEqual(s.loadCredentials(), { deviceId: 'd', deviceCredential: 'dvc_secret', tunnelToken: 'tok' })
    s.clearPairing()
    assert.equal(s.loadCredentials(), null)
    assert.equal(s.loadConfig(), null)
    assert.deepEqual(s.loadSettings(), { version: 1, api_base: 'https://api.uumit.com', web_base: 'https://uumit.com', device_name: 'Mac · DSH' })
    assert.equal(s.installId(), s.installId())
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true })
  }
})

function dirname(p) {
  return p.slice(0, p.lastIndexOf('/'))
}

test('设备指纹前缀与电脑名', () => {
  assert.equal(FINGERPRINT_PREFIX, 'uumit-dsh-plugin/fp/v1')
  assert.match(fingerprint('m', 'u'), /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(fingerprint('m', 'u'), fingerprint('m', 'v'))
  assert.equal(deviceName('x'.repeat(80)).length, 64)
  assert.equal(deviceName('', { UUMIT_DEVICE_NAME: '工作电脑' }), '工作电脑')
  assert.match(deviceName('', {}), / · DSH$/)
})

test('应用入口：独立网址与旧路径', () => {
  assert.ok(validServiceName('dsh'))
  assert.ok(!validServiceName('a--b'))
  assert.ok(!validServiceName('tmp-x'))
  assert.deepEqual(serviceEntry('https://my-mac.uumit.cn', 'my-mac', 'dsh', true), {
    scheme: 'https',
    legacyHost: 'my-mac.uumit.cn',
    aliasHost: 'dsh--my-mac.uumit.cn',
    oldAliasHost: 'dsh--my-mac.uumit.cn',
    entryURL: 'https://dsh--my-mac.uumit.cn/',
  })
  assert.equal(serviceEntry('http://my-mac.cn.test:18080', 'my-mac', 'dsh', false).entryURL, 'http://my-mac.cn.test:18080/s/dsh/')
  assert.equal(serviceEntry('https://other.uumit.cn', 'my-mac', 'dsh', true), null)
  assert.equal(serviceEntry('https://1.2.3.4', '1', 'dsh', true), null)
})
