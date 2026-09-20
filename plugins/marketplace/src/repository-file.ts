/** Validation for Gongfeng repository file metadata used by raw downloads. */

import { z } from 'zod'

const repositoryFileSchema = z.looseObject({
  size: z.number().int().nonnegative().optional(),
  commit_id: z.string().min(1),
})

/** Validated commit identity and optional byte size for one raw file. */
export interface RepositoryFilePointer {
  readonly commitId: string
  readonly size?: number
}

/**
 * Parse one Gongfeng repository-file response with an explicit byte bound.
 * @param output Raw JSON response bytes.
 * @param maxBytes Maximum raw file bytes.
 * @returns A validated raw-file pointer.
 */
export function parseRepositoryFilePointer(output: Buffer, maxBytes: number): RepositoryFilePointer {
  const parsed = repositoryFileSchema.parse(JSON.parse(output.toString('utf8')))
  if (parsed.size !== undefined && parsed.size > maxBytes) {
    throw new Error('marketplace repository file exceeds its byte limit')
  }
  return { commitId: parsed.commit_id, ...parsed.size === undefined ? {} : { size: parsed.size } }
}
