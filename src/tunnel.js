// 通道管理：按期望状态维持一条 frp 会话，断线退避重连，直连连续失败时改走 443 WSS，
// 并把拒绝原因归类给上层（撤销 → 停止；wrong node → 重拉配置）。
import { EventEmitter } from 'node:events'
import { dialTunnel, insecureTLSFromEnv, trustedCA } from './frp/transport.js'
import { FrpRejectError, FrpSession } from './frp/client.js'

export const BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.2, stableMs: 60_000 })
const TRANSPORT_FAILURES_BEFORE_WSS = 3
const WSS_STICKY_MS = 24 * 60 * 60 * 1000

export const REASON = Object.freeze({
  DEVICE_REVOKED: 'device revoked',
  CREDENTIAL_INVALID: 'device credential invalid',
  WRONG_NODE: 'wrong node',
})

/** 拒绝原因分类；frps 可能在原因前加前缀，按包含判断。 */
export function classifyReason(reason) {
  const r = String(reason || '').toLowerCase()
  if (r.includes(REASON.DEVICE_REVOKED) || r.includes(REASON.CREDENTIAL_INVALID)) return 'revoked'
  if (r.includes(REASON.WRONG_NODE)) return 'wrong_node'
  return 'other'
}

export function nextDelay(attempt, { initialMs, maxMs, factor, jitter } = BACKOFF, random = Math.random) {
  const base = Math.min(maxMs, initialMs * factor ** attempt)
  const spread = base * jitter * (random() * 2 - 1)
  return Math.max(0, Math.round(base + spread))
}

function sameConnection(a, b) {
  if (!a || !b) return false
  return (
    a.nodeId === b.nodeId &&
    a.serverAddr === b.serverAddr &&
    a.serverPort === b.serverPort &&
    a.tls === b.tls &&
    a.fallbackPort === b.fallbackPort &&
    a.token === b.token &&
    a.user === b.user &&
    a.deviceCredential === b.deviceCredential &&
    a.heartbeatIntervalMs === b.heartbeatIntervalMs &&
    a.heartbeatTimeoutMs === b.heartbeatTimeoutMs
  )
}

