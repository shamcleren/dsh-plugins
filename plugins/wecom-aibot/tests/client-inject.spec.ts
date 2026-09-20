import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { cardApi } from '../src/client/api.js'
import { inject } from '../src/client/index.js'

/**
 * Records every `remote.<namespace>` the card API reaches for. Each namespace is
 * a separate Cordis service, so one missing from `inject` throws at call time
 * rather than at registration.
 */
function recordingContext(touched: Set<string>): Context {
  const namespaces: Record<string, Record<string, (...args: never[]) => unknown>> = {
    credentials: {
      describe: async () => ({ ok: true, value: {} }),
      set: async () => ({ ok: true, value: undefined }),
    },
    workspace: {
      follow: () => (async function* () { yield { type: 'baseline', value: { items: [] } } })(),
    },
    agentPresets: {
      list: async () => ({ ok: true, value: { presets: [] } }),
    },
  }
  const remote = new Proxy({}, {
    get(_target, property: string) {
      if (property.startsWith('$')) return () => () => {}
      touched.add(property)
      const namespace = namespaces[property]
      if (namespace === undefined) throw new Error(`unstubbed remote namespace: ${property}`)
      return namespace
    },
  })
  return { remote, effect: () => () => {} } as unknown as Context
}

describe('client inject', () => {
  it('declares every remote namespace the card API calls', async () => {
    const touched = new Set<string>()
    const api = cardApi(recordingContext(touched))
    await api.credentials.describe({ refs: ['WECOM_BOT_ID'] })
    await api.credentials.set({ ref: 'WECOM_BOT_ID', value: 'value' })
    await api.workspace.list({})
    await api.presets.list({})
    expect(touched.size).toBeGreaterThan(0)
    expect([...touched].map(namespace => `remote.${namespace}`).filter(key => !inject.includes(key))).toEqual([])
  })

  it('keeps the remote mount point beside its namespaces', () => {
    expect(inject).toContain('remote')
  })
})
