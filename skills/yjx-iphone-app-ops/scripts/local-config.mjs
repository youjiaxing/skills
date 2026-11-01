import {readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const defaultConfigPath = path.join(os.homedir(), '.config', 'yjx-iphone-app-ops', 'config.json')

export async function loadConfig(env = process.env) {
  const configPath = env.IPHONE_OPS_CONFIG || defaultConfigPath
  let local = {}
  try { local = JSON.parse(await readFile(configPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Invalid local iPhone configuration: ${configPath}`, {cause: error}) }
  const udid = env.IOS_DEVICE_UDID || local.udid || null
  if (udid && !/^[a-zA-Z0-9-]+$/.test(udid)) throw new Error('Invalid IOS_DEVICE_UDID')
  const wdaLocalPort = Number(env.IOS_WDA_LOCAL_PORT || local.wdaLocalPort || 8100)
  const tunnelRegistryPort = Number(env.IPHONE_OPS_TUNNEL_PORT || local.tunnelRegistryPort || 42314)
  if (![wdaLocalPort, tunnelRegistryPort].every((v) => Number.isInteger(v) && v >= 1 && v <= 65535)) throw new Error('Invalid control service port')
  return {...local, configPath,
    appiumUrl: env.APPIUM_URL || local.appiumUrl || 'http://127.0.0.1:4723',
    udid,
    deviceName: env.IOS_DEVICE_NAME || local.deviceName || 'iPhone',
    platformVersion: env.IOS_PLATFORM_VERSION || local.platformVersion || undefined,
    wdaBundleId: env.IOS_WDA_BUNDLE_ID || local.wdaBundleId || null,
    wdaLocalPort, tunnelRegistryPort,
    sessionFile: env.IPHONE_OPS_SESSION_FILE || local.sessionFile || path.join(os.tmpdir(), `yjx-iphone-app-ops-${udid || 'unconfigured'}.json`),
  }
}

export function requireDevice(config) {
  if (!config.udid || !config.wdaBundleId) {
    throw new Error('Configure the target device and installed WDA first: run iphone-environment.mjs discover, or set IOS_DEVICE_UDID and IOS_WDA_BUNDLE_ID')
  }
}

// Unlike the legacy recovery reader, a corrupt marker also withholds commands.
export async function assertSessionReady(sessionFile) {
  if (!sessionFile) return
  for (const suffix of ['.unknown', '.reset-required']) {
    try {
      await readFile(sessionFile + suffix)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw Object.assign(new Error(`Cannot inspect session marker ${suffix}; no command was sent`), {status: 'session-state-unreadable', outcome: 'unknown'})
    }
    throw Object.assign(new Error(`Session ${suffix} marker exists; finish wda-health/session recovery before another operation`), {
      status: 'session-recovery-required', outcome: 'unknown', transportPending: true,
    })
  }
}
