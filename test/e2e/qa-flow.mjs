// 本机全链路验收脚本：驱动「qa-stack.mjs + 装了插件的真 dsh web」完成连接、访问、授权与断开。
// 用法：node test/e2e/qa-flow.mjs <dsh web 日志路径> <qa-stack 日志路径>
// 访问者请求模拟网关：经 frps vhost，Host 为 qa-mac--dsh.tun.internal，带 X-UUMit-* 身份头。
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import assert from 'node:assert/strict'

const [dshLog, stackLog] = process.argv.slice(2)
const tokenURL = readFileSync(dshLog, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/g).at(-1)
const dsh = new URL(tokenURL)
const { vhostPort } = JSON.parse(readFileSync(stackLog, 'utf8').split('\n').find((l) => l.startsWith('{')))
const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a'
const MEMBER = 'bbbbbbbb-0000-4000-8000-00000000000b'
const GRANT = 'cccccccc-0000-4000-8000-00000000000c'
const results = []
const step = async (name, fn) => {
  await fn()
  results.push(name)
  console.log(`ok - ${name}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function request({ port, path, method = 'GET', headers = {}, body, agent }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (text += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

let cookie = ''
async function owner(method, path, body) {
  const headers = { cookie }
  if (method === 'POST') Object.assign(headers, { 'content-type': 'application/json', 'x-uumit-remote-ui': '1', 'sec-fetch-site': 'same-origin' })
  const r = await request({ port: Number(dsh.port), path: `/uumit-remote/api${path}`, method, headers, body: body ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined })
  return JSON.parse(r.text)
}
async function waitStatus(pred, ms = 20_000) {
  const end = Date.now() + ms
  let s
  while (Date.now() < end) {
    s = (await owner('GET', '/status')).data
    if (pred(s)) return s
    await sleep(300)
  }
  throw new Error(`status not reached: ${JSON.stringify(s)}`)
}

const visitor = (extra) => ({ host: 'qa-mac--dsh.tun.internal', 'x-uumit-public-host': 'dsh--qa-mac.cn.test', 'x-uumit-public-proto': 'http', ...extra })
const asOwner = visitor({ 'x-uumit-caller-type': 'owner', 'x-uumit-caller-id': OWNER })
const asMember = visitor({ 'x-uumit-caller-type': 'user', 'x-uumit-caller-id': MEMBER, 'x-uumit-grant-id': GRANT })
const asPublic = visitor({ 'x-uumit-caller-type': 'public' })
const tunnel = (headers, path = '/', agent) => request({ port: vhostPort, path, headers: { accept: 'text/html', ...headers }, agent })

function upgrade(headers) {
  return new Promise((resolve, reject) => {
    const s = net.connect(vhostPort, '127.0.0.1', () => {
      const lines = ['GET /api/remote.mux HTTP/1.1', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', 'Origin: http://dsh--qa-mac.cn.test']
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
      s.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let b = ''
    s.on('data', (d) => {
      b += d
      if (b.includes('\r\n')) {
        s.destroy()
        resolve(b.split('\r\n')[0])
      }
    })
    s.on('error', reject)
  })
}

await step('主人在本机兑换 DSH 登录，管理页拒绝未登录请求', async () => {
  const r = await request({ port: Number(dsh.port), path: dsh.pathname + dsh.search })
  assert.equal(r.status, 303)
  cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ')
  const anon = await request({ port: Number(dsh.port), path: '/uumit-remote/api/status' })
  assert.equal(anon.status, 401)
})

await step('如已连接先断开，回到未连接', async () => {
  const s = (await owner('GET', '/status')).data
  if (s.state === 'paired') await owner('POST', '/unpair')
  if (s.state === 'pairing') await owner('POST', '/pair/cancel')
  await waitStatus((x) => x.state === 'unpaired')
})

await step('浏览器确认连接：登记 dsh、通道在线、代理运行', async () => {
  const start = await owner('POST', '/pair/start')
  assert.equal(start.ok, true)
  assert.ok(start.data.confirm_code && !('device_code' in start.data))
  const s = await waitStatus((x) => x.state === 'paired' && x.tunnel?.state === 'online' && x.tunnel?.proxies?.['qa-mac--dsh']?.state === 'running')
  assert.equal(s.service.entry_url, 'http://dsh--qa-mac.cn.test/')
  // 替身平台在断开后保留应用记录；从「仅自己」开始
  if (s.service.tier !== 'private') {
    await owner('POST', '/exposure', { tier: 'private' })
    await waitStatus((x) => x.service?.tier === 'private' && x.tunnel?.proxies?.['qa-mac--dsh']?.state === 'running')
  }
})

await step('主人经通道打开真 DSH：首页注入宿主模式、无 Set-Cookie、资源与 WebSocket 可用', async () => {
  const r = await tunnel(asOwner)
  assert.equal(r.status, 200)
  assert.match(r.text, /<head><script>window\.__DSH_TRANSPORT__/)
  assert.equal(r.headers['set-cookie'], undefined)
  const asset = r.text.match(/src="\.?(\/assets\/[^"]+\.js)"/)[1]
  assert.equal((await tunnel(asOwner, asset)).status, 200)
  assert.match(await upgrade(asOwner), /^HTTP\/1\.1 101/)
})

await step('本机管理页经通道不可达；非成员与缺身份头被拒', async () => {
  assert.equal((await tunnel(asOwner, '/uumit-remote/api/status')).status, 404)
  assert.equal((await tunnel(asMember)).status, 403)
  assert.equal((await tunnel(visitor({}))).status, 403)
  assert.match(await upgrade(asMember), /^HTTP\/1\.1 403/)
})

await step('「我和我邀请的人」：成员可用；改回「仅自己」后同一条保持连接上立即被拒', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  try {
    assert.equal((await tunnel(asMember, '/', agent)).status, 403)
    assert.equal((await owner('POST', '/exposure', { tier: 'granted' })).ok, true)
    await waitStatus((x) => x.service?.tier === 'granted')
    assert.equal((await tunnel(asMember, '/', agent)).status, 200)
    assert.equal((await owner('POST', '/exposure', { tier: 'private' })).ok, true)
    await waitStatus((x) => x.service?.tier === 'private')
    assert.equal((await tunnel(asMember, '/', agent)).status, 403)
  } finally {
    agent.destroy()
  }
})

await step('邀请链接、按手机号授权、管理详情、撤销授权与邀请', async () => {
  await owner('POST', '/exposure', { tier: 'granted' })
  const inv = await owner('POST', '/invites', { expires_in_days: 7, max_uses: 2 })
  assert.ok(inv.data.invite_url)
  const found = await owner('POST', '/members/lookup', { phone: '13800000002' })
  assert.equal(found.data.found, true)
  const g = await owner('POST', '/grants', { user_id: found.data.person.user_id })
  assert.equal(g.data.status, 'active')
  const m = (await owner('GET', '/management')).data
  assert.ok(m.grants.some((x) => x.grant_id === g.data.grant_id))
  assert.ok(m.invites.some((x) => x.invite_id === inv.data.invite_id))
  assert.equal((await owner('POST', '/grants/revoke', { grant_id: g.data.grant_id })).ok, true)
  assert.equal((await owner('POST', '/invites/revoke', { invite_id: inv.data.invite_id })).ok, true)
})

await step('「所有人」必须确认；确认后匿名访问可用；关闭后通道不再承载', async () => {
  assert.equal((await owner('POST', '/exposure', { tier: 'public' })).error.error_code, 'CONFIRMATION_REQUIRED')
  await owner('POST', '/exposure', { tier: 'public', confirm: true })
  await waitStatus((x) => x.service?.tier === 'public')
  assert.equal((await tunnel(asPublic)).status, 200)
  await owner('POST', '/exposure', { tier: 'disabled' })
  await waitStatus((x) => x.service?.tier === 'disabled' && Object.keys(x.tunnel?.proxies || {}).length === 0)
  assert.equal((await tunnel(asOwner)).status, 404)
  await owner('POST', '/exposure', { tier: 'private' })
  await waitStatus((x) => x.tunnel?.proxies?.['qa-mac--dsh']?.state === 'running')
})

await step('断开这台电脑后通道关闭；配对码重新连接', async () => {
  await owner('POST', '/unpair')
  await waitStatus((x) => x.state === 'unpaired' && !x.tunnel)
  await sleep(300)
  assert.equal((await tunnel(asOwner)).status, 404)
  const bad = await owner('POST', '/pair/code', { code: 'nope' })
  assert.equal(bad.error.error_code, 'PAIR_CODE_FORMAT')
  const okCode = await owner('POST', '/pair/code', { code: 'qaqa-2026' })
  assert.equal(okCode.ok, true)
  await waitStatus((x) => x.state === 'paired' && x.tunnel?.proxies?.['qa-mac--dsh']?.state === 'running')
  assert.equal((await tunnel(asOwner)).status, 200)
})

console.log(`\n${results.length} steps passed`)
