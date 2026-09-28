import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    // Official V3 → V4 migration prefixes third-party producers.
    'plugin:codex-controller': { kind: 'plugin:codex-controller' } & ContextFormed
    'codex-controller': { kind: 'codex-controller' } & ContextFormed
  }
}
