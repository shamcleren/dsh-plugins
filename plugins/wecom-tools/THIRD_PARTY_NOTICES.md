# Third-party notices

## WeCom Unified

- Source: https://github.com/wecomTeam/wecom-unified
- Pinned commit: `c2947ae194703c06cbfe06444a263d1da094ea78`
- License: MIT
- Packaged path: `skills/wecom-unified/`
- Local normalization: trailing whitespace removed from Markdown files.
- Local CLI preflight: `skills/wecom-unified/SKILL.md` requires version 1.3.4 or newer, pins installation to `@wecom/cli@1.3.4`, checks command-path/global-prefix mismatches, and requires one verified CLI path for the entire workflow.
- Local messaging changes: `SKILL.md` routes proactive sends and group history to their respective references. `references/wecomcli-message.md` clarifies target and delivery checks, and `references/wecomcli-chat.md` adds group lookup, history pagination, and attachment retrieval based on the official `wecom-cli` 1.3.4 command documentation.

The upstream license text is included as `LICENSE.wecom-unified`.
