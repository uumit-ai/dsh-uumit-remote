// yamux 客户端（hashicorp/yamux 协议版本 0，frp 使用的 fatedier/yamux 分支线上格式相同）。
// 帧头 12 字节：版本(1) 类型(1) 标志(2) 流 ID(4) 长度(4)，大端。
import { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'

const VERSION = 0
const T_DATA = 0
const T_WINDOW_UPDATE = 1
const T_PING = 2
const T_GO_AWAY = 3

const F_SYN = 1
const F_ACK = 2
const F_FIN = 4
const F_RST = 8

const HEADER_BYTES = 12
export const INITIAL_WINDOW = 256 * 1024
const MAX_FRAME_PAYLOAD = 64 * 1024
const GO_AWAY_NORMAL = 0
const GO_AWAY_PROTO_ERR = 1

export class YamuxError extends Error {
  constructor(message) {
    super(message)
    this.name = 'YamuxError'
  }
}

function header(type, flags, streamId, length) {
  const h = Buffer.allocUnsafe(HEADER_BYTES)
  h[0] = VERSION
  h[1] = type
  h.writeUInt16BE(flags, 2)
  h.writeUInt32BE(streamId, 4)
  h.writeUInt32BE(length >>> 0, 8)
  return h
}

export class YamuxSession extends EventEmitter {
  /**
   * @param {import('node:stream').Duplex} conn 已建立的底层连接（TLS 或 WebSocket）
   * @param {{keepAliveMs?: number, pingTimeoutMs?: number}} [opts]
   */
  constructor(conn, { keepAliveMs = 30_000, pingTimeoutMs = 10_000 } = {}) {
    super()
    this.conn = conn
    this.nextId = 1
    this.streams = new Map()
    this.buf = Buffer.alloc(0)
    this.closed = false
    this.pings = new Map()
    this.nextPing = 1
    this.pingTimeoutMs = pingTimeoutMs
    conn.on('data', (d) => this._onData(d))
    conn.on('error', (err) => this._shutdown(err))
    conn.on('close', () => this._shutdown(new YamuxError('connection closed')))
    conn.on('end', () => this._shutdown(new YamuxError('connection ended')))
    if (keepAliveMs > 0) {
      this.keepAlive = setInterval(() => {
        this.ping().catch((err) => this._shutdown(err))
      }, keepAliveMs)
      this.keepAlive.unref?.()
    }
  }

  /** 打开一条新流；SYN 立即发出，不等待 ACK 即可写入（与 hashicorp 行为一致）。 */
  open() {
    if (this.closed) throw new YamuxError('session closed')
    const id = this.nextId
    this.nextId += 2
    const stream = new YamuxStream(this, id)
    this.streams.set(id, stream)
    this._write(header(T_WINDOW_UPDATE, F_SYN, id, 0))
    return stream
  }

  ping() {
    if (this.closed) return Promise.reject(new YamuxError('session closed'))
    const id = this.nextPing++ >>> 0
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pings.delete(id)
        reject(new YamuxError('keepalive timeout'))
      }, this.pingTimeoutMs)
      timer.unref?.()
      this.pings.set(id, () => {
        clearTimeout(timer)
        resolve()
      })
      this._write(header(T_PING, F_SYN, 0, id))
    })
  }

  close() {
    if (this.closed) return
    this._write(header(T_GO_AWAY, 0, 0, GO_AWAY_NORMAL))
    this._shutdown(new YamuxError('session closed'))
    this.conn.end()
  }

  _write(buf) {
    if (this.closed || this.conn.destroyed) return false
    return this.conn.write(buf)
  }

  _shutdown(err) {
    if (this.closed) return
    this.closed = true
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.pings.clear()
    for (const s of this.streams.values()) s._sessionGone(err)
    this.streams.clear()
    if (!this.conn.destroyed) this.conn.destroy()
    this.emit('close', err)
  }

  _protocolError(message) {
    this._write(header(T_GO_AWAY, 0, 0, GO_AWAY_PROTO_ERR))
    this._shutdown(new YamuxError(message))
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    while (!this.closed && this.buf.length >= HEADER_BYTES) {
      const b = this.buf
      if (b[0] !== VERSION) return this._protocolError('invalid protocol version')
      const type = b[1]
      const flags = b.readUInt16BE(2)
      const id = b.readUInt32BE(4)
      const length = b.readUInt32BE(8)
      if (type === T_DATA) {
        if (b.length < HEADER_BYTES + length) return
        const payload = b.subarray(HEADER_BYTES, HEADER_BYTES + length)
        this.buf = b.subarray(HEADER_BYTES + length)
        this._onStreamFrame(type, flags, id, length, payload)
        continue
      }
      this.buf = b.subarray(HEADER_BYTES)
      switch (type) {
        case T_WINDOW_UPDATE:
          this._onStreamFrame(type, flags, id, length, null)
          break
        case T_PING:
          if (flags & F_SYN) this._write(header(T_PING, F_ACK, 0, length))
          else if (flags & F_ACK) {
            const done = this.pings.get(length)
            if (done) {
              this.pings.delete(length)
              done()
            }
          }
          break
        case T_GO_AWAY:
          this._shutdown(new YamuxError(length === GO_AWAY_NORMAL ? 'remote went away' : `remote go away (${length})`))
          return
        default:
          return this._protocolError('invalid message type')
      }
    }
  }

  _onStreamFrame(type, flags, id, length, payload) {
    let stream = this.streams.get(id)
    if (flags & F_SYN) {
      // frps 从不主动开流；收到即拒绝
      this._write(header(T_WINDOW_UPDATE, F_RST, id, 0))
      return
    }
    if (!stream) {
      // 已关闭的流可能还有在途帧，丢弃即可；数据帧仍需要被消费（上面已切出）
      return
    }
    if (flags & F_ACK) stream.established = true
    if (type === T_WINDOW_UPDATE && length > 0) stream._grantSend(length)
    if (type === T_DATA && length > 0) {
      if (length > stream.recvWindow) return this._protocolError('recv window exceeded')
      stream.recvWindow -= length
      stream._deliver(Buffer.from(payload))
    }
    if (flags & F_FIN) stream._remoteFin()
    if (flags & F_RST) stream._reset()
  }

  _forget(id) {
    this.streams.delete(id)
  }
}

