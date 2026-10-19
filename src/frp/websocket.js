// 最小 WebSocket 客户端（RFC 6455），只用于 frp 的 WSS 回落：二进制帧承载 yamux 字节流。
// 与 frp 一致：先 TLS，再在其上握手 GET /~!frp（golang.org/x/net/websocket，Origin 为 http://<host>）。
import { Duplex } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa
const MAX_HANDSHAKE_BYTES = 16 * 1024
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_SEND_FRAME = 64 * 1024

export class WebSocketError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WebSocketError'
  }
}

export function acceptFor(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** 客户端帧：一律带掩码。 */
export function encodeFrame(opcode, payload, mask = randomBytes(4)) {
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.alloc(2)
    head[1] = 0x80 | len
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  head[0] = 0x80 | opcode
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, masked])
}

/** 解析一帧；不完整返回 null。服务端帧通常不带掩码，带了也照常解开。 */
export function parseFrame(buf) {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(MAX_FRAME_BYTES)) throw new WebSocketError('frame too large')
    len = Number(big)
    off = 10
  }
  let mask = null
  if (masked) {
    if (buf.length < off + 4) return null
    mask = buf.subarray(off, off + 4)
    off += 4
  }
  if (buf.length < off + len) return null
  let payload = buf.subarray(off, off + len)
  if (mask) {
    const out = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
    payload = out
  }
  return { fin, opcode, payload, rest: buf.subarray(off + len) }
}

class WebSocketDuplex extends Duplex {
  constructor(socket, initial) {
    super({ allowHalfOpen: false })
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.closing = false
    socket.on('data', (d) => this._onData(d))
    socket.on('end', () => this.push(null))
    socket.on('close', () => this.destroy())
    socket.on('error', (err) => this.destroy(err))
    if (initial.length) this._onData(initial)
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      let f
      try {
        f = parseFrame(this.buf)
      } catch (err) {
        this.destroy(err)
        return
      }
      if (!f) return
      this.buf = f.rest
      switch (f.opcode) {
        case OP_BINARY:
        case OP_TEXT:
        case OP_CONT:
          if (f.payload.length) this.push(Buffer.from(f.payload))
          break
        case OP_PING:
          this.socket.write(encodeFrame(OP_PONG, f.payload))
          break
        case OP_PONG:
          break
        case OP_CLOSE:
          if (!this.closing) {
            this.closing = true
            this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)))
          }
          this.push(null)
          this.socket.end()
          return
        default:
          this.destroy(new WebSocketError(`unexpected opcode ${f.opcode}`))
          return
      }
    }
  }

  _read() {}

  _write(chunk, _enc, cb) {
    let ok = true
    for (let i = 0; i < chunk.length; i += MAX_SEND_FRAME) {
      ok = this.socket.write(encodeFrame(OP_BINARY, chunk.subarray(i, i + MAX_SEND_FRAME)))
    }
    if (ok) cb()
    else this.socket.once('drain', () => cb())
  }

  _final(cb) {
    if (!this.closing && !this.socket.destroyed) {
      this.closing = true
      this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)))
    }
    this.socket.end()
    cb()
  }

  _destroy(err, cb) {
    if (!this.socket.destroyed) this.socket.destroy()
    cb(err)
  }
}

/**
 * 在已建立的（TLS）连接上完成客户端握手，返回承载二进制字节流的 Duplex。
 * @param {import('node:stream').Duplex} socket
 * @param {{host: string, path: string, timeoutMs?: number}} opts
 */
export function connectWebSocket(socket, { host, path, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new WebSocketError('websocket handshake timed out')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', onClose)
    }
    function fail(err) {
      cleanup()
      socket.on('error', () => {})
      socket.destroy()
      reject(err)
    }
    function onClose() {
      fail(new WebSocketError('connection closed during websocket handshake'))
    }
    function onData(d) {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > MAX_HANDSHAKE_BYTES) fail(new WebSocketError('websocket handshake too large'))
        return
      }
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
      const rest = buf.subarray(end + 4)
      const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0] || '')
      if (!status || status[1] !== '101') return fail(new WebSocketError(`websocket handshake rejected: ${lines[0] || 'no status'}`))
      const headers = new Map()
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':')
        if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
      }
      if (headers.get('sec-websocket-accept') !== acceptFor(key)) return fail(new WebSocketError('websocket accept key mismatch'))
      if ((headers.get('upgrade') || '').toLowerCase() !== 'websocket') return fail(new WebSocketError('websocket upgrade header missing'))
      cleanup()
      resolve(new WebSocketDuplex(socket, rest))
    }
    socket.on('data', onData)
    socket.on('error', fail)
    socket.on('close', onClose)
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: http://${host}`,
        '',
        '',
      ].join('\r\n'),
    )
  })
}
