import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Duplex } from 'node:stream'
import { Decoder, encode, parseOne, readMessage, ProtocolError, MAX_MESSAGE_BYTES } from '../src/frp/msg.js'
import { CfbReader, CfbWriter, deriveKey, privilegeKey } from '../src/frp/cfb.js'
import { YamuxSession, INITIAL_WINDOW } from '../src/frp/yamux.js'
import { encodeFrame, parseFrame, acceptFor, connectWebSocket } from '../src/frp/websocket.js'

test('消息编码：类型字节、8 字节大端长度与 JSON', () => {
  const buf = encode('Login', { user: 'u', timestamp: 1 })
  assert.equal(buf[0], 'o'.charCodeAt(0))
  assert.equal(buf.readBigInt64BE(1), BigInt(buf.length - 9))
  assert.deepEqual(JSON.parse(buf.subarray(9)), { user: 'u', timestamp: 1 })
})

test('流式解码：任意切分都能还原', () => {
  const all = Buffer.concat([encode('ReqWorkConn', {}), encode('Pong', {}), encode('NewProxyResp', { proxy_name: 'a', error: 'x' })])
  for (let step = 1; step <= all.length; step++) {
    const d = new Decoder()
    const out = []
    for (let i = 0; i < all.length; i += step) out.push(...d.push(all.subarray(i, i + step)))
    assert.deepEqual(out.map((m) => m.name), ['ReqWorkConn', 'Pong', 'NewProxyResp'])
    assert.equal(out[2].body.error, 'x')
  }
})

test('未知类型、超长与非对象正文都是协议错误', () => {
  assert.throws(() => parseOne(Buffer.from([0x5a, 0, 0, 0, 0, 0, 0, 0, 0])), ProtocolError)
  const big = Buffer.alloc(9)
  big[0] = 'o'.charCodeAt(0)
  big.writeBigInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 1)
  assert.throws(() => parseOne(big), ProtocolError)
  const arr = Buffer.concat([Buffer.from([0x6f]), Buffer.alloc(8), Buffer.from('[]')])
  arr.writeBigInt64BE(2n, 1)
  assert.throws(() => parseOne(arr), ProtocolError)
  assert.equal(parseOne(Buffer.alloc(5)), null)
})

test('readMessage 读一条消息并把多余字节退回流中', async () => {
  const s = new PassThrough()
  s.write(Buffer.concat([encode('StartWorkConn', { proxy_name: 'p' }), Buffer.from('GET / HTTP/1.1\r\n')]))
  const m = await readMessage(s)
  assert.equal(m.name, 'StartWorkConn')
  assert.equal(s.read().toString(), 'GET / HTTP/1.1\r\n')
})

test('readMessage 超时与提前关闭', async () => {
  await assert.rejects(readMessage(new PassThrough(), { timeoutMs: 20 }), /timed out/)
  const s = new PassThrough()
  const p = readMessage(s)
  s.end()
  await assert.rejects(p, /closed/)
})

test('密钥派生与 privilege_key 与 Go 实现一致（参考值由 Python hashlib 计算）', () => {
  assert.equal(deriveKey('abc').toString('hex'), '62e5ed67fdd04e5f1f71d779ceb9667f')
  assert.equal(privilegeKey('abc', 1700000000), '22bd6333f840eeeee03ad14f75fd96ac')
})

test('CFB：首包带 IV，任意切分解密还原', () => {
  const key = deriveKey('t')
  const w = new CfbWriter(key)
  const plain = Buffer.from('x'.repeat(1000))
  const first = w.encrypt(plain.subarray(0, 10))
  const second = w.encrypt(plain.subarray(10))
  assert.equal(first.length, 16 + 10)
  assert.equal(second.length, 990)
  const cipher = Buffer.concat([first, second])
  for (const step of [1, 7, 16, 17, 1000]) {
    const r = new CfbReader(key)
    const out = []
    for (let i = 0; i < cipher.length; i += step) out.push(r.decrypt(cipher.subarray(i, i + step)))
    assert.deepEqual(Buffer.concat(out), plain)
  }
})

// 测试用 yamux 对端：解析客户端帧，回 ACK、回显数据并补窗口
function fakeYamuxServer({ echo = true } = {}) {
  const client = new PassThrough()
  const server = new PassThrough()
  const conn = Duplex.from({ readable: server, writable: client })
  const frames = []
  let buf = Buffer.alloc(0)
  const hdr = (type, flags, id, len) => {
    const h = Buffer.alloc(12)
    h[1] = type
    h.writeUInt16BE(flags, 2)
    h.writeUInt32BE(id, 4)
    h.writeUInt32BE(len, 8)
    return h
  }
  client.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 12) {
      const type = buf[1]
      const flags = buf.readUInt16BE(2)
      const id = buf.readUInt32BE(4)
      const len = buf.readUInt32BE(8)
      const total = type === 0 ? 12 + len : 12
      if (buf.length < total) return
      const payload = type === 0 ? buf.subarray(12, total) : null
      buf = buf.subarray(total)
      frames.push({ type, flags, id, len })
      if (type === 1 && flags & 1) server.write(hdr(1, 2, id, 0))
      if (type === 0) {
        if (echo) server.write(Buffer.concat([hdr(0, 0, id, payload.length), payload]))
        server.write(hdr(1, 0, id, payload.length))
      }
      if (type === 2 && flags & 1) server.write(hdr(2, 2, 0, len))
    }
  })
  return { conn, frames, server, hdr }
}

