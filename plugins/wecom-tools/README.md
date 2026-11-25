# @shamcleren/dsh-wecom-tools

Independent WeCom office-tool capability for DeepSeek Harness. It contributes the upstream `wecom-unified` Skill without installing or configuring the WeCom AI Bot message channel.

## Messaging

- Ask the Skill to send a message as the intelligent bot to the authorized user or to a recently active conversation returned by WeCom. Text uses Markdown. WeCom also accepts images, files, AMR voice and video.
- Ask the Skill to read a named group's messages in a time range within the last 7 days. The Skill can extract text and summarize the discussion. Access depends on the organization's chat history permission and the authorized user's visibility.

## Authentication boundary

The bundled Skill uses the authorization from `wecom-cli auth init --noninteractive`. The WeCom channel in `@shamcleren/dsh-im` uses its own Bot ID and Secret.

Every DSH user invoking the Skill shares the authorization stored for the operating-system account running the Host. Restrict access and retain DSH approval gates before enabling this capability for a multi-user deployment.

## Install

Install from **Remote Market** or from this repository's local release tarball. For source changes, build the local plugin directory before installing it. Both paths use the same Web profile; see the [plugin management guide](../../docs/plugin-management.md) for commands, updates and removal.

Restart the Host, then invoke `wecom-unified` through conversation. The Skill requires `@wecom/cli` 1.3.4 or newer and guides first-use authorization. The CLI is installed separately; installing or updating this plugin does not install or upgrade it. Installation and upgrade instructions pin `@wecom/cli@1.3.4`, check the actual command path against the npm global prefix, and retain one verified CLI path throughout each workflow. A CLI-only upgrade does not require a Host restart.

## Upstream snapshot

The bundled Skill is based on [`wecomTeam/wecom-unified`](https://github.com/wecomTeam/wecom-unified) commit `c2947ae194703c06cbfe06444a263d1da094ea78`. See [third-party notices](THIRD_PARTY_NOTICES.md) for the local changes. Upstream content remains MIT-licensed, and its license and attribution are included in this package.
