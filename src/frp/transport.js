// 通道底层连接：TLS 直连（先写 frp 自定义首字节 0x17）或 443 WSS 回落（TLS 后 WebSocket /~!frp）。
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { connectWebSocket } from './websocket.js'

export const FRP_TLS_HEAD_BYTE = 0x17
export const FRP_WEBSOCKET_PATH = '/~!frp'

export class TransportError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause })
    this.name = 'TransportError'
  }
}

/** 测试环境开关：只认 1 / 0。 */
export function insecureTLSFromEnv(env = process.env) {
  return env.UUMIT_TUNNEL_INSECURE_TLS === '1'
}

/** 节点证书的信任根：显式 CA 文件优先；否则 Node 默认根证书，能读到系统根证书时一并加入。 */
export function trustedCA(env = process.env) {
  if (env.UUMIT_TUNNEL_CA_FILE) return [readFileSync(env.UUMIT_TUNNEL_CA_FILE, 'utf8')]
  if (typeof tls.getCACertificates === 'function') {
    try {
      const all = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])
      return [...all]
    } catch {
      return undefined
    }
  }
  return undefined
}

function serverNameFor(host) {
  return net.isIP(host) ? undefined : host
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        reject(new TransportError('connect timed out'))
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function connectTCP(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    sock.once('connect', () => {
      sock.off('error', reject)
      sock.setKeepAlive(true, 30_000)
      sock.setNoDelay(true)
      resolve(sock)
    })
    sock.once('error', reject)
  })
}

function startTLS(options) {
  return new Promise((resolve, reject) => {
    const s = tls.connect(options)
    s.once('secureConnect', () => {
      s.off('error', reject)
      resolve(s)
    })
    s.once('error', reject)
  })
}

/**
 * 建立到 frps 的底层连接。
 * @param {{mode: 'tls'|'wss', host: string, port: number, ca?: string[], insecure?: boolean, timeoutMs?: number}} o
 * @returns {Promise<import('node:stream').Duplex>}
 */
export async function dialTunnel({ mode, host, port, ca, insecure = false, timeoutMs = 10_000 }) {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new TransportError('invalid tunnel node address')
  const servername = serverNameFor(host)
  const tlsOptions = { servername, ca, rejectUnauthorized: !insecure, minVersion: 'TLSv1.2' }
  const opened = []
  const abort = () => opened.forEach((s) => s.destroy())
  try {
    return await withTimeout(
      (async () => {
        if (mode === 'wss') {
          // 443 回落的部署方式：节点 nginx 用节点证书终止外层 TLS，把 WebSocket 转给强制 TLS 的 frps，
          // 所以 WebSocket 内还要再做一次 frp 自身的 TLS（首字节 0x17）。
          const outer = await startTLS({ ...tlsOptions, host, port })
          opened.push(outer)
          outer.setKeepAlive?.(true, 30_000)
          const ws = await connectWebSocket(outer, { host: servername || host, path: FRP_WEBSOCKET_PATH, timeoutMs })
          opened.push(ws)
          ws.write(Buffer.from([FRP_TLS_HEAD_BYTE]))
          const inner = await startTLS({ ...tlsOptions, socket: ws })
          opened.push(inner)
          return inner
        }
        const raw = await connectTCP(host, port)
        opened.push(raw)
        if (mode === 'tcp') return raw
        raw.write(Buffer.from([FRP_TLS_HEAD_BYTE]))
        const t = await startTLS({ ...tlsOptions, socket: raw })
        opened.push(t)
        return t
      })(),
      timeoutMs,
      abort,
    )
  } catch (err) {
    abort()
    if (err instanceof TransportError) throw err
    throw new TransportError(err && err.message ? err.message : String(err), { cause: err })
  }
}
