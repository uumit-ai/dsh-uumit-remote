import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagementHandler, ownerRejection, writeRejection } from '../src/ui/routes.js'
import { executeAction, renderResult, connectCode, PARAMETERS, ACTIONS } from '../src/tool.js'
import * as plugin from '../index.js'

class StubAgent {
  constructor() {
    this.calls = []
    this.svc = { name: 'dsh', tier: 'private', status: 'active', host_alias_enabled: true }
    this.api = {
      desktopSetExposure: async (name, o) => {
        this.calls.push(['exposure', name, o])
        return { name, tier: o.tier }
      },
      desktopManagement: async (name) => ({ service: { name }, grants: [], invites: [] }),
      desktopInvite: async (name, o) => {
        this.calls.push(['invite', name, o])
        return { invite_id: 'i', invite_url: 'https://uumit.com/address/invite?t=x' }
      },
      desktopRevokeGrant: async (name, id) => this.calls.push(['revokeGrant', name, id]),
      desktopLookupMember: async () => ({ found: false, is_self: false, person: null }),
    }
    this.st = { state: 'paired', service: { name: 'dsh', tier: 'private', entry_url: 'https://dsh--m.uumit.cn/' }, device: { address: 'https://m.uumit.cn' }, tunnel: { state: 'online' } }
  }
  status() {
    return this.st
  }
  service() {
    return this.svc
  }
  async refreshConfig() {
    this.calls.push(['refresh'])
  }
  async startPairing() {
    this.calls.push(['startPairing'])
    this.st = { state: 'pairing', pairing: { confirm_code: 'AB12', verification_url: 'https://uumit.com/address/connect?code=U' } }
  }
  cancelPairing() {}
  async unpair() {
    this.calls.push(['unpair'])
  }
  async pairWithCode() {
    const e = new Error('配对码是 8 位字母或数字')
    e.code = 'PAIR_CODE_FORMAT'
    throw e
  }
  async goOnline() {}
}

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }))
      })
      req.on('error', reject)
      req.end(body)
    })
  return { call, close: () => server.close() }
}

const authed = { requestRejection: (r) => (String(r.headers.cookie || '').includes('dsh-auth-x=1') ? undefined : 401) }
const cookie = { cookie: 'dsh-auth-x=1' }
const write = { ...cookie, 'content-type': 'application/json', 'x-uumit-remote-ui': '1', 'sec-fetch-site': 'same-origin' }

test('管理页保护：远程标记、非回环 Host、无 DSH 凭据都拒绝；写操作要自定义请求头', () => {
  const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', cookie: 'dsh-auth-x=1' } }
  assert.equal(ownerRejection(base, authed), 0)
  assert.equal(ownerRejection({ ...base, headers: { ...base.headers, 'x-uumit-dsh-remote': '1' } }, authed), 403)
  assert.equal(ownerRejection({ ...base, headers: { ...base.headers, host: 'dsh--m.uumit.cn' } }, authed), 403)
  assert.equal(ownerRejection({ ...base, socket: { remoteAddress: '192.168.1.5' } }, authed), 403)
  assert.equal(ownerRejection({ ...base, headers: { host: '127.0.0.1:3080' } }, authed), 401)
  assert.equal(ownerRejection(base, {}), 403)
  assert.equal(writeRejection({ headers: { 'x-uumit-remote-ui': '1', 'content-type': 'application/json' } }), 0)
  assert.equal(writeRejection({ headers: { 'content-type': 'application/json' } }), 403)
  assert.equal(writeRejection({ headers: { 'x-uumit-remote-ui': '1', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }), 403)
  assert.equal(writeRejection({ headers: { 'x-uumit-remote-ui': '1', 'content-type': 'text/plain' } }), 415)
})

test('管理页：页面带 CSP，状态与设置谁能用，所有人必须确认', async () => {
  const agent = new StubAgent()
  const s = await serve(createManagementHandler({ agent, connection: authed }))
  try {
    const redirect = await s.call('GET', '/uumit-remote')
    assert.equal(redirect.status, 308)
    const pageNoAuth = await s.call('GET', '/uumit-remote/')
    assert.equal(pageNoAuth.status, 401)
    assert.match(pageNoAuth.text, /请先打开 DeepSeek Harness/)
    const page = await s.call('GET', '/uumit-remote/', { headers: cookie })
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /script-src 'self'/)
    assert.match(page.text, /UUMit 远程访问/)
    const js = await s.call('GET', '/uumit-remote/client.js', { headers: cookie })
    assert.match(js.headers['content-type'], /javascript/)
    assert.match(js.text, /__ModuleLoader__\.load/)
    const shim = await s.call('GET', '/uumit-remote/standalone.js', { headers: cookie })
    assert.equal(shim.status, 200)
    const st = await s.call('GET', '/uumit-remote/api/status', { headers: cookie })
    assert.equal(st.json.data.state, 'paired')
    const noHeader = await s.call('POST', '/uumit-remote/api/exposure', { headers: { ...cookie, 'content-type': 'application/json' }, body: '{"tier":"granted"}' })
    assert.equal(noHeader.status, 403)
    const pub = await s.call('POST', '/uumit-remote/api/exposure', { headers: write, body: '{"tier":"public"}' })
    assert.equal(pub.status, 422)
    assert.equal(pub.json.error.error_code, 'CONFIRMATION_REQUIRED')
    const granted = await s.call('POST', '/uumit-remote/api/exposure', { headers: write, body: '{"tier":"granted"}' })
    assert.equal(granted.status, 200)
    const pub2 = await s.call('POST', '/uumit-remote/api/exposure', { headers: write, body: '{"tier":"public","confirm":true}' })
    assert.equal(pub2.status, 200)
    assert.deepEqual(agent.calls.filter((c) => c[0] === 'exposure').map((c) => [c[2].tier, c[2].confirm]), [['granted', null], ['public', true]])
    assert.ok(agent.calls.some((c) => c[0] === 'refresh'))
    const bad = await s.call('POST', '/uumit-remote/api/exposure', { headers: write, body: '{"tier":"everyone"}' })
    assert.equal(bad.status, 422)
    const remote = await s.call('GET', '/uumit-remote/api/status', { headers: { ...cookie, 'x-uumit-dsh-remote': '1' } })
    assert.equal(remote.status, 403)
  } finally {
    s.close()
  }
})

