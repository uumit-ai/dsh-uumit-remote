// 本机联调栈（不连任何共享环境）：真 frps 0.71.0（强制 TLS、自签证书）+ 替身平台（插件用到的连接器接口）。
// 用法：node test/e2e/qa-stack.mjs [--fixed]
//   启动后打印一行 JSON：{"apiBase": "...", "vhostPort": N, "frpsBind": N}，Ctrl+C 停止。
// 然后用 UUMIT_API_BASE=<apiBase> UUMIT_TUNNEL_INSECURE_TLS=1 启动装了插件的 dsh web；
// 访问者请求模拟网关：发到 127.0.0.1:<vhostPort>，Host 为 qa-mac--dsh.tun.internal，并带 X-UUMit-* 身份头。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
// frps 0.71.0 可执行文件：环境变量 FRPS_BIN，或放在本包的 test/e2e/.tools/frps
const FRPS = process.env.FRPS_BIN || join(here, '.tools/frps')
const TOKEN = 'qa-tunnel-token'
const DEVICE_ID = '0b7f1c9e-0000-4000-8000-0000000000aa'
const OWNER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a'
const HANDLE = 'qa-mac'

function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

if (!existsSync(FRPS)) {
  console.error(`frps not found: ${FRPS}`)
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'uumit-qa-'))
const bind = await freePort()
const vhost = await freePort()
const apiPort = Number(process.env.QA_API_PORT) || (await freePort())
writeFileSync(
  join(dir, 'frps.toml'),
  [
    'bindAddr = "127.0.0.1"',
    `bindPort = ${bind}`,
    'transport.tls.force = true',
    'transport.heartbeatTimeout = 30',
    'proxyBindAddr = "127.0.0.1"',
    `vhostHTTPPort = ${vhost}`,
    'subDomainHost = "tun.internal"',
    'auth.method = "token"',
    `auth.token = "${TOKEN}"`,
    'log.to = "console"',
    'log.level = "info"',
  ].join('\n'),
)
const frps = spawn(FRPS, ['-c', join(dir, 'frps.toml')], { stdio: ['ignore', 'inherit', 'inherit'] })

const state = {
  service: null,
  grants: [],
  invites: [],
  revoked: false,
  version: 1,
  pairPolls: 0,
  log: [],
}

function config() {
  return {
    device_id: DEVICE_ID,
    handle: HANDLE,
    address: `http://${HANDLE}.cn.test`,
    config_version: `v${state.version}`,
    edition: 'cn',
    node: { node_id: 'qa-node', server_addr: '127.0.0.1', server_port: bind, tls: true, fallback: null },
    node_candidates: [],
    tunnel_token: TOKEN,
    frp_user: DEVICE_ID,
    heartbeat_interval_sec: 10,
    heartbeat_timeout_sec: 30,
    serving_report_interval_sec: 30,
    services: state.service ? [state.service] : [],
    paused: false,
    min_connector_version: '0.1.0',
    latest_connector_version: '0.1.0',
    risky_service_rules: { ports: [], mcp_tools: { keywords: [], tag: 'x', action: 'warn' }, declared: [] },
    features: { tcp_services: false, remote_connect: false },
  }
}

function pairing() {
  state.revoked = false
  state.pairPolls = 0
  return { device_id: DEVICE_ID, device_credential: 'dvc_qa_secret', handle: HANDLE, config: config() }
}

function management() {
  return {
    owner_user_id: OWNER_ID,
    service: { ...state.service, title: 'DeepSeek Harness' },
    grants: state.grants,
    invites: state.invites,
    grants_next_cursor: null,
    invites_next_cursor: null,
    entry_url: `http://dsh--${HANDLE}.cn.test/`,
    invite_defaults: { expires_in_days: 7, max_expires_in_days: 30, max_uses: 1, max_uses_cap: 10 },
    features: { grant_by_contact: true, grantee_browser_session: true },
  }
}

