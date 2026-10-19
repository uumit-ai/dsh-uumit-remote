// 对真 frps 0.71.0 的协议一致性用例：TLS 直连（0x17 首字节）、登录、控制通道加密、http 代理、
// 经 vhost 的 HTTP 与 WebSocket 升级、工作连接池、心跳，以及 token 错误时的拒绝。
// frps 位置：环境变量 FRPS_BIN，或本包的 test/e2e/.tools/frps；找不到时跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { dialTunnel } from '../../src/frp/transport.js'
import { FrpSession, FrpRejectError } from '../../src/frp/client.js'

const here = dirname(fileURLToPath(import.meta.url))
// frps 0.71.0 可执行文件：环境变量 FRPS_BIN，或放在本包的 test/e2e/.tools/frps
const FRPS = process.env.FRPS_BIN || join(here, '.tools/frps')
const TOKEN = 'e2e-tunnel-token'
const USER = '6f1d6a2e-1111-4000-8000-000000000001'
const SUB = 'mac-test--dsh'

function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

async function waitPort(port, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.destroy()
        r(true)
      })
      s.on('error', () => r(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`port ${port} not ready`)
}

async function startFrps(forceTLS = true) {
  const dir = mkdtempSync(join(tmpdir(), 'frps-e2e-'))
  const bind = await freePort()
  const vhost = await freePort()
  const cfg = join(dir, 'frps.toml')
  writeFileSync(
    cfg,
    [
      'bindAddr = "127.0.0.1"',
      `bindPort = ${bind}`,
      `transport.tls.force = ${forceTLS}`,
      'transport.heartbeatTimeout = 30',
      'transport.maxPoolCount = 5',
      'proxyBindAddr = "127.0.0.1"',
      `vhostHTTPPort = ${vhost}`,
      'subDomainHost = "tun.internal"',
      'auth.method = "token"',
      `auth.token = "${TOKEN}"`,
      'log.to = "console"',
      'log.level = "info"',
    ].join('\n'),
  )
  const proc = spawn(FRPS, ['-c', cfg], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  await waitPort(bind)
  await waitPort(vhost)
  return {
    bind,
    vhost,
    log: () => log,
    stop: () => {
      proc.kill()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function vhostRequest(port, path, headers = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: `${SUB}.tun.internal`, ...headers } }, (r) => {
      let body = ''
      r.setEncoding('utf8')
      r.on('data', (d) => (body += d))
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }))
    })
    req.on('error', rej)
    req.end()
  })
}

function serveWorkConns(session) {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(3 * 1024 * 1024, 7))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`hello ${req.url} host=${req.headers.host}`)
  })
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  session.on('workConn', (_name, stream) => server.emit('connection', stream))
  return server
}

const skip = existsSync(FRPS) ? false : `frps not found at ${FRPS}`

