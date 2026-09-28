/** Restore a private Node distribution from the same verified pin as init.sh. */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function preparePrivateNode({ repo, destination, source, execute, env }) {
  if (source) {
    await cp(source, destination, { recursive: true, verbatimSymlinks: true })
    return
  }
  const suffix = `-${process.platform}-${process.arch}.tar.gz`
  const entries = (await readFile(join(repo, 'runtime/node-release.sha256'), 'utf8')).trim().split('\n').filter(line => line.endsWith(suffix))
  const pin = entries.length === 1 && /^([a-f0-9]{64})\s+(node-v(\d+\.\d+\.\d+)-(?:darwin|linux)-(?:arm64|x64)\.tar\.gz)$/.exec(entries[0])
  if (!pin) throw new Error('Missing or invalid pinned Node.js release')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-repair-node-'))
  try {
    const archive = join(temporary, pin[2])
    await execute('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
      `https://nodejs.org/dist/v${pin[3]}/${pin[2]}`, '-o', archive], { cwd: temporary, env })
    if (createHash('sha256').update(await readFile(archive)).digest('hex') !== pin[1]) throw new Error('Node.js archive SHA-256 mismatch')
    await mkdir(destination)
    await execute('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], { cwd: temporary, env })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
