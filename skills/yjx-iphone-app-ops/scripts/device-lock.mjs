import {mkdir, open, readFile, rm, stat} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'

export async function withFileLock(lockPath, action) {
  await mkdir(path.dirname(lockPath), {recursive: true})
  let handle
  const nonce = randomUUID()
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({pid: process.pid, at: Date.now(), nonce}))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch {}
      let alive = true
      if (owner?.pid && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0) } catch (probeError) { alive = probeError.code === 'EPERM' }
      } else {
        try { alive = Date.now() - (await stat(lockPath)).mtimeMs < 30000 } catch { alive = false }
      }
      if (!alive) {
        throw new Error('stale device lock; verify no owner is using the phone before removing ' + lockPath)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (!handle) throw new Error('another iPhone operation is still active')
  try {
    return await action()
  } finally {
    await handle.close()
    let owner
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch {}
    if (owner?.nonce === nonce) await rm(lockPath, {force: true})
  }
}