test('yamux：开流发 SYN，奇数流 ID，数据回显，FIN 半关闭', async () => {
  const f = fakeYamuxServer()
  const s = new YamuxSession(f.conn, { keepAliveMs: 0 })
  const a = s.open()
  const b = s.open()
  assert.equal(a.id, 1)
  assert.equal(b.id, 3)
  a.write('hello')
  const got = await new Promise((r) => a.once('data', r))
  assert.equal(got.toString(), 'hello')
  a.end()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(f.frames.some((x) => x.id === 1 && x.type === 1 && x.flags & 4), 'FIN sent')
  await s.ping()
  s.close()
})

test('yamux：超过初始窗口的写入等待对端窗口更新', async () => {
  const f = fakeYamuxServer({ echo: false })
  const s = new YamuxSession(f.conn, { keepAliveMs: 0 })
  const a = s.open()
  const total = INITIAL_WINDOW * 3 + 123
  await new Promise((r) => a.write(Buffer.alloc(total, 1), r))
  const sent = f.frames.filter((x) => x.type === 0 && x.id === 1).reduce((n, x) => n + x.len, 0)
  assert.equal(sent, total)
  s.close()
})

test('yamux：读走一半窗口后给对端补接收窗口', async () => {
  const f = fakeYamuxServer({ echo: false })
  const s = new YamuxSession(f.conn, { keepAliveMs: 0 })
  const a = s.open()
  let received = 0
  a.on('data', (d) => (received += d.length))
  for (let i = 0; i < 4; i++) f.server.write(Buffer.concat([f.hdr(0, 0, a.id, 64 * 1024), Buffer.alloc(64 * 1024)]))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(received, 256 * 1024)
  const updates = f.frames.filter((x) => x.type === 1 && x.id === a.id && x.len > 0)
  assert.ok(updates.reduce((n, x) => n + x.len, 0) >= 128 * 1024, 'window granted back')
  s.close()
})

test('yamux：对端开流被拒绝（RST），超出接收窗口时会话关闭', async () => {
  const f = fakeYamuxServer()
  const s = new YamuxSession(f.conn, { keepAliveMs: 0 })
  f.server.write(f.hdr(1, 1, 2, 0))
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(f.frames.some((x) => x.id === 2 && x.flags & 8), 'RST for server-initiated stream')
  const a = s.open()
  a.on('error', () => {})
  const closed = new Promise((r) => s.once('close', r))
  f.server.write(Buffer.concat([f.hdr(0, 0, a.id, INITIAL_WINDOW + 1), Buffer.alloc(INITIAL_WINDOW + 1)]))
  const err = await closed
  assert.match(err.message, /recv window/)
})

test('WebSocket 帧：客户端掩码编码，长度三种形式都能解析', () => {
  for (const n of [0, 125, 126, 65535, 65536]) {
    const payload = Buffer.alloc(n, 3)
    const frame = encodeFrame(2, payload)
    assert.ok(frame[1] & 0x80, 'masked')
    const f = parseFrame(frame)
    assert.equal(f.opcode, 2)
    assert.deepEqual(f.payload, payload)
    assert.equal(f.rest.length, 0)
  }
  assert.equal(parseFrame(Buffer.from([0x82])), null)
  assert.equal(acceptFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('WebSocket 握手：校验 101 与 Sec-WebSocket-Accept', async () => {
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const sock = Duplex.from({ readable: toClient, writable: toServer })
  toServer.once('data', (d) => {
    const key = /Sec-WebSocket-Key: (\S+)/.exec(d.toString())[1]
    assert.match(d.toString(), /^GET \/~!frp HTTP\/1\.1\r\nHost: node\.example/)
    toClient.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`)
    // 服务端无掩码二进制帧
    toClient.write(Buffer.from([0x82, 0x02, 0x68, 0x69]))
  })
  const ws = await connectWebSocket(sock, { host: 'node.example', path: '/~!frp' })
  const got = await new Promise((r) => ws.once('data', r))
  assert.equal(got.toString(), 'hi')

  const bad = Duplex.from({ readable: new PassThrough(), writable: new PassThrough() })
  const p = connectWebSocket(bad, { host: 'x', path: '/~!frp', timeoutMs: 30 })
  await assert.rejects(p, /timed out/)
})
