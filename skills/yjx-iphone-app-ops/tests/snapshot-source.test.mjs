import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createAppiumClient} from '../scripts/iphone-app-ops.mjs'
import {assertSessionReady} from '../scripts/local-config.mjs'

async function fixture(t, capture, {rejectRestore = false, requestTimeoutMs = 45000} = {}) {
  let depth = 50
  const calls = []
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-snapshot-source-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const sessionFile = path.join(directory, 'session.json')
  const server = createServer(async (req, res) => {
    let input = ''
    for await (const chunk of req) input += chunk
    const body = input ? JSON.parse(input) : null
    const send = (status, value) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify({value})) }
    if (req.url.endsWith('/appium/settings')) {
      if (req.method === 'POST') {
        const requested = body.settings.snapshotMaxDepth
        calls.push(['depth', requested])
        if (rejectRestore && requested === 50) return send(500, {error: 'unknown error', message: 'Settings restore failed'})
        depth = requested
      }
      return send(200, {snapshotMaxDepth: depth})
    }
    if (req.url.endsWith('/elements')) { calls.push(['find', depth]); return send(200, []) }
    const json = body?.script === 'mobile: source'
    calls.push([json ? 'json' : 'xml', depth])
    return capture({depth, json, send})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return {calls, sessionFile, baseUrl, client: createAppiumClient({baseUrl, sourceMaxDepth: 10, sessionFile, requestTimeoutMs})}
}

test('XML snapshots bound depth while native lookup retains the original depth', async t => {
  const f = await fixture(t, ({depth, send}) => depth > 10
    ? send(500, {error: 'unknown error', message: 'The full snapshot cannot finish'})
    : send(200, '<XCUIElementTypeApplication bundleId="example.app"/>'))
  assert.match(await f.client.source('session'), /example.app/)
  await f.client.findElements('session', '-ios predicate string', 'type == "XCUIElementTypeSecureTextField"')
  assert.deepEqual(f.calls, [['depth', 10], ['xml', 10], ['depth', 50], ['find', 50]])
})

test('JSON snapshots use the same depth scope without changing their response', async t => {
  const tree = {type: 'Application', children: [{type: 'Button', name: 'Search'}]}
  const f = await fixture(t, ({depth, json, send}) => depth > 10 || !json
    ? send(500, {error: 'unknown error', message: 'Unbounded snapshot'}) : send(200, tree))
  assert.deepEqual(await f.client.execute('session', 'mobile: source', [{format: 'json'}]), tree)
  assert.deepEqual(f.calls, [['depth', 10], ['json', 10], ['depth', 50]])
})

test('a completed snapshot proxy timeout retains recovery state and sends no restore command', async t => {
  const f = await fixture(t, ({send}) => send(500, {error: 'unknown error', message: 'Could not proxy command to the remote server. Original error: timeout of 30000ms exceeded'}))
  await assert.rejects(f.client.source('session'), /Could not proxy command/)
  assert.deepEqual(f.calls, [['depth', 10], ['xml', 10]])
  assert.equal(JSON.parse(await readFile(f.sessionFile + '.reset-required', 'utf8')).sessionId, 'session')
})

test('a transport timeout does not restore settings behind an in-flight snapshot', async t => {
  const f = await fixture(t, () => {}, {requestTimeoutMs: 40})
  await assert.rejects(f.client.source('session'), error => error.transportPending && error.code === 'ETIMEDOUT')
  assert.deepEqual(f.calls, [['depth', 10], ['xml', 10]])
  assert.equal(JSON.parse(await readFile(f.sessionFile + '.unknown', 'utf8')).command, 'source')
})

test('an unconfirmed restore rejects the snapshot and requires recovery before native queries', async t => {
  const f = await fixture(t, ({send}) => send(200, '<XCUIElementTypeApplication bundleId="example.app"/>'), {rejectRestore: true})
  await assert.rejects(f.client.source('session'), /Settings restore failed/)
  assert.equal(JSON.parse(await readFile(f.sessionFile + '.reset-required', 'utf8')).reason, 'snapshot-settings-unconfirmed')
})

test('a killed snapshot process leaves durable protection that blocks the next operation', {timeout: 5000}, async t => {
  let reached
  const sourceReached = new Promise(resolve => { reached = resolve })
  const f = await fixture(t, () => { reached() })
  const moduleUrl = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).href
  const code = `const {createAppiumClient} = await import(${JSON.stringify(moduleUrl)}); await createAppiumClient(${JSON.stringify({baseUrl: f.baseUrl, sourceMaxDepth: 10, sessionFile: f.sessionFile})}).source('session')`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {stdio: 'ignore'})
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await sourceReached
  child.kill('SIGKILL')
  await exited
  const marker = JSON.parse(await readFile(f.sessionFile + '.reset-required', 'utf8'))
  assert.equal(marker.reason, 'snapshot-depth-scope')
  await assert.rejects(assertSessionReady(f.sessionFile), /recovery/)
  assert.deepEqual(f.calls, [['depth', 10], ['xml', 10]])
})
