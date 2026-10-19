// 设备指纹与上报信息（做法与 UUMit 连接器相同，前缀不同：插件是一台独立的电脑记录）。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'

export const FINGERPRINT_PREFIX = 'uumit-dsh-plugin/fp/v1'

export function fingerprint(machineId, osUser) {
  return 'sha256:' + createHash('sha256').update(`${FINGERPRINT_PREFIX}|${machineId}|${osUser}`).digest('hex')
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function firstLine(path) {
  try {
    return readFileSync(path, 'utf8').split('\n')[0].trim()
  } catch {
    return ''
  }
}

export function machineId(platform = process.platform) {
  if (platform === 'darwin') {
    const m = /"IOPlatformUUID" = "([^"]+)"/.exec(run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))
    return m ? m[1] : ''
  }
  if (platform === 'win32') {
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']))
    return m ? m[1] : ''
  }
  return firstLine('/etc/machine-id') || firstLine('/var/lib/dbus/machine-id')
}

/** 原始机器 ID 不上报、不写日志；取不到时用状态目录里的随机 install-id。 */
export function localFingerprint(store) {
  const id = machineId() || store.installId()
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    user = ''
  }
  return fingerprint(id, user)
}

function hostName(platform = process.platform) {
  if (platform === 'darwin') {
    const n = run('scutil', ['--get', 'ComputerName']).trim()
    if (n) return n
  }
  if (platform === 'win32' && process.env.COMPUTERNAME) return process.env.COMPUTERNAME
  return os.hostname()
}

/** 电脑名：配置 > UUMIT_DEVICE_NAME > 「主机名 · DSH」，截断到 64 个字符。 */
export function deviceName(configured, env = process.env) {
  const name = (configured || env.UUMIT_DEVICE_NAME || `${hostName() || 'DeepSeek Harness'} · DSH`).trim()
  return [...name].slice(0, 64).join('')
}

export function reportedOS(platform = process.platform) {
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform
}

export function reportedArch(arch = process.arch) {
  return { x64: 'amd64', arm64: 'arm64', ia32: '386' }[arch] || arch
}
