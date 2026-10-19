import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TunnelManager, classifyReason, nextDelay } from '../src/tunnel.js'
import { FrpRejectError } from '../src/frp/client.js'
import { RemoteAgent } from '../src/agent.js'
import { APIError } from '../src/control/api.js'
import { Store } from '../src/control/store.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await wait(5)
  }
  throw new Error('condition not met')
}

test('拒绝原因分类与退避', () => {
  assert.equal(classifyReason('device revoked'), 'revoked')
  assert.equal(classifyReason('plugin reject: device credential invalid'), 'revoked')
  assert.equal(classifyReason('wrong node'), 'wrong_node')
  assert.equal(classifyReason('service not published'), 'other')
  const mid = () => 0.5
  assert.equal(nextDelay(0, undefined, mid), 1000)
  assert.equal(nextDelay(3, undefined, mid), 8000)
  assert.equal(nextDelay(20, undefined, mid), 60000)
  assert.equal(nextDelay(0, undefined, () => 1), 1200)
  assert.equal(nextDelay(0, undefined, () => 0), 800)
})

class FakeSession extends EventEmitter {
  constructor(opts, behavior) {
    super()
    this.opts = opts
    this.behavior = behavior
    this.proxies = []
  }
  setProxies(p) {
    this.proxies = p
  }
  async start() {
    const b = this.behavior(this)
    if (b instanceof Error) {
      setImmediate(() => this.emit('close', b.message))
      throw b
    }
    return { runId: 'run-1' }
  }
  close(reason) {
    this.emit('close', reason)
  }
}

const desired = { nodeId: 'n1', serverAddr: 'frps.example', serverPort: 7443, tls: true, fallbackPort: 443, token: 't', user: 'u', deviceCredential: 'dvc', heartbeatIntervalMs: 10000, heartbeatTimeoutMs: 30000 }

test('通道：直连连续 3 次失败后改用 WSS 并记住', async () => {
  const modes = []
  const persisted = []
  const t = new TunnelManager({
    onWorkConn() {},
    random: () => 0,
    dial: async ({ mode }) => {
      modes.push(mode)
      if (mode !== 'wss') throw new Error('connect ECONNREFUSED')
      return new PassThrough()
    },
    sessionFactory: (o) => new FakeSession(o, () => null),
    persist: (p) => persisted.push(p),
  })
  // 测试里把退避缩短
  t._sleep = () => wait(1)
  t.configure(desired, [])
  await until(() => t.status().state === 'online')
  assert.deepEqual(modes, ['tls', 'tls', 'tls', 'wss'])
  assert.equal(t.status().transport, 'wss')
  assert.equal(persisted[0].transport, 'wss')
  t.stop()
})

test('通道：登录被拒为 device revoked 时停止并发出 revoked', async () => {
  let revoked = null
  let dials = 0
  const t = new TunnelManager({
    onWorkConn() {},
    dial: async () => {
      dials++
      return new PassThrough()
    },
    sessionFactory: (o) => new FakeSession(o, () => new FrpRejectError('device revoked', 'login')),
  })
  t._sleep = () => wait(1)
  t.on('revoked', (r) => (revoked = r))
  t.configure(desired, [])
  await until(() => revoked !== null)
  await wait(20)
  assert.equal(dials, 1)
  assert.equal(t.status().state, 'revoked')
})

test('通道：wrong node 发事件并退避重试；只改代理时不重连', async () => {
  let wrong = 0
  let n = 0
  const sessions = []
  const t = new TunnelManager({
    onWorkConn() {},
    dial: async () => new PassThrough(),
    sessionFactory: (o) => {
      const s = new FakeSession(o, () => (++n === 1 ? new FrpRejectError('wrong node', 'login') : null))
      sessions.push(s)
      return s
    },
  })
  t._sleep = () => wait(1)
  t.on('wrongNode', () => wrong++)
  t.configure(desired, [])
  await until(() => t.status().state === 'online')
  assert.equal(wrong, 1)
  const count = sessions.length
  t.configure(desired, [{ name: 'h--dsh', subdomain: 'h--dsh' }])
  assert.equal(sessions.length, count)
  assert.deepEqual(sessions.at(-1).proxies, [{ name: 'h--dsh', subdomain: 'h--dsh' }])
  t.configure({ ...desired, serverAddr: 'frps2.example' }, [])
  await until(() => sessions.length === count + 1 && t.status().state === 'online')
  assert.equal(sessions.at(-1).opts.metas.device_credential, 'dvc')
  sessions.at(-1).emit('proxy', 'h--dsh', { state: 'running' })
  assert.deepEqual(t.status().proxies, { 'h--dsh': { state: 'running' } })
  t.stop()
  assert.deepEqual(t.status().proxies, {}, 'stale proxy state cleared on stop')
})

