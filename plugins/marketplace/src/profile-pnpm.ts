import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const modules = z.looseObject({
  storeDir: z.string().refine(isAbsolute),
  nodeLinker: z.enum(['hoisted', 'isolated', 'pnp']).optional(),
})

/** Reuse the profile's installed layout even when the desktop launch environment differs from the installer. */
export async function profilePnpmOptions(profile: string): Promise<string[]> {
  const path = join(profile, 'node_modules/.modules.yaml')
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid pnpm profile metadata')
    const metadata = modules.parse(parse(await readFile(path, 'utf8'), { maxAliasCount: 0 }))
    return ['--store-dir', metadata.storeDir, ...(metadata.nodeLinker ? ['--config.node-linker=' + metadata.nodeLinker] : [])]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