export class TunnelManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {(proxy: string, stream: import('node:stream').Duplex) => void} o.onWorkConn
   * @param {{info?: Function, warn?: Function}} [o.log]
   * @param {Record<string,string|undefined>} [o.env]
   * @param {Function} [o.dial] 测试注入
   * @param {{transport?: string, wssUntil?: number}} [o.persisted] 上次记住的传输方式
   * @param {(p: object) => void} [o.persist]
   */
  constructor({ onWorkConn, log = {}, env = process.env, dial = dialTunnel, sessionFactory = (o) => new FrpSession(o), persisted = {}, persist = () => {}, random = Math.random }) {
    super()
    this.onWorkConn = onWorkConn
    this.log = log
    this.env = env
    this.dial = dial
    this.sessionFactory = sessionFactory
    this.persist = persist
    this.random = random
    this.desired = null
    this.proxies = []
    this.session = null
    this.running = false
    this.state = 'stopped'
    this.reason = ''
    this.since = Date.now()
    this.transport = persisted.transport === 'wss' && persisted.wssUntil > Date.now() ? 'wss' : 'tls'
    this.wssUntil = persisted.wssUntil || 0
    this.transportFailures = 0
    this.proxyStates = new Map()
    this.wake = null
    this.generation = 0
  }

  /** 期望状态：连接参数变化时重连；只有代理变化时在当前会话上增删。 */
  configure(desired, proxies) {
    const reconnect = !sameConnection(this.desired, desired)
    this.desired = desired
    this.proxies = proxies
    for (const name of [...this.proxyStates.keys()]) if (!proxies.some((p) => p.name === name)) this.proxyStates.delete(name)
    if (!this.running) {
      this.running = true
      this._loop()
      return
    }
    if (reconnect) {
      this.session?.close('configuration changed')
      this._wake()
    } else {
      this.session?.setProxies(proxies)
    }
  }

  stop() {
    this.running = false
    this.generation++
    this.session?.close('stopped')
    this.session = null
    this.proxyStates.clear()
    this._wake()
    this._set('stopped', '')
  }

  status() {
    return {
      state: this.state,
      reason: this.reason,
      since: new Date(this.since).toISOString(),
      transport: this.transport,
      proxies: Object.fromEntries(this.proxyStates),
    }
  }

  _set(state, reason) {
    if (this.state === state && this.reason === reason) return
    this.state = state
    this.reason = reason
    this.since = Date.now()
    this.emit('status', this.status())
  }

  _wake() {
    const w = this.wake
    this.wake = null
    w?.()
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      t.unref?.()
      this.wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }

  _mode() {
    if (this.transport === 'wss' && this.wssUntil <= Date.now()) {
      this.transport = 'tls'
      this.persist({ transport: 'tls', wssUntil: 0 })
    }
    if (this.transport === 'wss' && this.desired.fallbackPort) return { mode: 'wss', port: this.desired.fallbackPort }
    return { mode: this.desired.tls ? 'tls' : 'tcp', port: this.desired.serverPort }
  }

  async _loop() {
    const gen = this.generation
    let attempt = 0
    let runId = ''
    while (this.running && gen === this.generation) {
      const d = this.desired
      const { mode, port } = this._mode()
      this._set('connecting', '')
      let conn
      try {
        conn = await this.dial({
          mode,
          host: d.serverAddr,
          port,
          ca: trustedCA(this.env),
          insecure: insecureTLSFromEnv(this.env),
        })
      } catch (err) {
        if (!this.running || gen !== this.generation) return
        this.transportFailures++
        this.log.warn?.(`tunnel connect failed (${mode}): ${err.message}`)
        if (mode !== 'wss' && this.transportFailures >= TRANSPORT_FAILURES_BEFORE_WSS && d.fallbackPort) {
          this.transport = 'wss'
          this.wssUntil = Date.now() + WSS_STICKY_MS
          this.transportFailures = 0
          this.persist({ transport: 'wss', wssUntil: this.wssUntil })
          this.log.info?.('switching tunnel to WSS fallback')
          continue
        }
        this._set('offline', 'network_unavailable')
        await this._sleep(nextDelay(attempt++, BACKOFF, this.random))
        continue
      }
      if (!this.running || gen !== this.generation || d !== this.desired) {
        conn.destroy()
        continue
      }
      this.transportFailures = 0
      // 每次新会话都重新登记代理，旧会话的代理状态不再有效
      this.proxyStates.clear()
      const session = this.sessionFactory({
        conn,
        token: d.token,
        user: d.user,
        metas: { device_credential: d.deviceCredential },
        runId,
        heartbeatIntervalMs: d.heartbeatIntervalMs,
        heartbeatTimeoutMs: d.heartbeatTimeoutMs,
      })
      this.session = session
      session.on('workConn', (proxy, stream) => this.onWorkConn(proxy, stream))
      session.on('proxy', (name, s) => {
        if (s.state === 'closed') this.proxyStates.delete(name)
        else this.proxyStates.set(name, s)
        if (s.state === 'rejected') {
          this.log.warn?.(`proxy ${name} rejected: ${s.reason}`)
          if (classifyReason(s.reason) === 'revoked') this._revoked(s.reason)
          else if (classifyReason(s.reason) === 'wrong_node') this.emit('wrongNode', s.reason)
        }
        this.emit('status', this.status())
      })
      let rejected = null
      session.on('reject', (err) => (rejected = err))
      const closed = new Promise((resolve) => session.once('close', resolve))
      session.setProxies(this.proxies)
      const started = Date.now()
      try {
        const r = await session.start()
        runId = r.runId
        this._set('online', '')
        this.emit('online', { transport: mode === 'wss' ? 'wss' : 'tls' })
      } catch (err) {
        rejected = err instanceof FrpRejectError ? err : null
        if (!rejected) this.log.warn?.(`tunnel login failed: ${err.message}`)
      }
      const reason = await closed
      this.session = null
      if (!this.running || gen !== this.generation) return
      if (Date.now() - started >= BACKOFF.stableMs) attempt = 0
      if (rejected) {
        const kind = classifyReason(rejected.reason)
        this.log.warn?.(`tunnel rejected (${rejected.stage}): ${rejected.reason}`)
        if (kind === 'revoked') {
          this._revoked(rejected.reason)
          return
        }
        if (kind === 'wrong_node') this.emit('wrongNode', rejected.reason)
        this._set('offline', kind === 'wrong_node' ? 'wrong_node' : 'rejected')
      } else {
        this._set('offline', reason === 'configuration changed' ? '' : 'disconnected')
      }
      if (reason === 'configuration changed') continue
      await this._sleep(nextDelay(attempt++, BACKOFF, this.random))
    }
  }

  _revoked(reason) {
    this.running = false
    this.generation++
    this.session?.close('device revoked')
    this.session = null
    this._set('revoked', 'device_revoked')
    this.emit('revoked', reason)
  }
}
