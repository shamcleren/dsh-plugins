# Codex app-server composition plugin

## Decision

The external plugin composes the published Codex subagent provider and shared subagent tool instead of implementing another JSON-RPC client. The public tool name is `codex_delegate`, the provider name is `codex-controller`, and the default permission mode is `never`.

## Rationale

Codex app-server evolves with the Codex binary. The published provider pins one verified protocol and native wrapper version and already owns handshake validation, terminal-answer selection, safe diagnostics, cancellation, process-tree teardown, and unattended server-request handling. Reusing it keeps those responsibilities in one implementation.

The external package owns product composition and model policy. Operators install, remove, version, and configure this capability without changing the Harness repository.

## Alternatives considered

A new direct app-server transport would duplicate protocol state and require independent schema, platform, cancellation, approval, and teardown evidence. An MCP gateway would add a second process and translate the same lifecycle into a generic tool protocol while losing the Harness subagent and Job integration.

## Verification

Bundle tests parse the real patch file, prove provider-before-consumer ordering, pin the provider and tool identities, and require the safe permission default. TypeScript checks and build verify the exported policy plugin.
