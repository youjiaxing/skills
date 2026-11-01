#!/usr/bin/env node
import {execFileSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {loadConfig, defaultConfigPath, assertSessionReady, requireDevice} from './local-config.mjs'
import {publishArtifact} from './dianping-query.mjs'
import {withFileLock} from './device-lock.mjs'

const skillDir = fileURLToPath(new URL('..', import.meta.url))
const sha = (data) => createHash('sha256').update(data).digest('hex')
const run = (file, args, options = {}) => execFileSync(file, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  env: {...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`}, ...options})
const exists = async (p) => { try { await access(p); return true } catch { return false } }
const plist = (p) => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p]))
const locate = (name) => { try { return run('/usr/bin/which', [name]).trim() } catch { return null } }

async function deviceList() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'iphone-ops-devices-'))
  try {
    const output = path.join(scratch, 'devices.json')
    run('xcrun', ['devicectl', 'list', 'devices', '--json-output', output])
    const document = JSON.parse(await readFile(output, 'utf8'))
    return document.result.devices.map((d) => ({
      udid: d.properties?.hardware?.udid || d.hardwareProperties?.udid,
      deviceName: d.properties?.state?.name || d.deviceProperties?.name,
      platformVersion: d.properties?.software?.osVersionNumber?.stringValue || d.deviceProperties?.osVersionNumber,
      connection: d.properties?.connection?.state || d.connectionProperties?.tunnelState,
    }))
  } finally { await rm(scratch, {recursive: true, force: true}) }
}

export async function discover({udid, appiumHome = process.env.APPIUM_HOME || path.join(os.homedir(), '.appium')} = {}) {
  const launchAgent = path.join(os.homedir(), 'Library/LaunchAgents/com.yjx.iphone-appium.plist')
  const installed = await exists(launchAgent) ? plist(launchAgent) : null
  const appiumBinary = locate('appium')
  const nodePath = installed?.ProgramArguments?.[0] || process.execPath
  const appiumScript = installed?.ProgramArguments?.[1] || (appiumBinary ? await realpath(appiumBinary) : null)
  appiumHome = installed?.EnvironmentVariables?.APPIUM_HOME || appiumHome
  const driverPath = path.join(appiumHome, 'node_modules/appium-xcuitest-driver')
  const wdaRoot = path.join(driverPath, 'node_modules/appium-webdriveragent')
  const builtWda = path.join(wdaRoot, 'build/Debug-iphoneos/WebDriverAgentRunner-Runner.app')
  let wdaBundleId = null
  if (await exists(path.join(builtWda, 'Info.plist'))) wdaBundleId = plist(path.join(builtWda, 'Info.plist')).CFBundleIdentifier?.replace(/\.xctrunner$/, '')
  const devices = await deviceList()
  const connected = devices.filter((d) => d.connection === 'connected')
  const target = udid ? devices.find((d) => d.udid === udid) : connected.length === 1 ? connected[0] : null
  return {schemaVersion: 1, nodePath, appiumScript, appiumHome, driverPath, wdaRoot, wdaBundleId,
    tunnelScript: path.join(driverPath, 'scripts/tunnel-creation.mjs'),
    appiumUrl: 'http://127.0.0.1:4723', wdaLocalPort: 8100, tunnelRegistryPort: 42314,
    ...(target || {}), devices, managedServices: {},
    next: !target ? 'Choose --udid from devices; no device is selected automatically when ambiguous' : !wdaBundleId ? 'Configure your WDA bundle identifier and signing team; use wda-build/wda-install' : 'Review and save as the local configuration'}
}

export async function saveLocal(file, config, {replace = false} = {}) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700})
  const text = JSON.stringify(config, null, 2)
  if (!replace) return publishArtifact(file, text)
  const original = await lstat(file)
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('Refuse to replace a non-regular local configuration')
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, {flag: 'wx', mode: 0o600})
    await rename(temporary, file)
  } finally { await rm(temporary, {force: true}) }
}

const xmlEscape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
export async function serviceDefinition(config, name) {
  if (!['appium', 'tunnel'].includes(name)) throw new Error('Service must be appium or tunnel')
  requireDevice(config)
  const label = `com.yjx.iphone-${name}`
  const target = name === 'appium' ? path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist') : path.join('/Library/LaunchDaemons', label + '.plist')
  const appium = new URL(config.appiumUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(appium.hostname)) throw new Error('Appium must be loopback only')
  const values = {label, nodePath: config.nodePath, appiumScript: config.appiumScript,
    tunnelScript: config.tunnelScript, home: os.homedir(), appiumHome: config.appiumHome,
    workingDirectory: skillDir, commandPath: `${path.dirname(config.nodePath || '')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    appiumPort: appium.port || '4723', udid: config.udid, registryPort: config.tunnelRegistryPort || 42314,
    stdout: name === 'appium' ? path.join(os.homedir(), 'Library/Logs/yjx-iphone-appium.log') : '/var/log/yjx-iphone-tunnel.log',
    stderr: name === 'appium' ? path.join(os.homedir(), 'Library/Logs/yjx-iphone-appium.error.log') : '/var/log/yjx-iphone-tunnel.error.log'}
  let content = await readFile(path.join(skillDir, 'launchd', label + '.plist'), 'utf8')
  content = content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) throw new Error(`Missing service configuration: ${key}`)
    return xmlEscape(values[key])
  })
  return {label, target, content, domain: name === 'appium' ? `gui/${process.getuid()}` : 'system', root: name === 'tunnel'}
}

