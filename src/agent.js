// 编排：未连接 → 等待确认 → 已连接（拉配置、登记应用、维持通道、上报状态） → 被撤销时回到未连接。
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { APIError, ERR, PlatformClient, isCode, isCredentialRejected, normalizeAPIBase } from './control/api.js'
import { deviceName, localFingerprint, reportedArch, reportedOS } from './control/device.js'
import { serviceEntry, validServiceName } from './control/entry.js'
import { TunnelManager } from './tunnel.js'

export const DEFAULT_API_BASE = 'https://api.uumit.com'

/**
 * 正式环境的 Web3.0 网页入口：内地版是 m.uumit.com（uumit.com 是官网，不是网页应用），
 * 海外版是 uumit.io。
 */
export function productionWebBase(edition) {
  return edition === 'global' ? 'https://uumit.io' : 'https://m.uumit.com'
}

/** 去掉末尾斜杠；旧版本存下的 uumit.com / www.uumit.com 映射到 m.uumit.com（保留路径）。 */
export function normalizeWebBase(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let u
  try {
    u = new URL(raw)
  } catch {
    return raw.replace(/\/+$/, '')
  }
  if (u.hostname === 'uumit.com' || u.hostname === 'www.uumit.com') u.hostname = 'm.uumit.com'
  return u.toString().replace(/\/+$/, '')
}
const CONFIG_REFRESH_MS = 5 * 60 * 1000
const MAX_POLL_INTERVAL_MS = 30_000
const SERVICE_TITLE = 'DeepSeek Harness'

const sleep = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

function normalizePairCode(raw) {
  const s = String(raw || '').replace(/\s+/g, '').toUpperCase()
  if ((s.match(/-/g) || []).length > 1 || s.startsWith('-') || s.endsWith('-')) return null
  const c = s.replace('-', '')
  if (!/^[A-Z0-9]{8}$/.test(c)) return null
  return `${c.slice(0, 4)}-${c.slice(4)}`
}

function pollInterval(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 5
}

function originOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

/** 把平台错误转成管理页可展示的结构；不含凭证。 */
export function describeError(err) {
  if (err instanceof APIError) {
    return { error_code: err.errorCode || (err.network ? 'NETWORK_UNAVAILABLE' : `HTTP_${err.httpStatus}`), message: err.platformMessage || err.message, data: err.data, retryable: err.retryable }
  }
  return { error_code: 'INTERNAL', message: err && err.message ? err.message : String(err), data: null, retryable: false }
}

