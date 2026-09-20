/** Materialize the filesystem effects of the public CLI for installer transaction tests. */
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const repo = fileURLToPath(new URL('../../', import.meta.url))
export async function fakeInstall(command, args, settings) {
  if (command === 'npm') {
    const runtime = settings.cwd
    const version = JSON.parse(await readFile(join(runtime, 'package.json'))).dependencies['@deepseek-ai/dsh']
    await mkdir(join(runtime, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
    await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version }))
    await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'console.log(' + JSON.stringify(version) + ')')
    for (const name of ['semver', '@deepseek-ai/dsh-credentials-local']) {
      try { await symlink(join(repo, 'runtime/node_modules', name), join(runtime, 'node_modules', name)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
  }
  if (!args.includes('plugin')) return
  const profile = join(settings.env.DSH_HOME, 'profiles/web'), runtime = settings.cwd
  await mkdir(profile, { recursive: true })
  let manifest
  try { manifest = JSON.parse(await readFile(join(profile, 'package.json'))) } catch { manifest = { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } } }
  for (const artifact of args.filter(arg => arg.endsWith('.tgz'))) {
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }))
    await mkdir(join(profile, 'node_modules', pkg.name), { recursive: true })
    await writeFile(join(profile, 'node_modules', pkg.name, 'package.json'), JSON.stringify(pkg))
    manifest.dependencies[pkg.name] = 'file:' + artifact
    if (!manifest.dsh.profile.bundles.includes(pkg.name)) manifest.dsh.profile.bundles.push(pkg.name)
    for (const [peer, version] of Object.entries(pkg.peerDependencies ?? {})) if (peer.startsWith('@deepseek-ai/dsh-')) {
      try { await lstat(join(runtime, 'node_modules', peer, 'package.json')); continue } catch (error) { if (error.code !== 'ENOENT') throw error }
      await mkdir(join(runtime, 'node_modules', peer), { recursive: true })
      await writeFile(join(runtime, 'node_modules', peer, 'package.json'), JSON.stringify({ version }))
    }
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
}