export async function requireMaintenance(config, exclusive, lockHeld = false) {
  if (!exclusive) throw new Error('Maintenance requires --exclusive after confirming this task is the sole device/service owner')
  await assertSessionReady(config.sessionFile)
  if (await exists(config.sessionFile + '.creating') || (!lockHeld && await exists(config.sessionFile + '.lock'))) {
    throw new Error('Device command/session creation is active or unresolved; no maintenance was performed')
  }
}

export async function ownedService(config, name, definition) {
  const stat = await lstat(definition.target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Service plist must be a regular file')
  const raw = await readFile(definition.target)
  const record = config.managedServices?.[name]
  if (!record || record.path !== definition.target || record.sha256 !== sha(raw)) {
    throw new Error('Service ownership/configuration is unconfirmed or changed. Inspect service status and explicitly adopt it before modifying it')
  }
  return raw
}

export async function waitForServiceUnload({domain, label, execute = run, timeoutMs = 10000, pollIntervalMs = 100,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}) {
  const deadline = now() + timeoutMs
  while (true) {
    try { execute('/bin/launchctl', ['print', `${domain}/${label}`]) }
    catch (error) {
      const details = String(error.stderr || error.message || '')
      if (error.status === 113 && details.includes(`Could not find service "${label}"`)) return
      error.phase = 'service-unload'
      error.outcome = error.code === 'ETIMEDOUT' ? 'unknown' : 'inspect-service-state'
      throw error
    }
    const remaining = deadline - now()
    if (remaining <= 0) throw Object.assign(new Error('Service unload is not yet confirmed; no bootstrap was sent'), {
      phase: 'service-unload', outcome: 'unknown', service: `${domain}/${label}`,
    })
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}

export async function serviceAction(config, action, name, {exclusive = false, execute = run, lockHeld = false, definition: supplied} = {}) {
  if (!['plan', 'status'].includes(action) && !lockHeld) {
    await requireMaintenance(config, exclusive)
    return withFileLock(config.sessionFile + '.lock', () => serviceAction(config, action, name, {exclusive, execute, lockHeld: true, definition: supplied}))
  }
  const definition = supplied || await serviceDefinition(config, name)
  const {root, domain, label, target, content} = definition
  const launchctl = (args) => {
    try { return execute(root ? 'sudo' : '/bin/launchctl', root ? ['/bin/launchctl', ...args] : args, {stdio: 'inherit'}) }
    catch (error) {
      error.phase = `service-${args[0]}`
      error.outcome = error.code === 'ETIMEDOUT' ? 'unknown' : 'inspect-service-state'
      throw error
    }
  }
  if (action === 'plan') return {action, name, target, domain, sha256: sha(content), content}
  if (action === 'status') {
    let loaded = false
    try { execute('/bin/launchctl', ['print', `${domain}/${label}`]); loaded = true } catch {}
    return {action, name, loaded, target, managed: Boolean(config.managedServices?.[name])}
  }
  await requireMaintenance(config, exclusive, lockHeld)
  if (action === 'adopt') {
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular service configurations can be adopted')
    const raw = await readFile(target)
    const existing = plist(target)
    if (existing.Label !== label || existing.ProgramArguments?.[0] !== config.nodePath ||
      existing.ProgramArguments?.[1] !== (name === 'appium' ? config.appiumScript : config.tunnelScript)) throw new Error('Existing service identity does not match local configuration')
    config.managedServices ||= {}
    config.managedServices[name] = {path: target, sha256: sha(raw)}
    await saveLocal(config.configPath, config, {replace: true})
    return {ok: true, action, name, modifiedService: false}
  }
  let backup
  if (await exists(target)) backup = await ownedService(config, name, definition)
  else if (action !== 'install') throw new Error('Service is not installed')
  if (action === 'install') {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'iphone-service-'))
    try {
      const temporary = path.join(scratch, label + '.plist')
      await writeFile(temporary, content, {mode: 0o600})
      execute('/usr/bin/plutil', ['-lint', temporary])
      let backupPath
      if (backup) {
        backupPath = path.join(path.dirname(config.configPath), `${label}.${Date.now()}.backup.plist`)
        await publishArtifact(backupPath, backup)
      }
      await mkdir(path.dirname(target), {recursive: true})
      const install = (source) => execute(root ? 'sudo' : '/usr/bin/install', root ? ['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '644', source, target] : ['-m', '644', source, target], {stdio: 'inherit'})
      const previousRecord = config.managedServices?.[name]
      try {
        install(temporary)
        config.managedServices ||= {}
        config.managedServices[name] = {path: target, sha256: sha(content), ...(backupPath ? {backupPath} : {})}
        await saveLocal(config.configPath, config, {replace: true})
      } catch (error) {
        error.phase = 'install-service'
        error.backupPath = backupPath
        if (backup) {
          try {
            install(backupPath)
            config.managedServices[name] = previousRecord
            error.rollback = 'previous-configuration-restored'
          } catch (restoreError) { error.rollback = 'failed: ' + restoreError.message }
        } else error.rollback = 'new-installation-state-requires-inspection'
        throw error
      }
    } finally { await rm(scratch, {recursive: true, force: true}) }
    return {ok: true, action, name, next: 'Restart an already loaded service to apply the definition (start if unloaded), then verify registry, WDA and target App readiness'}
  }
  if (!['start', 'restart', 'stop'].includes(action)) throw new Error('Unknown service action')
  if (action === 'start') {
    try { execute('/bin/launchctl', ['print', `${domain}/${label}`]); return {ok: true, action, name, alreadyLoaded: true} } catch {}
    // An existing port listener is not proof it belongs to this service.
    if (name === 'appium') {
      let listeners = ''
      try { listeners = execute('/usr/sbin/lsof', ['-nP', `-iTCP:${new URL(config.appiumUrl).port || 4723}`, '-sTCP:LISTEN']) } catch (error) { if (error.status !== 1) throw error }
      if (listeners.trim()) throw new Error('Appium port is already occupied; no process was stopped')
    }
  } else {
    launchctl(['bootout', `${domain}/${label}`])
    await waitForServiceUnload({execute, domain, label})
  }
  if (action !== 'stop') {
    try { launchctl(['bootstrap', domain, target]) }
    catch (error) { error.phase = 'service-bootstrap'; error.rollback = 'inspect exact launchd label; no other process was stopped'; throw error }
  }
  return {ok: true, action, name, next: 'Run doctor, session, recover, and an actual target App observation before claiming repaired'}
}

export async function wdaAction(config, action, {exclusive, teamId, appPath, allowRegistration = false, execute = run} = {}) {
  requireDevice(config)
  await requireMaintenance(config, exclusive)
  return withFileLock(config.sessionFile + '.lock', async () => {
    await requireMaintenance(config, exclusive, true)
    const derived = path.join(path.dirname(config.configPath), 'wda-build')
    if (action === 'build') {
      if (!/^[A-Z0-9]{10}$/.test(teamId || '')) throw new Error('Provide --team-id for the Xcode signing account; credentials stay in Xcode/keychain')
      if (!/^[a-zA-Z0-9.-]+$/.test(config.wdaBundleId)) throw new Error('Invalid WDA bundle ID')
      execute('xcodebuild', ['build-for-testing', '-project', path.join(config.wdaRoot, 'WebDriverAgent.xcodeproj'),
        '-scheme', 'WebDriverAgentRunner', '-configuration', 'Debug', '-destination', `id=${config.udid}`,
        '-derivedDataPath', derived, `DEVELOPMENT_TEAM=${teamId}`, 'CODE_SIGN_IDENTITY=Apple Development',
        `PRODUCT_BUNDLE_IDENTIFIER=${config.wdaBundleId}`,
        ...(allowRegistration ? ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration'] : [])], {stdio: 'inherit', timeout: 300000})
      return {ok: true, stage: 'wda-built', appPath: path.join(derived, 'Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app'), next: 'Verify and install the signed WDA; build success does not prove device readiness'}
    }
    if (action !== 'install') throw new Error('Use wda build or wda install')
    appPath ||= path.join(derived, 'Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app')
    const info = plist(path.join(appPath, 'Info.plist'))
    if (info.CFBundleIdentifier !== `${config.wdaBundleId}.xctrunner` ||
      !await exists(path.join(appPath, 'PlugIns/WebDriverAgentRunner.xctest'))) throw new Error('Only the configured WebDriverAgent Runner may be installed by this skill')
    execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
    execute('xcrun', ['devicectl', 'device', 'install', 'app', '--device', config.udid, appPath], {stdio: 'inherit', timeout: 120000})
    return {ok: true, stage: 'wda-installed', next: 'Complete device trust if prompted, then verify tunnel, session and target App observation'}
  })
}

async function main() {
  const [command, action, name] = process.argv.slice(2)
  const args = process.argv.slice(2)
  const option = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined }
  if (command === 'discover') {
    const found = await discover({udid: option('--udid') || process.env.IOS_DEVICE_UDID})
    const output = option('--output')
    if (output) {
      if (!found.udid) throw new Error('Select a device with --udid before saving')
      // Adopt a legacy cached session only when its device identity matches.
      const legacy = path.join(os.tmpdir(), 'yjx-iphone-app-ops-xsmax.json')
      if (await exists(legacy)) {
        const previous = JSON.parse(await readFile(legacy, 'utf8'))
        if (previous.udid === found.udid) found.sessionFile = legacy
      }
      await saveLocal(output, found)
    }
    return {...found, configPath: output || defaultConfigPath, saved: Boolean(output)}
  }
  const config = await loadConfig()
  if (command === 'show') return config
  if (command === 'service') return serviceAction(config, action, name, {exclusive: args.includes('--exclusive')})
  if (command === 'wda') return wdaAction(config, action, {exclusive: args.includes('--exclusive'), teamId: option('--team-id'),
    appPath: option('--app-path'), allowRegistration: args.includes('--allow-registration')})
  if (command === 'dependencies') {
    // Pin tested versions; existing installations are not silently upgraded.
    const plans = [config.appiumScript ? [config.nodePath || process.execPath, config.appiumScript, 'driver', 'doctor', 'xcuitest'] : ['appium', 'driver', 'doctor', 'xcuitest'],
      ['npm', 'install', '--global', 'appium@3.8.0'], ['appium', 'driver', 'install', '--source=npm', 'appium-xcuitest-driver@12.20.0']]
    if (!args.includes('--apply')) return {commands: plans, next: 'Inspect existing toolchain first; --apply only installs missing dependencies'}
    await requireMaintenance(config, args.includes('--exclusive'))
    return withFileLock(config.sessionFile + '.lock', async () => {
    await requireMaintenance(config, true, true)
    const dependencyEnv = {...process.env, APPIUM_HOME: config.appiumHome || path.join(os.homedir(), '.appium'),
      PATH: `${path.dirname(config.nodePath || process.execPath)}:${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`}
    if (!locate('appium') && !(config.appiumScript && await exists(config.appiumScript))) run('npm', ['install', '--global', 'appium@3.8.0'], {stdio: 'inherit', timeout: 300000, env: dependencyEnv})
    const configuredAppium = config.appiumScript && await exists(config.appiumScript)
    const appium = (args) => configuredAppium ? run(config.nodePath || process.execPath, [config.appiumScript, ...args], {stdio: 'inherit', timeout: 300000, env: dependencyEnv})
      : run('appium', args, {stdio: 'inherit', timeout: 300000, env: dependencyEnv})
    if (!await exists(path.join(config.appiumHome || path.join(os.homedir(), '.appium'), 'node_modules/appium-xcuitest-driver/package.json'))) {
      appium(['driver', 'install', '--source=npm', 'appium-xcuitest-driver@12.20.0'])
    }
    appium(['driver', 'doctor', 'xcuitest'])
    return {ok: true, next: 'Discover paths again, prepare WDA, then verify the full control chain'}
    })
  }
  throw new Error('Use discover [--udid ID --output PATH], show, dependencies [--apply --exclusive], wda <build|install> [--team-id ID --app-path PATH --exclusive], service <plan|status|adopt|install|start|restart|stop> <appium|tunnel> [--exclusive]')
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
  console.log(JSON.stringify({ok: false, status: 'environment-blocked', error: error.message,
    phase: error.phase || null, rollback: error.rollback || null, backupPath: error.backupPath || null,
    outcome: error.outcome || null,
    next: 'Inspect the exact service/configuration and complete the specific recovery or user authorization step'}))
  process.exitCode = 1
})