test('管理页：邀请、撤销授权、配对码格式错误与未知接口', async () => {
  const agent = new StubAgent()
  const s = await serve(createManagementHandler({ agent, connection: authed }))
  try {
    const inv = await s.call('POST', '/uumit-remote/api/invites', { headers: write, body: '{"expires_in_days":7,"max_uses":2}' })
    assert.equal(inv.json.data.invite_url, 'https://uumit.com/address/invite?t=x')
    const badInv = await s.call('POST', '/uumit-remote/api/invites', { headers: write, body: '{"expires_in_days":0,"max_uses":2}' })
    assert.equal(badInv.status, 422)
    const rv = await s.call('POST', '/uumit-remote/api/grants/revoke', { headers: write, body: '{"grant_id":"cccccccc-0000-4000-8000-00000000000c"}' })
    assert.equal(rv.status, 200)
    const code = await s.call('POST', '/uumit-remote/api/pair/code', { headers: write, body: '{"code":"x"}' })
    assert.equal(code.json.error.error_code, 'PAIR_CODE_FORMAT')
    const nf = await s.call('GET', '/uumit-remote/api/nope', { headers: cookie })
    assert.equal(nf.status, 404)
    agent.svc = null
    const noSvc = await s.call('GET', '/uumit-remote/api/management', { headers: cookie })
    assert.equal(noSvc.json.error.error_code, 'SERVICE_NOT_REGISTERED')
  } finally {
    s.close()
  }
})

test('Agent 工具：connect 返回确认码，status 说明谁能用，不提供改范围的动作', async () => {
  const agent = new StubAgent()
  const st = await executeAction(agent, 'http://127.0.0.1:3080', { action: 'status' })
  assert.equal(st.who_can_use, '仅自己')
  assert.equal(st.manage_url, 'http://127.0.0.1:3080/uumit-remote/')
  agent.st = { state: 'unpaired' }
  const c = await executeAction(agent, 'http://127.0.0.1:3080', { action: 'connect' })
  assert.equal(c.confirm_code, 'AB12')
  assert.equal(c.connect_code, 'AB12', 'no user_code: falls back to confirm code')
  assert.match(renderResult(c), /connect_code: AB12/)
  // 与客户端一致：8 位连接码按 4-4 加短横线
  assert.equal(connectCode({ user_code: 'k7qxm2pa', confirm_code: 'AB12' }), 'K7QX-M2PA')
  assert.equal(connectCode({ user_code: 'K7QX-M2PA' }), 'K7QX-M2PA')
  agent.st = { state: 'pairing', pairing: { user_code: '12345678', confirm_code: 'AB12', verification_url: 'https://uumit.com/address/connect?code=12345678' } }
  const p8 = await executeAction(agent, 'http://127.0.0.1:3080', { action: 'connect' })
  assert.equal(p8.connect_code, '1234-5678')
  assert.match(p8.say, /1234-5678/)
  const bad = await executeAction(agent, null, { action: 'set_tier' })
  assert.equal(bad.ok, false)
})

test('插件入口：注册管理路由、首页注入与工具，释放时清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uumit-plugin-'))
  const routes = []
  const handlers = {}
  let unregistered = 0
  let toolDisposed = 0
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    webServer: {
      getOrigin: () => 'http://127.0.0.1:3999',
      register: (r) => {
        routes.push(r)
        return () => unregistered++
      },
    },
    connection: { authenticatedUrl: (b) => `${b}?token=t`, requestRejection: () => undefined },
    tools: {
      register: (t) => {
        handlers.tool = t
        return () => toolDisposed++
      },
    },
    on: (ev, fn) => {
      handlers[ev] = fn
    },
  }
  // 模拟 cordis：tools 可用时以子上下文调用回调
  ctx.inject = (deps, cb) => {
    assert.deepEqual(deps, ['tools'])
    const sub = { tools: ctx.tools, on: (ev, fn) => (handlers[`tool:${ev}`] = fn) }
    cb(sub)
  }
  try {
    assert.deepEqual(plugin.inject, ['webServer', 'connection'])
    assert.equal(plugin.name, 'uumit-remote')
    const stop = plugin.apply(ctx, { home: join(dir, 'state'), apiBase: 'http://127.0.0.1:9' })
    assert.deepEqual(routes.map((r) => [r.kind, r.path]), [['prefix', '/uumit-remote']])
    assert.equal(handlers['webserver/index-inject'], undefined, 'no floating entry injected into DSH index')
    assert.equal(handlers.tool.name, 'uumit_remote_access')
    const res = await handlers.tool.execute({ action: 'status' })
    assert.equal(res.state, 'unpaired')
    handlers.dispose()
    handlers['tool:dispose']()
    assert.equal(unregistered, 1)
    assert.equal(toolDisposed, 1)
    stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agent 工具参数是对象根 JSON Schema（DSH tools.register 不接受按属性简写）', () => {
  assert.equal(PARAMETERS.type, 'object')
  assert.deepEqual(PARAMETERS.required, ['action'])
  assert.deepEqual(PARAMETERS.properties.action.enum, ACTIONS)
  assert.equal(PARAMETERS.additionalProperties, false)
})
