// frp 客户端会话（frp 0.71.0 wire v1 子集）：登录、控制通道、http 代理、工作连接、心跳。
// 一次会话对应一条底层连接；断线与重连由上层 tunnel.js 负责。
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { YamuxSession } from './yamux.js'
import { Decoder, encode, readMessage } from './msg.js'
import { CfbReader, CfbWriter, deriveKey, privilegeKey } from './cfb.js'

export const FRP_VERSION = '0.71.0'
const LOGIN_TIMEOUT_MS = 10_000

/** frps 或网关插件明确拒绝（登录、代理或心跳），message 为协议原因字符串。 */
export class FrpRejectError extends Error {
  constructor(reason, stage) {
    super(reason)
    this.name = 'FrpRejectError'
    this.reason = reason
    this.stage = stage
  }
}

export function goOS(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform
}

export function goArch(arch = process.arch) {
  return { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[arch] || arch
}

function now() {
  return Math.floor(Date.now() / 1000)
}

export class FrpSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('node:stream').Duplex} o.conn 底层连接
   * @param {string} o.token 部署参数 tunnel_token
   * @param {string} o.user frp user（= device_id）
   * @param {Record<string,string>} [o.metas] Login.metas（device_credential）
   * @param {string} [o.runId] 上一次会话的 run_id
   * @param {number} [o.heartbeatIntervalMs]
   * @param {number} [o.heartbeatTimeoutMs]
   */
  constructor({ conn, token, user, metas = {}, runId = '', heartbeatIntervalMs = 10_000, heartbeatTimeoutMs = 30_000 }) {
    super()
    this.conn = conn
    this.token = token
    this.user = user
    this.metas = metas
    this.prevRunId = runId
    this.runId = ''
    this.heartbeatIntervalMs = heartbeatIntervalMs
    this.heartbeatTimeoutMs = heartbeatTimeoutMs > heartbeatIntervalMs ? heartbeatTimeoutMs : heartbeatIntervalMs * 3
    this.proxies = new Map()
    this.closed = false
    this.timers = []
  }

  /** 登录；成功后开始收发控制消息。被拒绝时抛 FrpRejectError。 */
  async start() {
    this.mux = new YamuxSession(this.conn)
    this.mux.on('close', (err) => this._close(err && err.message ? err.message : 'connection closed'))
    const ctl = this.mux.open()
    this.ctl = ctl
    const timestamp = now()
    ctl.write(
      encode('Login', {
        version: FRP_VERSION,
        hostname: os.hostname(),
        os: goOS(),
        arch: goArch(),
        user: this.user,
        privilege_key: privilegeKey(this.token, timestamp),
        timestamp,
        run_id: this.prevRunId || undefined,
        metas: this.metas,
        pool_count: 1,
      }),
    )
    let resp
    try {
      resp = await readMessage(ctl, { timeoutMs: LOGIN_TIMEOUT_MS })
    } catch (err) {
      this._close('login failed')
      throw err
    }
    if (resp.name !== 'LoginResp') {
      this._close('unexpected login response')
      throw new Error(`unexpected ${resp.name} before LoginResp`)
    }
    if (resp.body.error) {
      this._close(resp.body.error)
      throw new FrpRejectError(String(resp.body.error), 'login')
    }
    this.runId = String(resp.body.run_id || '')
    const key = deriveKey(this.token)
    this.writer = new CfbWriter(key)
    const reader = new CfbReader(key)
    const decoder = new Decoder()
    ctl.on('data', (chunk) => {
      let msgs
      try {
        msgs = decoder.push(reader.decrypt(chunk))
      } catch (err) {
        this._close(`protocol error: ${err.message}`)
        return
      }
      for (const m of msgs) this._dispatch(m)
    })
    ctl.on('end', () => this._close('control stream ended'))
    ctl.on('error', (err) => this._close(err.message))
    this.lastPong = Date.now()
    this._startHeartbeat()
    for (const p of this.proxies.values()) this._sendNewProxy(p)
    return { runId: this.runId }
  }

  /** 设置期望的 http 代理集合：[{name, subdomain}]；增删以差异发送。 */
  setProxies(list) {
    const want = new Map(list.map((p) => [p.name, p]))
    for (const [name, p] of this.proxies) {
      const w = want.get(name)
      if (!w || w.subdomain !== p.subdomain) {
        this.proxies.delete(name)
        if (this.writer) this._send('CloseProxy', { proxy_name: name })
        this.emit('proxy', name, { state: 'closed' })
      }
    }
    for (const [name, p] of want) {
      if (this.proxies.has(name)) continue
      this.proxies.set(name, { ...p })
      if (this.writer) this._sendNewProxy(p)
    }
  }

  close(reason = 'closed by client') {
    if (this.closed) return
    this.mux?.close()
    this._close(reason)
  }

  _sendNewProxy(p) {
    this._send('NewProxy', { proxy_name: p.name, proxy_type: 'http', subdomain: p.subdomain })
    this.emit('proxy', p.name, { state: 'pending' })
  }

  _send(name, body) {
    if (this.closed || !this.writer) return
    this.ctl.write(this.writer.encrypt(encode(name, body)))
  }

  _stripUser(name) {
    const prefix = `${this.user}.`
    return name.startsWith(prefix) ? name.slice(prefix.length) : name
  }

  _dispatch({ name, body }) {
    switch (name) {
      case 'ReqWorkConn':
        this._newWorkConn()
        break
      case 'NewProxyResp': {
        const proxy = this._stripUser(String(body.proxy_name || ''))
        if (body.error) this.emit('proxy', proxy, { state: 'rejected', reason: String(body.error) })
        else this.emit('proxy', proxy, { state: 'running' })
        break
      }
      case 'Pong':
        if (body.error) {
          this.emit('reject', new FrpRejectError(String(body.error), 'ping'))
          this.close(String(body.error))
          return
        }
        this.lastPong = Date.now()
        break
      default:
        break
    }
  }

  async _newWorkConn() {
    if (this.closed) return
    let s
    try {
      s = this.mux.open()
    } catch {
      return
    }
    const timestamp = now()
    s.write(encode('NewWorkConn', { run_id: this.runId, privilege_key: privilegeKey(this.token, timestamp), timestamp }))
    let start
    try {
      start = await readMessage(s)
    } catch {
      s.destroy()
      return
    }
    if (start.name !== 'StartWorkConn' || start.body.error) {
      s.destroy()
      return
    }
    const proxy = this._stripUser(String(start.body.proxy_name || ''))
    if (!this.proxies.has(proxy)) {
      s.destroy()
      return
    }
    this.emit('workConn', proxy, s, start.body)
  }

  _startHeartbeat() {
    if (this.heartbeatIntervalMs <= 0) return
    const ping = setInterval(() => {
      const timestamp = now()
      this._send('Ping', { privilege_key: privilegeKey(this.token, timestamp), timestamp })
    }, this.heartbeatIntervalMs)
    const check = setInterval(() => {
      if (Date.now() - this.lastPong > this.heartbeatTimeoutMs) this.close('heartbeat timeout')
    }, 1000)
    ping.unref?.()
    check.unref?.()
    this.timers.push(ping, check)
  }

  _close(reason) {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.mux && !this.mux.closed) this.mux.close()
    this.emit('close', reason)
  }
}
