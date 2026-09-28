/** Read-only comparison with the same repository release used by dhp update. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { releaseInfo } from './bootstrap.mjs'
import { homeProfileUpdates } from './home-compatibility.mjs'
import { repositoryRoot } from './installation.mjs'
import { installationDigests, optionalStat } from './update-installation.mjs'

const json = async path => JSON.parse(await readFile(path, 'utf8'))
async function installedVersion(path) {
  try { return (await json(path)).version ?? 'unknown' }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return 'missing/unknown' }
}

export async function reportUpdates({ installation, app, repo = repositoryRoot, log = console.log }) {
  const { root, dshHome, desktop } = installation
  log('Update target: repository-pinned release (offline; not upstream latest)')
  try {
    for (const path of [join(root, '.bootstrap.lock'), join(root, '.update-transaction.json'), join(dshHome, '.dhp-profile-update.json')]) {
      if (await optionalStat(path)) {
        log('Update preview unavailable: installation is updating or has an unfinished transaction.')
        return
      }
    }
    const release = await releaseInfo(repo)
    const state = await json(join(root, 'bootstrap-state.json'))
    const current = await installedVersion(join(root, 'runtime/node_modules/@deepseek-ai/dsh/package.json'))
    const runtimeChanged = current !== release.dshVersion || state.runtimeDigest !== release.runtimeDigest
    log('DSH: ' + current + ' -> ' + release.dshVersion + (current !== release.dshVersion ? ' [version change]' : runtimeChanged ? ' [dependency refresh]' : ' [aligned]'))
    const signingEnv = { ...process.env,
      ...(app?.shareSigning ? {
        CODESIGN_IDENTITY: process.env.CODESIGN_IDENTITY ?? app.shareSigning.identity,
        DSH_SHARE_TEAM_ID: process.env.DSH_SHARE_TEAM_ID ?? app.shareSigning.team,
      } : {}),
    }
    const digests = await installationDigests(repo, desktop, release.runtimeDigest, process.env.DSH_APP_PORT ?? String(app?.servicePort ?? 3080), signingEnv)
    if (desktop) {
      const target = (await json(join(repo, 'apps/macos/package.json'))).version
      log('App: ' + (app?.version ?? 'missing/unknown') + ' -> ' + target +
        (!app || app.version !== target || state.appDigest !== digests.appDigest ? ' [rebuild pending]' : ' [aligned]'))
    }
    log('Launchers: ' + (runtimeChanged || state.launcherDigest !== digests.launcherDigest ? 'refresh pending' : 'aligned'))
    const plugins = await homeProfileUpdates({ home: dshHome, repo, release })
    log('Catalog plugins: ' + (plugins.length ? plugins.length + ' pending' : 'no pending version replacements'))
    for (const plugin of plugins) log('  ' + plugin.id + ': ' + plugin.current + ' -> ' + plugin.target + (plugin.source ? ' [source link -> release package]' : ''))
    log('Preview only: third-party plugins, full integrity and compatibility checks are deferred to dhp update.')
    log('Apply/repair: dhp update (exit DSH first; use the same --dir for a custom installation)')
  } catch (error) {
    log('Update preview incomplete: ' + error.message)
  }
}
