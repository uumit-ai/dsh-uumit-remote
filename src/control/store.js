// 本地状态：$DSH_HOME/uumit-remote/（目录 0700，文件 0600，临时文件加原子改名）。
// credentials.json 只放设备凭证、tunnel_token 与设备 ID；其他文件不含任何秘密。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'

const FILES = Object.freeze({
  credentials: 'credentials.json',
  settings: 'settings.json',
  config: 'config.json',
  pairing: 'pairing.json',
  state: 'state.json',
  installId: 'install-id',
})

export function dshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : join(os.homedir(), '.dsh')
}

export function defaultHome(env = process.env) {
  return join(dshHome(env), 'uumit-remote')
}

export class Store {
  constructor(dir) {
    this.dir = dir
  }

  ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(this.dir, 0o700)
    } catch {
      // Windows 上权限位不生效
    }
  }

  path(name) {
    return join(this.dir, FILES[name] || name)
  }

  readJSON(name) {
    try {
      const v = JSON.parse(readFileSync(this.path(name), 'utf8'))
      return v && typeof v === 'object' ? v : null
    } catch {
      return null
    }
  }

  writeJSON(name, value) {
    this.writeRaw(name, JSON.stringify(value, null, 2) + '\n')
  }

  writeRaw(name, text) {
    this.ensureDir()
    const target = this.path(name)
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // Windows
    }
    renameSync(tmp, target)
  }

  remove(name) {
    rmSync(this.path(name), { force: true })
  }

  // --- 凭证 ---

  loadCredentials() {
    const c = this.readJSON('credentials')
    if (!c || !c.device_credential || !c.device_id || !c.tunnel_token) return null
    return { deviceId: String(c.device_id), deviceCredential: String(c.device_credential), tunnelToken: String(c.tunnel_token) }
  }

  saveCredentials({ deviceId, deviceCredential, tunnelToken }) {
    this.writeJSON('credentials', { version: 1, device_id: deviceId, device_credential: deviceCredential, tunnel_token: tunnelToken })
    const back = this.loadCredentials()
    if (!back || back.deviceCredential !== deviceCredential) throw new Error('device credential readback mismatch')
  }

  /** 配置里的 tunnel_token 已写进凭证文件，快照里去掉，免得秘密散落到第二个文件。 */
  saveConfig(config) {
    const { tunnel_token: _token, ...rest } = config || {}
    this.writeJSON('config', { version: 1, fetched_at: new Date().toISOString(), config: rest })
  }

  loadConfig() {
    const v = this.readJSON('config')
    return v && v.config ? v.config : null
  }

  loadSettings() {
    return this.readJSON('settings') || {}
  }

  saveSettings(patch) {
    this.writeJSON('settings', { ...this.loadSettings(), ...patch, version: 1 })
  }

  loadState() {
    return this.readJSON('state') || {}
  }

  saveState(patch) {
    this.writeJSON('state', { ...this.loadState(), ...patch, version: 1 })
  }

  loadPairing() {
    const p = this.readJSON('pairing')
    return p && p.device_code ? p : null
  }

  savePairing(p) {
    this.writeJSON('pairing', p)
  }

  /** 断开或被撤销：删掉凭证、配置与未完成的确认请求，保留电脑名与平台入口等非秘密设置。 */
  clearPairing() {
    this.remove('credentials')
    this.remove('config')
    this.remove('pairing')
    const s = this.loadSettings()
    this.writeJSON('settings', { version: 1, api_base: s.api_base, web_base: s.web_base, device_name: s.device_name })
  }

  installId() {
    try {
      const v = readFileSync(this.path('installId'), 'utf8').trim()
      if (v) return v
    } catch {
      // 首次生成
    }
    const id = randomBytes(16).toString('hex')
    this.writeRaw('installId', id + '\n')
    return id
  }
}
