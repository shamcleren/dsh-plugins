/** Write the installation dhp launcher and a user-local command name. */
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const owner = 'shamcleren/dsh-plugin/bootstrap-v1'
const marker = '# dsh-plugin: dhp on PATH'
const pathLine = 'export PATH="$HOME/.local/bin:$PATH"'

export function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

export function dhpLauncherScript({ node, cli, root }) {
  return '#!/bin/sh\nset -eu\nunset NODE_OPTIONS NODE_PATH\nexport DSH_PLUGIN_DIR=' +
    quote(root) + '\nexec ' + quote(node) + ' ' + quote(cli) + ' "$@"\n'
}

async function optionalStat(path) {
  try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

export async function writeDhpLauncher({ root, repo, node, outputRoot = root }) {
  const path = join(outputRoot, 'bin/dhp')
  const existing = await optionalStat(path)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Unsafe dhp launcher path')
  await mkdir(join(root, 'bin'), { recursive: true, mode: 0o700 })
  await writeFile(path, dhpLauncherScript({ node, cli: join(repo, 'scripts/dhp.mjs'), root }), { mode: 0o700 })
  return path
}

async function belongsToInstaller(launcher) {
  if (!isAbsolute(launcher) || !launcher.endsWith('/bin/dhp')) return false
  try {
    const state = JSON.parse(await readFile(join(dirname(dirname(launcher)), 'bootstrap-state.json'), 'utf8'))
    return state.owner === owner
  } catch { return false }
}

export async function publishUserDhp({ launcher, userHome = homedir(), pathEnv = process.env.PATH ?? '', log = console.log }) {
  if (typeof launcher !== 'string' || !isAbsolute(launcher)) throw new Error('dhp launcher must be absolute')
  const bin = join(userHome, '.local/bin')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const command = join(bin, 'dhp')
  const existing = await optionalStat(command)
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error('Refusing to replace ' + command + '; it is not a dhp symlink from this installer')
    const target = resolve(bin, await readlink(command))
    if (target !== launcher && !(await belongsToInstaller(target))) {
      throw new Error('Refusing to replace ' + command + '; it does not belong to this installer')
    }
    await unlink(command)
  }
  await symlink(launcher, command)
  const onPath = pathEnv.split(':').includes(bin)
  if (!onPath) {
    const snippet = marker + '\n' + pathLine + '\n'
    for (const name of process.platform === 'darwin' ? ['.zprofile', '.zshrc'] : ['.profile']) {
      const rc = join(userHome, name)
      const previous = await readFile(rc, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' })
      if (previous.includes(marker)) continue
      await writeFile(rc, (previous && !previous.endsWith('\n') ? previous + '\n' : previous) + snippet, { mode: 0o600 })
    }
    log('Added ' + bin + ' to PATH in the user shell profile. Open a new terminal, then run: dhp help')
  } else log('Command: dhp  (' + command + ')')
  return command
}
