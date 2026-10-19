// frp wire v1 消息编解码：1 字节类型 + 8 字节大端长度 + JSON（frp 0.71.0 pkg/msg、golib/msg/json）。

export const TYPE = Object.freeze({
  Login: 'o',
  LoginResp: '1',
  NewProxy: 'p',
  NewProxyResp: '2',
  CloseProxy: 'c',
  NewWorkConn: 'w',
  ReqWorkConn: 'r',
  StartWorkConn: 's',
  Ping: 'h',
  Pong: '4',
})

const NAME_BY_BYTE = new Map(Object.entries(TYPE).map(([name, ch]) => [ch.charCodeAt(0), name]))

// 与 golib 默认上限一致，超过即视为协议错误
export const MAX_MESSAGE_BYTES = 10240
const HEADER_BYTES = 9

export class ProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** 编码一条消息；name 为 TYPE 的键。 */
export function encode(name, body = {}) {
  const ch = TYPE[name]
  if (!ch) throw new ProtocolError(`unknown message ${name}`)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  out[0] = ch.charCodeAt(0)
  out.writeBigInt64BE(BigInt(payload.length), 1)
  payload.copy(out, HEADER_BYTES)
  return out
}

/** 从 buf 开头解析一条完整消息；不完整返回 null。 */
export function parseOne(buf) {
  if (buf.length < HEADER_BYTES) return null
  const name = NAME_BY_BYTE.get(buf[0])
  if (!name) throw new ProtocolError(`unknown message type 0x${buf[0].toString(16)}`)
  const length = buf.readBigInt64BE(1)
  if (length < 0n || length > BigInt(MAX_MESSAGE_BYTES)) throw new ProtocolError('message length out of range')
  const end = HEADER_BYTES + Number(length)
  if (buf.length < end) return null
  let body
  try {
    body = JSON.parse(buf.subarray(HEADER_BYTES, end).toString('utf8'))
  } catch {
    throw new ProtocolError(`invalid ${name} body`)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ProtocolError(`invalid ${name} body`)
  return { name, body, rest: buf.subarray(end) }
}

/** 流式解码器：push 任意切片，返回其中完整的消息。 */
export class Decoder {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    for (;;) {
      const m = parseOne(this.buf)
      if (!m) break
      out.push({ name: m.name, body: m.body })
      this.buf = m.rest
    }
    return out
  }
}

/**
 * 从可读流读出恰好一条消息，多读的字节退回流中，供后续使用者（http 解析器或解密器）继续读取。
 * timeoutMs 为 0 时不限时（工作连接在连接池中可以长时间空闲）。
 */
export function readMessage(stream, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let timer = null
    const cleanup = () => {
      stream.off('readable', onReadable)
      stream.off('end', onEnd)
      stream.off('close', onEnd)
      stream.off('error', onError)
      if (timer) clearTimeout(timer)
    }
    const onEnd = () => {
      cleanup()
      reject(new ProtocolError('stream closed before message'))
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onReadable = () => {
      let chunk
      while ((chunk = stream.read()) !== null) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        let m
        try {
          m = parseOne(buf)
        } catch (err) {
          cleanup()
          reject(err)
          return
        }
        if (m) {
          cleanup()
          if (m.rest.length) stream.unshift(m.rest)
          resolve({ name: m.name, body: m.body })
          return
        }
      }
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        reject(new ProtocolError('timed out waiting for message'))
      }, timeoutMs)
    }
    stream.on('readable', onReadable)
    stream.on('end', onEnd)
    stream.on('close', onEnd)
    stream.on('error', onError)
    onReadable()
  })
}
