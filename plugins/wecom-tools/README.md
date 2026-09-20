# @shamcleren/dsh-wecom-tools

Independent WeCom office-tool capability for DeepSeek Harness. It contributes the upstream `wecom-unified` Skill without installing or configuring the WeCom AI Bot message channel.

## Authentication boundary

This package does not use the Bot ID or Bot Secret from `@shamcleren/dsh-wecom-aibot`. The bundled Skill operates through `@wecom/cli`, whose `wecom-cli auth init --noninteractive` flow authorizes a user identity separately.

Every DSH user invoking the Skill shares the authorization stored for the operating-system account running the Host. Restrict access and retain DSH approval gates before enabling this capability for a multi-user deployment.

## Install

Install from **Remote Market** or from this repository's local release tarball. For source changes, build the local plugin directory before installing it. Both paths use the same Web profile; see the [plugin management guide](../../docs/plugin-management.md) for commands, updates and removal.

Restart the Host, then invoke `wecom-unified` through conversation. The Skill checks for `@wecom/cli` 1.1.0 or newer and guides first-use authorization.

## Upstream snapshot

The bundled Skill is copied from [`wecomTeam/wecom-unified`](https://github.com/wecomTeam/wecom-unified) commit `33aaa7155b0d1584828bc143a3877c4b5ec438fe`, with trailing Markdown whitespace normalized for this repository's checks. Upstream content remains MIT-licensed; its license and attribution are included in this package.