export class YamuxStream extends Duplex {
  constructor(session, id) {
    super({ allowHalfOpen: true })
    this.session = session
    this.id = id
    this.established = false
    this.sendWindow = INITIAL_WINDOW
    this.recvWindow = INITIAL_WINDOW
    this.unacked = 0
    this.pending = null
    this.localFin = false
    this.remoteFinSeen = false
    // http.Server 注入连接时会读取这些 socket 属性
    this.remoteAddress = '127.0.0.1'
    this.remotePort = 0
    this.encrypted = false
  }

  setTimeout(ms, cb) {
    if (cb) this.once('timeout', cb)
    return this
  }

  setNoDelay() {
    return this
  }

  setKeepAlive() {
    return this
  }

  _write(chunk, _enc, cb) {
    this.pending = { chunk, cb }
    this._flush()
  }

  _flush() {
    const p = this.pending
    if (!p) return
    if (this.session.closed) {
      this.pending = null
      p.cb(new YamuxError('session closed'))
      return
    }
    while (p.chunk.length > 0 && this.sendWindow > 0) {
      const n = Math.min(p.chunk.length, this.sendWindow, MAX_FRAME_PAYLOAD)
      const part = p.chunk.subarray(0, n)
      p.chunk = p.chunk.subarray(n)
      this.sendWindow -= n
      this.session._write(Buffer.concat([header(T_DATA, 0, this.id, n), part]))
    }
    if (p.chunk.length === 0) {
      this.pending = null
      p.cb()
    }
  }

  _grantSend(n) {
    this.sendWindow += n
    this._flush()
  }

  _deliver(data) {
    this.unacked += data.length
    if (this.push(data)) this._maybeUpdateWindow()
  }

  _read() {
    this._maybeUpdateWindow()
  }

  _maybeUpdateWindow() {
    if (this.destroyed || this.session.closed) return
    if (this.unacked < INITIAL_WINDOW / 2) return
    const delta = this.unacked
    this.unacked = 0
    this.recvWindow += delta
    this.session._write(header(T_WINDOW_UPDATE, 0, this.id, delta))
  }

  _final(cb) {
    if (!this.localFin && !this.session.closed) {
      this.localFin = true
      this.session._write(header(T_WINDOW_UPDATE, F_FIN, this.id, 0))
    }
    if (this.remoteFinSeen) this.session._forget(this.id)
    cb()
  }

  _remoteFin() {
    if (this.remoteFinSeen) return
    this.remoteFinSeen = true
    this.push(null)
    if (this.localFin) this.session._forget(this.id)
  }

  _reset() {
    this.session._forget(this.id)
    this.destroy(new YamuxError('stream reset by peer'))
  }

  _sessionGone(err) {
    if (this.pending) {
      const { cb } = this.pending
      this.pending = null
      cb(err)
    }
    if (!this.destroyed) this.destroy()
  }

  _destroy(err, cb) {
    if (!this.session.closed && this.session.streams.has(this.id)) {
      if (!(this.localFin && this.remoteFinSeen)) this.session._write(header(T_WINDOW_UPDATE, F_RST, this.id, 0))
      this.session._forget(this.id)
    }
    if (this.pending) {
      const p = this.pending
      this.pending = null
      p.cb(err || new YamuxError('stream destroyed'))
    }
    cb(err)
  }

  destroySoon() {
    this.end()
  }
}