// --- 编排 ---

class FakeAPI {
  constructor() {
    this.calls = []
    this.pollQueue = []
    this.config = baseConfig()
    this.registered = false
  }
  async createPairRequest(body) {
    this.calls.push(['C01', body])
    return { device_code: `dc_${this.calls.length}`, user_code: 'UC', confirm_code: 'AB12', verification_url: 'https://uumit.com/address/connect?code=UC', expires_in: 600, interval: 0 }
  }
  async pollPairRequest(code) {
    this.calls.push(['C02', code])
    const next = this.pollQueue.shift() || { status: 'pending', retry_after_seconds: 0 }
    if (next instanceof Error) throw next
    return next
  }
  async pairWithCode(body) {
    this.calls.push(['C03', body])
    return pairingResult()
  }
  async getConfig() {
    this.calls.push(['C04'])
    if (this.configError) throw this.configError
    return this.config
  }
  async reportStatus(body) {
    this.calls.push(['C05', body])
    return { config_version: this.ackVersion || this.config.config_version }
  }
  async registerService(handle, body) {
    this.calls.push(['REG', handle, body])
    this.config = { ...this.config, services: [{ name: 'dsh', kind: 'http', tier: 'private', host_alias_enabled: true, subdomain: 'my-mac--dsh', frp_type: 'http', status: 'active' }] }
  }
  async unpair() {
    this.calls.push(['C16'])
  }
  close() {}
}

function baseConfig() {
  return {
    device_id: '0b7f1c9e-0000-4000-8000-000000000001',
    handle: 'my-mac',
    address: 'https://my-mac.uumit.cn',
    config_version: 'v1',
    edition: 'cn',
    node: { node_id: 'cn-east-1', server_addr: 't1.uumit.cn', server_port: 7443, tls: true, fallback: { protocol: 'wss', server_port: 443 } },
    node_candidates: [],
    tunnel_token: 'tunnel-secret',
    frp_user: '0b7f1c9e-0000-4000-8000-000000000001',
    heartbeat_interval_sec: 10,
    heartbeat_timeout_sec: 30,
    serving_report_interval_sec: 60,
    services: [],
    paused: false,
  }
}

function pairingResult() {
  return { device_id: '0b7f1c9e-0000-4000-8000-000000000001', device_credential: 'dvc_secret', handle: 'my-mac', config: baseConfig() }
}

class FakeTunnel extends EventEmitter {
  constructor() {
    super()
    this.configured = []
    this.stopped = 0
  }
  configure(d, p) {
    this.configured.push({ d, p })
  }
  stop() {
    this.stopped++
  }
  status() {
    return { state: 'online', transport: 'tls', proxies: {} }
  }
}