const P = '/api/v1/agent-address/connector'
const routes = {
  [`POST ${P}/pair-requests`]: () => ({ device_code: 'dc_qa', user_code: 'QAUC7K2M', confirm_code: 'Q7K2', verification_url: 'http://127.0.0.1:3010/address/connect?code=QAUC7K2M', expires_in: 600, interval: 1 }),
  [`POST ${P}/pair-requests/poll`]: () => (++state.pairPolls >= 2 ? { status: 'approved', retry_after_seconds: 0, pairing: pairing() } : { status: 'pending', retry_after_seconds: 1, pairing: null }),
  [`POST ${P}/pair`]: (b) => (b.pair_code === 'QAQA-2026' ? pairing() : { __error: [404, 'PAIR_CODE_INVALID'] }),
  [`GET ${P}/config`]: () => config(),
  [`POST ${P}/status`]: () => ({ config_version: `v${state.version}` }),
  [`POST ${P}/unpair`]: () => {
    state.revoked = true
    return { device_id: DEVICE_ID, status: 'revoked' }
  },
  [`POST /api/v1/agent-address/handles/${HANDLE}/services`]: (b) => {
    state.service = { name: b.name, kind: 'http', tier: 'private', host_alias_enabled: true, subdomain: `${HANDLE}--${b.name}`, frp_type: 'http', status: 'active', origin: null }
    state.version++
    return { ...state.service }
  },
  [`GET ${P}/desktop/services/dsh/management`]: () => management(),
  [`POST ${P}/desktop/services/dsh/exposure`]: (b) => {
    state.service = { ...state.service, tier: b.tier, status: b.tier === 'disabled' ? 'disabled' : 'active' }
    state.version++
    return { ...state.service }
  },
  [`POST ${P}/desktop/services/dsh/invites`]: (b) => {
    const inv = { invite_id: randomUUID(), service_name: 'dsh', status: 'active', expires_at: new Date(Date.now() + b.expires_in_days * 86400e3).toISOString(), max_uses: b.max_uses, used_count: 0, note: null }
    state.invites.push(inv)
    return { ...inv, invite_url: `http://127.0.0.1:3010/address/invite?token=${randomUUID()}`, reason: null }
  },
  [`POST ${P}/desktop/services/dsh/members/lookup`]: (b) =>
    b.phone === '13800000002' ? { found: true, is_self: false, person: { user_id: 'bbbbbbbb-0000-4000-8000-00000000000b', nickname: 'Bob', avatar_url: null, masked_phone: '138****0002' } } : { found: false, is_self: false, person: null },
  [`POST ${P}/desktop/services/dsh/grants`]: (b) => {
    const g = { grant_id: randomUUID(), grantee_user_id: b.user_id, service_name: 'dsh', status: 'active', expires_at: null, note: null, grantee: { user_id: b.user_id, nickname: 'Bob', avatar_url: null, masked_phone: '138****0002' } }
    state.grants.push(g)
    return g
  },
}

const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const path = req.url.split('?')[0]
    let key = `${req.method} ${path}`
    if (/\/grants\/[^/]+\/revoke$/.test(path)) key = 'REVOKE_GRANT'
    if (/\/invites\/[^/]+\/revoke$/.test(path)) key = 'REVOKE_INVITE'
    const authed = req.headers.authorization === 'Device dvc_qa_secret' && !state.revoked
    const needsAuth = !key.includes('/pair')
    state.log.push(key)
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (needsAuth && !authed) return send(401, { code: 9601, message: 'revoked', error_code: 'DEVICE_REVOKED', data: null })
    if (key === 'REVOKE_GRANT') {
      const id = path.split('/').at(-2)
      state.grants = state.grants.map((g) => (g.grant_id === id ? { ...g, status: 'revoked' } : g))
      return send(200, { code: 0, message: 'ok', data: null })
    }
    if (key === 'REVOKE_INVITE') {
      const id = path.split('/').at(-2)
      state.invites = state.invites.map((i) => (i.invite_id === id ? { ...i, status: 'revoked' } : i))
      return send(200, { code: 0, message: 'ok', data: null })
    }
    const fn = routes[key]
    if (!fn) return send(404, { code: 9600, message: 'route not found', error_code: 'ROUTE_NOT_FOUND', data: null })
    const out = fn(body ? JSON.parse(body) : {})
    if (out && out.__error) return send(out.__error[0], { code: 9601, message: out.__error[1], error_code: out.__error[1], data: null })
    send(200, { code: 0, message: 'ok', data: out })
  })
})
api.listen(apiPort, '127.0.0.1', () => {
  console.log(JSON.stringify({ apiBase: `http://127.0.0.1:${apiPort}`, vhostPort: vhost, frpsBind: bind }))
})

const stop = () => {
  frps.kill()
  api.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
