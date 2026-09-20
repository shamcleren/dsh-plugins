/** Repository-local CLI after make init. */
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDirectory, readInstallation, repositoryRoot } from './installation.mjs'
import { executePlugin, managePlugin, updateInstalledPlugins } from './plugins.mjs'
import { run } from './process.mjs'
import { controlService } from './service.mjs'

export const helpText = `Usage: dhp [--dir DIR] <command>

make init performs first-time installation without requiring Node.js.
After init, dhp is available as a user command (reopen the terminal if PATH was just updated).

Commands:
  plugin list
  plugin install <name> [--source]   install or update a catalog plugin
  plugin update --all [--source]     update every installed catalog plugin
  plugin update <name> [--source]    same as install for one plugin
  plugin remove <name>
  plugin exec <name> -- <args...>    run the CLI declared by an installed plugin
  start [--web]                      open the macOS app, or Web with --web
  stop                               stop only this installation's App/Web
  restart [--web]                     restart the App Host, or Web with --web
  status
  update [--rebuild]                  update the pinned runtime and changed app
  help

Examples:
  dhp plugin install wechat
  dhp plugin install wechat --source
  dhp plugin update --all
  dhp plugin exec security-scan -- scan --target /absolute/path/project
  dhp --dir /path/dsh-plugins plugin list
  dhp restart
  dhp update`

function globalArgs(argv) {
  const rest = [...argv]
  let dir
  while (rest[0]?.startsWith('-')) {
    const token = rest.shift()
    if (token === '--dir') {
      const value = rest.shift()
      if (!value || value.startsWith('-')) throw new Error('--dir requires a directory')
      dir = resolve(value)
    } else if (token === '-h' || token === '--help') return { dir, rest: ['help'] }
    else throw new Error('Unknown global flag: ' + token)
  }
  return { dir, rest }
}

export async function runDhp(argv, hooks = {}) {
  const { dir, rest } = globalArgs(argv)
  const command = rest[0] ?? 'help'
  const repo = hooks.repo ?? repositoryRoot
  const directory = dir ?? (process.env.DSH_PLUGIN_DIR ? resolve(process.env.DSH_PLUGIN_DIR) : defaultDirectory(repo))
  if (command === 'help') {
    if (rest.length !== 1) throw new Error('help does not accept arguments')
    ;(hooks.log ?? console.log)(helpText)
    return 0
  }
  if (command === 'plugin' || command === 'p') {
    const aliases = { ls: 'list', i: 'install', rm: 'remove', run: 'exec' }
    const action = aliases[rest[1]] ?? rest[1]
    const plugin = rest[2]
    if (action === 'list') {
      if (rest.length !== 2) throw new Error('Usage: dhp plugin list')
      await managePlugin({ action, repo, directory, execute: hooks.execute, log: hooks.log })
      return 0
    }
    if (action === 'update') {
      const tokens = rest.slice(2)
      const source = tokens.includes('--source')
      const all = tokens.includes('--all')
      const names = tokens.filter(token => token !== '--source' && token !== '--all')
      if (tokens.some(token => token.startsWith('-') && token !== '--source' && token !== '--all')) {
        throw new Error('Usage: dhp plugin update <name>|--all [--source]')
      }
      if (all) {
        if (names.length) throw new Error('Usage: dhp plugin update --all [--source]')
        await updateInstalledPlugins({ source, repo, directory, execute: hooks.execute, log: hooks.log })
        return 0
      }
      if (names.length !== 1) throw new Error('Usage: dhp plugin update <name>|--all [--source]')
      await managePlugin({ action: 'install', plugin: names[0], source, repo, directory, execute: hooks.execute, log: hooks.log })
      return 0
    }
    if (action === 'install' || action === 'remove') {
      const flags = rest.slice(3)
      if (!plugin || flags.some(flag => flag !== '--source')) {
        throw new Error('Usage: dhp plugin ' + action + ' <name>' + (action === 'install' ? ' [--source]' : ''))
      }
      const source = flags.includes('--source')
      if (source && action !== 'install') throw new Error('--source applies only to plugin install')
      await managePlugin({ action, plugin, source, repo, directory, execute: hooks.execute, log: hooks.log })
      return 0
    }
    if (action === 'exec') {
      if (!plugin || rest[3] !== '--') throw new Error('Usage: dhp plugin exec <name> -- <args...>')
      await executePlugin({ plugin, args: rest.slice(4), repo, directory, execute: hooks.execute })
      return 0
    }
    throw new Error('Usage: dhp plugin list|install|update|remove|exec')
  }
  if (['start', 'stop', 'restart', 'status'].includes(command)) {
    const flags = rest.slice(1)
    if (flags.some(flag => flag !== '--web')) throw new Error('Unknown service flag: ' + flags[0])
    const web = flags.includes('--web')
    if (web && (command === 'stop' || command === 'status')) throw new Error('--web applies to start/restart')
    await controlService({
      action: command, web, directory, repo, log: hooks.log, execute: hooks.execute,
      inspect: hooks.inspect, spawnProcess: hooks.spawnProcess, kill: hooks.kill, waitMs: hooks.waitMs,
    })
    return 0
  }
  if (command === 'update') {
    const flags = rest.slice(1)
    if (flags.some(flag => flag !== '--rebuild')) throw new Error('Usage: dhp update [--rebuild]')
    const installation = await readInstallation(directory, repo)
    const execute = hooks.execute ?? run
    await execute(process.execPath, [
      join(repo, 'scripts/bootstrap.mjs'), '--dir', installation.root,
      ...(!installation.desktop ? ['--no-app'] : []),
      ...(flags.includes('--rebuild') ? ['--rebuild-app'] : []),
    ], { cwd: repo, env: process.env })
    return 0
  }
  throw new Error('Unknown command. Run dhp help')
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runDhp(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1 }
}