function makeAgent(api = new FakeAPI(), extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uumit-agent-'))
  const store = new Store(join(dir, 'uumit-remote'))
  const tunnel = new FakeTunnel()
  const agent = new RemoteAgent({
    store,
    dshOrigin: () => 'http://127.0.0.1:1',
    version: '0.1.0',
    env: {},
    clientFactory: () => api,
    tunnelFactory: () => tunnel,
    pollMinMs: 1,
    ...extra,
  })
  return { agent, api, tunnel, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('编排：浏览器确认 → 批准后保存凭证、登记应用、按档位建代理', async () => {
  const { agent, api, tunnel, store, cleanup } = makeAgent()
  try {
    api.pollQueue.push({ status: 'pending', retry_after_seconds: 0 }, { status: 'approved', retry_after_seconds: 0, pairing: pairingResult() })
    const p = await agent.startPairing()
    assert.equal(p.confirm_code, 'AB12')
    assert.ok(!('device_code' in p), 'device_code never exposed')
    const c01 = api.calls[0][1]
    assert.equal(c01.runtime, 'dsh-plugin')
    assert.deepEqual(c01.detected_apps, ['dsh'])
    assert.match(c01.device_fingerprint, /^sha256:/)
    await until(() => agent.status().state === 'paired' && tunnel.configured.length > 0)
    assert.equal(store.loadCredentials().deviceCredential, 'dvc_secret')
    assert.ok(api.calls.some((c) => c[0] === 'REG' && c[2].name === 'dsh' && c[2].kind === 'http'))
    const last = tunnel.configured.at(-1)
    assert.deepEqual(last.p, [{ name: 'my-mac--dsh', subdomain: 'my-mac--dsh' }])
    assert.equal(last.d.token, 'tunnel-secret')
    assert.equal(last.d.deviceCredential, 'dvc_secret')
    assert.equal(last.d.fallbackPort, 443)
    const st = agent.status()
    assert.equal(st.service.entry_url, 'https://dsh--my-mac.uumit.cn/')
    assert.equal(st.web_base, 'https://uumit.com')
    assert.ok(!JSON.stringify(st).includes('dvc_secret') && !JSON.stringify(st).includes('tunnel-secret'))
    agent.stop()
  } finally {
    cleanup()
  }
})

test('编排：关闭档或暂停时不建代理', async () => {
  const api = new FakeAPI()
  api.config = { ...baseConfig(), services: [{ name: 'dsh', kind: 'http', tier: 'disabled', host_alias_enabled: true, subdomain: 'my-mac--dsh', frp_type: 'http', status: 'disabled' }] }
  const { agent, tunnel, cleanup } = makeAgent(api)
  try {
    await agent.pairWithCode('k7qx-m2pa')
    assert.deepEqual(tunnel.configured.at(-1).p, [])
    assert.ok(!api.calls.some((c) => c[0] === 'REG'))
    assert.equal(api.calls.find((c) => c[0] === 'C03')[1].pair_code, 'K7QX-M2PA')
    api.config = { ...api.config, paused: true, services: [{ ...api.config.services[0], tier: 'private', status: 'active' }] }
    await agent.refreshConfig()
    assert.deepEqual(tunnel.configured.at(-1).p, [])
    agent.stop()
  } finally {
    cleanup()
  }
})

test('编排：拒绝、过期自动重发一次', async () => {
  const { agent, api, cleanup } = makeAgent()
  try {
    api.pollQueue.push({ status: 'denied', retry_after_seconds: 0 })
    await agent.startPairing()
    await until(() => agent.status().state === 'unpaired')
    assert.equal(agent.status().last_error.error_code, 'PAIRING_DENIED')
    api.pollQueue.push({ status: 'expired', retry_after_seconds: 0 }, { status: 'expired', retry_after_seconds: 0 })
    await agent.startPairing()
    await until(() => agent.status().state === 'unpaired')
    assert.equal(api.calls.filter((c) => c[0] === 'C01').length, 3)
    assert.equal(agent.status().last_error.error_code, 'PAIRING_EXPIRED')
  } finally {
    agent.stop()
    cleanup()
  }
})

test('编排：配置接口返回 DEVICE_REVOKED 时停止通道、删除凭证并提示重新连接', async () => {
  const { agent, api, tunnel, store, cleanup } = makeAgent()
  try {
    await agent.pairWithCode('K7QXM2PA')
    api.configError = new APIError({ httpStatus: 401, errorCode: 'DEVICE_REVOKED', message: 'revoked' })
    await agent.refreshConfig()
    assert.equal(store.loadCredentials(), null)
    assert.ok(tunnel.stopped > 0)
    const st = agent.status()
    assert.equal(st.state, 'unpaired')
    assert.equal(st.revoked, true)
    assert.equal(st.last_error.error_code, 'DEVICE_REVOKED')
  } finally {
    agent.stop()
    cleanup()
  }
})

test('编排：状态回执版本变化时立即重拉配置；断开调用 C16 并清理', async () => {
  const { agent, api, store, cleanup } = makeAgent()
  try {
    await agent.pairWithCode('K7QXM2PA')
    const before = api.calls.filter((c) => c[0] === 'C04').length
    api.ackVersion = 'v2'
    await agent.reportStatus()
    const c05 = api.calls.find((c) => c[0] === 'C05')[1]
    assert.equal(c05.services[0].name, 'dsh')
    assert.equal(c05.services[0].local_reachable, false)
    assert.equal(c05.connector_version, '0.1.0')
    assert.ok(api.calls.filter((c) => c[0] === 'C04').length > before)
    await agent.unpair()
    assert.ok(api.calls.some((c) => c[0] === 'C16'))
    assert.equal(store.loadCredentials(), null)
    assert.equal(agent.status().state, 'unpaired')
  } finally {
    agent.stop()
    cleanup()
  }
})

test('编排：重启后续上未过期的确认请求', async () => {
  const api = new FakeAPI()
  const first = makeAgent(api)
  await first.agent.startPairing()
  first.agent.stop()
  const second = new RemoteAgent({ store: first.store, dshOrigin: () => 'http://127.0.0.1:1', version: '0.1.0', env: {}, clientFactory: () => api, tunnelFactory: () => new FakeTunnel(), pollMinMs: 1 })
  try {
    api.pollQueue.push({ status: 'approved', retry_after_seconds: 0, pairing: pairingResult() })
    await second.init()
    assert.equal(second.status().state, 'pairing')
    await until(() => second.status().state === 'paired')
  } finally {
    second.stop()
    first.cleanup()
  }
})