export class RemoteAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./control/store.js').Store} o.store
   * @param {() => string} o.dshOrigin DSH 自己的监听地址
   * @param {string} o.version 插件版本
   * @param {object} [o.config] 插件配置（apiBase、serviceName、deviceName、autoConnect）
   * @param {object} [o.log]
   * @param {Record<string,string|undefined>} [o.env]
   * @param {(base: string, cred: Function) => PlatformClient} [o.clientFactory] 测试注入
   * @param {(opts: object) => TunnelManager} [o.tunnelFactory] 测试注入
   * @param {(stream: import('node:stream').Duplex, rule: object) => void} [o.onWorkConn]
   */
  constructor({ store, dshOrigin, version, config = {}, log = {}, env = process.env, clientFactory, tunnelFactory, onWorkConn = () => {}, now = Date.now, pollMinMs = 1000 }) {
    super()
    this.store = store
    this.dshOrigin = dshOrigin
    this.version = version
    this.log = log
    this.env = env
    this.now = now
    this.pollMinMs = pollMinMs
    this.serviceName = validServiceName(config.serviceName) ? config.serviceName : 'dsh'
    this.configuredDeviceName = config.deviceName || ''
    this.autoConnect = config.autoConnect !== false
    const settings = store.loadSettings()
    this.apiBase = normalizeAPIBase(env.UUMIT_API_BASE || config.apiBase || settings.api_base || DEFAULT_API_BASE)
    this.clientFactory = clientFactory || ((base, credential) => new PlatformClient({ base, credential, userAgent: `uumit-dsh-remote/${version} (${reportedOS()}; ${reportedArch()})` }))
    this.api = this.clientFactory(this.apiBase, async () => this.creds?.deviceCredential || '')
    this.onWorkConnCb = onWorkConn
    const persisted = store.loadState()
    this.tunnel = (tunnelFactory || ((o) => new TunnelManager(o)))({
      onWorkConn: (proxy, stream) => this._onWorkConn(proxy, stream),
      log,
      env,
      persisted: { transport: persisted.transport, wssUntil: persisted.wss_until },
      persist: ({ transport, wssUntil }) => store.saveState({ transport, wss_until: wssUntil }),
    })
    this.tunnel.on('revoked', () => this._markRevoked('tunnel'))
    this.tunnel.on('wrongNode', () => this.refreshConfig().catch(() => {}))
    this.tunnel.on('online', ({ transport }) => {
      this.transport = transport
      this.reportStatus().catch(() => {})
    })
    this.tunnel.on('status', () => this.emit('change'))
    this.creds = store.loadCredentials()
    this.config = this.creds ? store.loadConfig() : null
    this.pairing = null
    this.pairGen = 0
    this.lastError = null
    this.issue = null
    this.revoked = false
    this.registering = false
    this.timers = []
    this.stopped = false
    this.transport = 'tls'
  }

  // --- 生命周期 ---

  async init() {
    const pending = this.store.loadPairing()
    if (!this.creds && pending && Date.parse(pending.expires_at) > this.now()) {
      this.pairing = pending
      this._pollPairing(++this.pairGen)
    }
    if (this.creds && this.autoConnect) await this.goOnline()
  }

  stop() {
    this.stopped = true
    this.pairGen++
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.tunnel.stop()
    this.api.close?.()
  }

  /** 已连接时上线：拉配置、登记、建通道、定时刷新与上报。 */
  async goOnline() {
    if (!this.creds) return
    this.revoked = false
    this._startTimers()
    await this.refreshConfig()
  }

  _startTimers() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    const refresh = setInterval(() => this.refreshConfig().catch(() => {}), CONFIG_REFRESH_MS)
    refresh.unref?.()
    this.timers.push(refresh)
    this._scheduleReport()
  }

  _scheduleReport() {
    const sec = Number(this.config?.serving_report_interval_sec) || 60
    if (this.reportTimer) clearInterval(this.reportTimer)
    this.reportTimer = setInterval(() => this.reportStatus().catch(() => {}), Math.max(10, sec) * 1000)
    this.reportTimer.unref?.()
    this.timers.push(this.reportTimer)
  }

  // --- 配对 ---

  _pairRequestBody(fp) {
    return {
      device_name: deviceName(this.configuredDeviceName, this.env),
      os: reportedOS(),
      arch: reportedArch(),
      connector_version: this.version,
      device_fingerprint: fp,
      detected_apps: ['dsh'],
      runtime: 'dsh-plugin',
    }
  }

  /** 发起浏览器确认，立即返回链接与确认码；结果在后台轮询。 */
  async startPairing() {
    if (this.creds) throw Object.assign(new Error('this computer is already connected'), { code: 'ALREADY_PAIRED' })
    const started = await this.api.createPairRequest(this._pairRequestBody(localFingerprint(this.store)))
    this.pairing = {
      device_code: started.device_code,
      user_code: started.user_code,
      confirm_code: started.confirm_code,
      verification_url: started.verification_url,
      expires_at: new Date(this.now() + Number(started.expires_in) * 1000).toISOString(),
      interval: pollInterval(started.interval),
    }
    this.store.savePairing(this.pairing)
    this.lastError = null
    this.log.info?.('pairing request started')
    this._pollPairing(++this.pairGen)
    this.emit('change')
    return this.publicPairing()
  }

  cancelPairing() {
    this.pairGen++
    this.pairing = null
    this.store.remove('pairing')
    this.emit('change')
  }

  publicPairing() {
    if (!this.pairing) return null
    const { user_code, confirm_code, verification_url, expires_at } = this.pairing
    return { user_code, confirm_code, verification_url, expires_at }
  }

  async _pollPairing(gen) {
    let renewed = false
    let interval = Math.max(this.pollMinMs, this.pairing.interval * 1000)
    while (gen === this.pairGen && this.pairing && !this.stopped) {
      await sleep(interval)
      if (gen !== this.pairGen || !this.pairing) return
      let res
      try {
        res = await this.api.pollPairRequest(this.pairing.device_code)
      } catch (err) {
        if (!(err instanceof APIError) || !err.retryable) {
          this.lastError = describeError(err)
          this.cancelPairing()
          return
        }
        if (err.errorCode === ERR.RATE_LIMITED || err.httpStatus === 429) interval = Math.min(Math.max(interval * 2, err.retryAfterMs), MAX_POLL_INTERVAL_MS)
        if (Date.parse(this.pairing.expires_at) > this.now()) continue
        res = { status: 'expired' }
      }
      if (gen !== this.pairGen) return
      if (res.status === 'pending') {
        interval = Math.max(this.pollMinMs, this.pairing.interval * 1000, (Number(res.retry_after_seconds) || 0) * 1000)
        if (Date.parse(this.pairing.expires_at) + interval > this.now()) continue
        res = { status: 'expired' }
      }
      if (res.status === 'approved' && res.pairing && res.pairing.device_credential) {
        const web = originOf(this.pairing.verification_url)
        this.pairing = null
        this.store.remove('pairing')
        try {
          await this._saveResult(res.pairing, web)
        } catch (err) {
          // 凭证只返回一次：写入失败时需在网页「我的设备」移除后重新连接
          this.lastError = describeError(err)
          this.log.warn?.(`save pairing result failed: ${err.message}`)
          this.emit('change')
        }
        return
      }
      if (res.status === 'denied') {
        this.lastError = { error_code: 'PAIRING_DENIED', message: '在网页上选择了「不是我」', data: null, retryable: false }
        this.cancelPairing()
        return
      }
      if (renewed) {
        this.lastError = { error_code: 'PAIRING_EXPIRED', message: '确认请求已过期', data: null, retryable: true }
        this.cancelPairing()
        return
      }
      renewed = true
      try {
        const started = await this.api.createPairRequest(this._pairRequestBody(localFingerprint(this.store)))
        if (gen !== this.pairGen) return
        this.pairing = {
          device_code: started.device_code,
          user_code: started.user_code,
          confirm_code: started.confirm_code,
          verification_url: started.verification_url,
          expires_at: new Date(this.now() + Number(started.expires_in) * 1000).toISOString(),
          interval: pollInterval(started.interval),
        }
        interval = Math.max(this.pollMinMs, this.pairing.interval * 1000)
        this.store.savePairing(this.pairing)
        this.emit('change')
      } catch (err) {
        this.lastError = describeError(err)
        this.cancelPairing()
        return
      }
    }
  }

  /** 配对码连接；网络结果不确定时用同一码重试一次。 */
  async pairWithCode(raw) {
    if (this.creds) throw Object.assign(new Error('this computer is already connected'), { code: 'ALREADY_PAIRED' })
    const code = normalizePairCode(raw)
    if (!code) throw Object.assign(new Error('配对码是 8 位字母或数字'), { code: 'PAIR_CODE_FORMAT' })
    const body = { ...this._pairRequestBody(localFingerprint(this.store)), pair_code: code }
    delete body.detected_apps
    delete body.runtime
    let res
    try {
      res = await this.api.pairWithCode(body)
    } catch (err) {
      if (!(err instanceof APIError) || !err.network) throw err
      try {
        res = await this.api.pairWithCode(body)
      } catch (err2) {
        if (isCode(err2, ERR.PAIR_CODE_INVALID)) throw Object.assign(new Error('结果不确定：请到网页「我的设备」确认这台电脑是否已连接'), { code: 'PAIR_RESULT_UNKNOWN' })
        throw err2
      }
    }
    this.pairGen++
    this.pairing = null
    this.store.remove('pairing')
    await this._saveResult(res, null)
  }

  /** 先写设备凭证并读回确认，再写设置与配置。 */
  async _saveResult(result, webBase) {
    const config = result.config || {}
    this.store.saveCredentials({ deviceId: String(result.device_id), deviceCredential: String(result.device_credential), tunnelToken: String(config.tunnel_token || '') })
    this.store.saveSettings({
      api_base: this.apiBase,
      web_base: normalizeWebBase(webBase),
      device_id: String(result.device_id),
      handle: String(result.handle),
      address: config.address || null,
      edition: config.edition || null,
      device_name: deviceName(this.configuredDeviceName, this.env),
      paired_at: new Date(this.now()).toISOString(),
    })
    this.store.saveConfig(config)
    this.creds = this.store.loadCredentials()
    this.config = this.store.loadConfig()
    this.lastError = null
    this.log.info?.(`paired as device ${result.device_id} (handle ${result.handle})`)
    this.emit('change')
    await this.goOnline()
  }

  /** 断开后清理本地；平台不可达时不清理，避免本机以为断开而网页仍显示在线。 */
  async unpair() {
    if (this.creds) {
      try {
        await this.api.unpair()
      } catch (err) {
        if (!isCredentialRejected(err)) throw err
      }
    }
    this._clearLocal()
  }

  _clearLocal() {
    this.tunnel.stop()
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.store.clearPairing()
    this.creds = null
    this.config = null
    this.issue = null
    this.emit('change')
  }

  _markRevoked(source) {
    if (!this.creds) return
    this.log.warn?.(`device credential rejected (${source}); local credential removed`)
    this._clearLocal()
    this.revoked = true
    this.lastError = { error_code: ERR.DEVICE_REVOKED, message: '这台电脑已在 UUMit 上被移除，需要重新连接', data: null, retryable: false }
    this.emit('change')
  }

  // --- 配置与通道 ---

  async refreshConfig() {
    if (!this.creds) return
    let cfg
    try {
      cfg = await this.api.getConfig()
    } catch (err) {
      if (isCredentialRejected(err)) return this._markRevoked('config')
      this.lastError = describeError(err)
      this.emit('change')
      // 平台暂不可达时按上次快照维持通道
      if (this.config) this._applyTunnel(this.config)
      return
    }
    if (cfg.tunnel_token && cfg.tunnel_token !== this.creds.tunnelToken) {
      this.store.saveCredentials({ ...this.creds, tunnelToken: cfg.tunnel_token })
      this.creds = this.store.loadCredentials()
    }
    this.store.saveConfig(cfg)
    this.store.saveSettings({ address: cfg.address, handle: cfg.handle, edition: cfg.edition })
    const prevInterval = this.config?.serving_report_interval_sec
    this.config = this.store.loadConfig()
    if (prevInterval !== this.config.serving_report_interval_sec && this.timers.length) this._scheduleReport()
    this.lastError = null
    if (!this.service()) await this._registerService()
    this._applyTunnel(this.config)
    this.emit('change')
  }

  service() {
    return (this.config?.services || []).find((s) => s.name === this.serviceName) || null
  }

  async _registerService() {
    if (this.registering || !this.config) return
    this.registering = true
    try {
      await this.api.registerService(this.config.handle, { name: this.serviceName, kind: 'http', title: SERVICE_TITLE })
      this.issue = null
      this.log.info?.(`service ${this.serviceName} registered`)
      const cfg = await this.api.getConfig()
      this.store.saveConfig(cfg)
      this.config = this.store.loadConfig()
    } catch (err) {
      if (isCredentialRejected(err)) return this._markRevoked('register')
      if (isCode(err, ERR.SERVICE_LIMIT_REACHED)) this.issue = 'limit_reached'
      else if (isCode(err, ERR.FEATURE_REQUIRED)) this.issue = 'feature_unavailable'
      else this.issue = 'register_failed'
      this.lastError = describeError(err)
      this.log.warn?.(`register service failed: ${err.message}`)
    } finally {
      this.registering = false
    }
  }

  /** 当前应用的访问规则；不在代理表里时返回 null。 */
  rule() {
    const cfg = this.config
    const s = this.service()
    if (!cfg || !s) return null
    const entry = serviceEntry(cfg.address, cfg.handle, s.name, s.host_alias_enabled)
    return { service: s.name, tier: s.tier, status: s.status, proxy: `${cfg.handle}--${s.name}`, entry }
  }

  desiredProxies(cfg = this.config) {
    if (!cfg || cfg.paused) return []
    const s = (cfg.services || []).find((x) => x.name === this.serviceName)
    if (!s || s.tier === 'disabled' || s.status !== 'active' || s.frp_type !== 'http' || s.subdomain !== `${cfg.handle}--${s.name}`) return []
    return [{ name: s.subdomain, subdomain: s.subdomain }]
  }

  _applyTunnel(cfg) {
    const node = cfg.node
    if (!node || !node.server_addr || !node.server_port || !this.creds?.tunnelToken) {
      this.tunnel.stop()
      this.issue = this.issue || 'no_tunnel_node'
      return
    }
    const fallback = node.fallback && node.fallback.protocol === 'wss' && node.fallback.server_port > 0 ? node.fallback.server_port : 0
    const hb = Number(cfg.heartbeat_interval_sec) || 10
    const hbt = Number(cfg.heartbeat_timeout_sec) || hb * 3
    this.tunnel.configure(
      {
        nodeId: node.node_id,
        serverAddr: node.server_addr,
        serverPort: node.server_port,
        tls: node.tls !== false,
        fallbackPort: fallback,
        token: this.creds.tunnelToken,
        user: cfg.frp_user || this.creds.deviceId,
        deviceCredential: this.creds.deviceCredential,
        heartbeatIntervalMs: hb * 1000,
        heartbeatTimeoutMs: hbt * 1000,
      },
      this.desiredProxies(cfg),
    )
  }

  /** 当前仍在代理表里的本应用规则；档位、暂停或删除变化后立即生效。 */
  activeRule(proxy) {
    const rule = this.rule()
    if (!rule || rule.proxy !== proxy || !this.desiredProxies().some((p) => p.name === proxy)) return null
    return rule
  }

  _onWorkConn(proxy, stream) {
    if (!this.activeRule(proxy)) {
      stream.destroy()
      return
    }
    // frps 会长时间复用同一条工作连接承载多次请求，规则必须逐请求读取
    this.onWorkConnCb(stream, () => this.activeRule(proxy))
  }

  // --- 状态上报 ---

  async probeDSH() {
    let origin
    try {
      origin = new URL(this.dshOrigin())
    } catch {
      return { reachable: false, latency: null }
    }
    const start = this.now()
    const port = Number(origin.port) || (origin.protocol === 'https:' ? 443 : 80)
    const reachable = await new Promise((resolve) => {
      const s = net.connect({ host: origin.hostname.replace(/^\[|\]$/g, ''), port }, () => {
        s.destroy()
        resolve(true)
      })
      s.setTimeout(3000, () => {
        s.destroy()
        resolve(false)
      })
      s.on('error', () => resolve(false))
    })
    return { reachable, latency: reachable ? this.now() - start : null }
  }

  async reportStatus() {
    if (!this.creds || !this.config || !this.service()) return
    const probe = await this.probeDSH()
    let ack
    try {
      ack = await this.api.reportStatus({
        reported_at: new Date(this.now()).toISOString(),
        connector_version: this.version,
        transport: this.tunnel.status().transport === 'wss' ? 'wss' : 'tls',
        services: [{ name: this.serviceName, local_reachable: probe.reachable, latency_ms: probe.latency }],
      })
    } catch (err) {
      if (isCredentialRejected(err)) this._markRevoked('status')
      return
    }
    if (ack && ack.config_version && ack.config_version !== this.config.config_version) await this.refreshConfig()
  }

  /** 网页入口：环境变量 > 确认链接的来源 > 按平台入口推导（与 UUMit 连接器相同）。 */
  webBase() {
    const fromEnv = normalizeWebBase((this.env.UUMIT_WEB_BASE || '').trim())
    if (fromEnv) return fromEnv
    const settings = this.store.loadSettings()
    if (settings.web_base) return normalizeWebBase(settings.web_base)
    const api = new URL(this.apiBase)
    if (api.hostname === '127.0.0.1' || api.hostname === 'localhost') return 'http://127.0.0.1:3010'
    if (api.hostname !== 'api.uumit.com' && api.hostname !== 'api.uumit.io') return api.origin
    return productionWebBase(settings.edition || this.config?.edition)
  }

  // --- 管理页视图 ---

  status() {
    const settings = this.store.loadSettings()
    const s = this.service()
    const rule = this.rule()
    let state = 'unpaired'
    if (this.creds) state = 'paired'
    else if (this.pairing) state = 'pairing'
    return {
      state,
      revoked: this.revoked,
      plugin_version: this.version,
      api_base: this.apiBase,
      web_base: this.webBase(),
      dsh_origin: (() => {
        try {
          return this.dshOrigin()
        } catch {
          return null
        }
      })(),
      pairing: this.publicPairing(),
      device: this.creds
        ? { device_id: this.creds.deviceId, handle: settings.handle || this.config?.handle || null, address: settings.address || this.config?.address || null, device_name: settings.device_name || null, edition: settings.edition || null }
        : null,
      service: s
        ? {
            name: s.name,
            tier: s.tier,
            status: s.status,
            host_alias_enabled: !!s.host_alias_enabled,
            entry_url: rule?.entry?.entryURL || null,
            full_access: !!rule?.entry?.aliasHost,
          }
        : null,
      paused: !!this.config?.paused,
      tunnel: this.creds ? this.tunnel.status() : null,
      issue: this.issue,
      last_error: this.lastError,
    }
  }
}
