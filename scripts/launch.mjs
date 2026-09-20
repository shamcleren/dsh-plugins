/** Installed launcher; independent of the repository checkout and global DSH. */
import { readFile, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './process.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtime = join(root, 'runtime')
try {
  for (const name of ['.bootstrap.lock', '.update-transaction.json']) {
    try { await lstat(join(root, name)); throw new Error('Installation is updating; finish make init before starting DSH') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const state = JSON.parse(await readFile(join(root, 'bootstrap-state.json'), 'utf8'))
  if (state.owner !== 'shamcleren/dsh-plugin/bootstrap-v1' || ![1, 2].includes(state.schemaVersion)) throw new Error('Invalid installation state')
  const dshHome = state.schemaVersion === 1 ? join(root, 'home') : state.dshHome
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) throw new Error('Invalid DSH configuration directory')
  for (const name of ['.dhp-install.lock', '.dhp-profile-update.json']) {
    try { await lstat(join(dshHome, name)); throw new Error('DSH home is updating; finish make init before starting DSH') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await run(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    ...(process.argv.length > 2 ? process.argv.slice(2) : ['web', '--host', '127.0.0.1', '--port', '3080', '--no-open'])], {
    cwd: runtime,
    env: { ...process.env, PATH: dirname(process.execPath) + ':' + join(runtime, 'node_modules/.bin') + ':' + (process.env.PATH ?? ''),
      DSH_HOME: dshHome, DSH_AGENTS_HOME: join(root, 'agents') },
  })
} catch (error) { console.error(error.message); process.exitCode = 1 }