test('TLS 直连：登录、代理、HTTP、大响应与 WebSocket 升级', { skip, timeout: 60_000 }, async () => {
  const frps = await startFrps()
  let session
  try {
    const conn = await dialTunnel({ mode: 'tls', host: '127.0.0.1', port: frps.bind, insecure: true })
    session = new FrpSession({ conn, token: TOKEN, user: USER, metas: { device_credential: 'dvc_test' } })
    const states = []
    session.on('proxy', (name, s) => states.push([name, s.state]))
    serveWorkConns(session)
    session.setProxies([{ name: SUB, subdomain: SUB }])
    const { runId } = await session.start()
    assert.ok(runId, 'run_id returned')
    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(states.at(-1), [SUB, 'running'], frps.log())

    const r1 = await vhostRequest(frps.vhost, '/a?x=1')
    assert.equal(r1.status, 200)
    assert.equal(r1.body, `hello /a?x=1 host=${SUB}.tun.internal`)

    // 多个并发请求复用工作连接池
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => vhostRequest(frps.vhost, `/p${i}`)))
    many.forEach((r, i) => assert.equal(r.body, `hello /p${i} host=${SUB}.tun.internal`))

    // 超过 yamux 初始窗口的响应，验证窗口更新
    const big = await new Promise((res, rej) => {
      http
        .get({ host: '127.0.0.1', port: frps.vhost, path: '/big', headers: { host: `${SUB}.tun.internal` } }, (r) => {
          let n = 0
          r.on('data', (d) => (n += d.length))
          r.on('end', () => res(n))
        })
        .on('error', rej)
    })
    assert.equal(big, 3 * 1024 * 1024)

    const echoed = await new Promise((res, rej) => {
      const s = net.connect(frps.vhost, '127.0.0.1', () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: ${SUB}.tun.internal\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`)
      })
      let buf = ''
      s.on('data', (d) => {
        buf += d
        if (buf.includes('\r\n\r\n') && !buf.includes('ping-pong')) s.write('ping-pong')
        if (buf.endsWith('ping-pong')) {
          s.destroy()
          res(buf)
        }
      })
      s.on('error', rej)
    })
    assert.match(echoed, /^HTTP\/1\.1 101/)
  } finally {
    session?.close()
    frps.stop()
  }
})

test('token 错误时登录被拒绝', { skip, timeout: 30_000 }, async () => {
  const frps = await startFrps()
  try {
    const conn = await dialTunnel({ mode: 'tls', host: '127.0.0.1', port: frps.bind, insecure: true })
    const session = new FrpSession({ conn, token: 'wrong-token', user: USER })
    await assert.rejects(session.start(), (err) => err instanceof FrpRejectError && /token/i.test(err.reason))
  } finally {
    frps.stop()
  }
})

test('节点证书不受信任时拒绝连接（失败关闭）', { skip, timeout: 30_000 }, async () => {
  const frps = await startFrps()
  try {
    await assert.rejects(dialTunnel({ mode: 'tls', host: '127.0.0.1', port: frps.bind, insecure: false }))
  } finally {
    frps.stop()
  }
})

test('WSS 回落：本机 TLS 终止后转给 frps（模拟节点 nginx）', { skip, timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wss-e2e-'))
  const key = join(dir, 'k.pem')
  const crt = join(dir, 'c.pem')
  const gen = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  if ((await new Promise((r) => gen.on('exit', r))) !== 0) {
    t.skip('openssl unavailable')
    return
  }
  const results = {}
  try {
    for (const force of [false, true]) {
      const frps = await startFrps(force)
      const front = await new Promise((res) => {
        const srv = tls.createServer({ key: readFileSync(key), cert: readFileSync(crt) }, (sock) => {
          const up = net.connect(frps.bind, '127.0.0.1')
          sock.pipe(up).pipe(sock)
          up.on('error', () => sock.destroy())
          sock.on('error', () => up.destroy())
        })
        srv.listen(0, '127.0.0.1', () => res(srv))
      })
      let session
      try {
        const conn = await dialTunnel({ mode: 'wss', host: '127.0.0.1', port: front.address().port, insecure: true })
        session = new FrpSession({ conn, token: TOKEN, user: USER })
        serveWorkConns(session)
        session.setProxies([{ name: SUB, subdomain: SUB }])
        await session.start()
        await new Promise((r) => setTimeout(r, 300))
        results[force] = (await vhostRequest(frps.vhost, '/w')).body
      } catch (err) {
        results[force] = `error: ${err.message}`
      } finally {
        session?.close()
        front.close()
        frps.stop()
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  t.diagnostic(`wss tls.force=false: ${results[false]}`)
  t.diagnostic(`wss tls.force=true: ${results[true]}`)
  // 部署值为 tls.force = true；WebSocket 内的 frp TLS 让两种配置都能工作
  assert.equal(results[true], `hello /w host=${SUB}.tun.internal`)
  assert.equal(results[false], `hello /w host=${SUB}.tun.internal`)
})
