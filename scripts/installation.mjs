/** Shared installation records and ownership checks for repo-local commands. */
import { execFile } from 'node:child_process'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const capture = promisify(execFile)
export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const owner = 'shamcleren/dsh-plugin/bootstrap-v1'

export function defaultDirectory(repo = repositoryRoot) {
  return join(repo, 'dist')
}

async function optionalStat(path) {
  try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

export async function readInstallation(directory, repo = repositoryRoot) {
  const root = resolve(directory ?? defaultDirectory(repo))
  const state = JSON.parse(await readFile(join(root, 'bootstrap-state.json'), 'utf8'))
  if (state.owner !== owner || ![1, 2].includes(state.schemaVersion) || state.status !== 'ready') {
    throw new Error('DSH installation is not ready; complete make init with the same --dir first')
  }
  const dshHome = state.schemaVersion === 1 ? join(root, 'home') : state.dshHome
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) throw new Error('Invalid DSH configuration directory')
  const launcher = join(root, 'bin/dsh')
  await access(launcher, constants.X_OK)
  return { root, dshHome, launcher, profile: join(dshHome, 'profiles/web'), desktop: state.desktop === true }
}

function ownsCommand(command, roots) {
  return roots.some(path => command.includes(path + '/') &&
    (/\/Contents\/MacOS\/DeepSeekHarness(?:\s|$)/.test(command) || /\/dsh\/lib\/bin\.js(?:\s|$)/.test(command)))
}

export async function listOwnedProcesses(root, { inspect = capture, pid = process.pid, canonicalize = realpath } = {}) {
  const roots = [...new Set([root, await canonicalize(root)])]
  const { stdout } = await inspect('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'command='], { maxBuffer: 8 * 1024 * 1024 })
  const matches = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || Number(match[1]) === pid) continue
    if (ownsCommand(match[2], roots)) matches.push({ pid: Number(match[1]), command: match[2] })
  }
  return matches
}

export async function assertInstallationIdle(root) {
  const processes = await listOwnedProcesses(root)
  if (processes[0]) throw new Error('Close this installation\'s DSH App/Web process before updating (PID ' + processes[0].pid + ')')
}

export async function readNativeApp(root) {
  const path = join(root, 'native-app.json')
  if (!(await optionalStat(path))?.isFile()) return undefined
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (typeof value.app !== 'string' || !/^(?:apps\/)?[^/\\]+\.app$/.test(value.app)) throw new Error('Invalid native app record')
  const app = join(root, value.app)
  const stat = await optionalStat(app)
  if (!stat?.isDirectory()) throw new Error('Native app is missing')
  const port = value.servicePort
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid recorded App port')
  return { ...value, path: app, port: port ?? 3080 }
}

export async function installationBusy(root) {
  for (const name of ['.bootstrap.lock', '.update-transaction.json']) {
    if (await optionalStat(join(root, name))) {
      throw new Error('Installation is updating; finish make init before starting DSH')
    }
  }
}
