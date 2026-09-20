import { readFileSync } from 'node:fs'

/** baseline.yml uses YAML's JSON subset and owns patterns as well as model-visible metadata. */
const catalog = JSON.parse(readFileSync(new URL('../rules/baseline.yml', import.meta.url), 'utf8')) as { rules?: unknown }
if (!Array.isArray(catalog.rules)) throw new Error('Invalid bundled security rules')
export const RULES: Record<string, { title: string; cwe: string }> = Object.fromEntries(catalog.rules.map((value: unknown) => {
  if (value === null || typeof value !== 'object') throw new Error('Invalid bundled security rule')
  const rule = value as { id?: unknown; message?: unknown; metadata?: { cwe?: unknown } }
  if (typeof rule.id !== 'string' || !/^dsh-security\.[a-z-]+$/.test(rule.id) || typeof rule.message !== 'string' || typeof rule.metadata?.cwe !== 'string') {
    throw new Error('Invalid bundled security rule metadata')
  }
  return [rule.id, { title: rule.message, cwe: rule.metadata.cwe }]
}))
