// UUMit 远程访问 DSH 纯插件：插件在 DSH 进程内连上 UUMit 通道，
// 把 DSH 自己的网页登记为应用。浏览器端（client.js）在侧栏底部放入口，主人在 DSH 页面内的面板里连接、选择谁能用、邀请与授权。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteAgent } from './src/agent.js'
import { Store, defaultHome } from './src/control/store.js'
import { InnerAuth } from './src/proxy/inner-auth.js'
import { LoopbackProxy, createTunnelServer } from './src/proxy/loopback.js'
import { LOCAL_ONLY_PREFIX } from './src/proxy/gate.js'
import { createManagementHandler } from './src/ui/routes.js'
import { registerTool } from './src/tool.js'

const here = dirname(fileURLToPath(import.meta.url))
export const VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version

export const name = 'uumit-remote'
// cordis 的 inject 只有必需服务；Agent 工具在 tools 服务可用时经 ctx.inject 挂载，缺失时不影响插件启动
export const inject = ['webServer', 'connection']

function loggerOf(ctx) {
  if (ctx && typeof ctx.logger === 'function') {
    try {
      return ctx.logger('uumit-remote')
    } catch {
      // 回落到 console
    }
  }
  return console
}

export function apply(ctx, config = {}) {
  const log = loggerOf(ctx)
  const origin = () => ctx.webServer.getOrigin()
  const store = new Store(config.home || defaultHome())
  const innerAuth = new InnerAuth(ctx.connection, origin)
  const proxy = new LoopbackProxy({ origin, innerAuth, log })
  const tunnelServer = createTunnelServer(proxy, log)
  const agent = new RemoteAgent({
    store,
    dshOrigin: origin,
    version: VERSION,
    config,
    log,
    onWorkConn: (stream, rule) => tunnelServer.accept(stream, rule),
  })

  const disposers = []
  const handler = createManagementHandler({ agent, connection: ctx.connection, log })
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: LOCAL_ONLY_PREFIX,
      handler: (req, res) =>
        handler(req, res).catch((err) => {
          log.warn?.(`management page failed: ${err && err.message}`)
          if (!res.headersSent) res.writeHead(500)
          res.end()
        }),
    }),
  )

  const mountTool = (sub) => {
    try {
      const d = registerTool(sub, agent, origin)
      if (typeof d === 'function' && typeof sub.on === 'function') sub.on('dispose', d)
    } catch (err) {
      log.warn?.(`tool registration skipped: ${err && err.message}`)
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['tools'], mountTool)
  else if (ctx.tools) mountTool(ctx)

  agent.init().catch((err) => log.warn?.(`remote access start failed: ${err && err.message}`))
  try {
    log.info?.(`UUMit remote access ready: ${origin()}${LOCAL_ONLY_PREFIX}/`)
  } catch {
    // 监听地址尚不可用
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    agent.stop()
    proxy.close()
    tunnelServer.server.close()
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch {
        // 已随上下文释放
      }
    }
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', stop)
  return stop
}
