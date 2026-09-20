# `@shamcleren/dsh-wechat`

Personal WeChat channel for DeepSeek Harness, backed by Tencent's official iLink Bot protocol.

## Install

Install through **Remote Market** or from this repository's local release tarball. For source changes, build `plugins/wechat` before installing the directory. See the [plugin management guide](../../docs/plugin-management.md) for commands, updates, removal, and the `before-web-app` ordering required after local installation. Loading the plugin starts all previously bound accounts automatically. New accounts need only QR authorization.

## Capabilities

- QR-code login with local owner-only credential persistence.
- Multiple authorized accounts, all started automatically.
- Restart-safe long-poll cursors and per-peer reply context tokens.
- Direct text and image prompts; voice transcription, file names, and video notices are retained as text.
- Durable account-and-peer Session routing and callback deduplication. Messages steer an active channel-owned turn; otherwise they queue through the upstream Host API. A rejected steer retries once as queued input.
- Final assistant output accumulated across model steps, Unicode-safe outbound chunking, and typing indicators.
- `/help`, `/status`, `/new`, `/workspace`, `/preset`, `/model`, `/effort`, `/compact`, `/approve`, `/reject`, and `/answer`. `/preset` is channel-local; `/model` and `/effort` also change the deployment-wide default model.
- Channel-owned approvals use the upstream approval waterfall and canonical audit id; unrelated sessions delegate to the Host UI. Questions use the Host interaction API. Web and WeChat do not present the same approval concurrently. Ask and approve requests for an active WeChat turn stay on WeChat even though DSH scopes those events to the Agent fiber.
- Channel sessions keep a `【微信】` title prefix after DSH generates a title, and the session header shows a WeChat badge. The sidebar has no public row-icon slot, so list identity is the title prefix.

## Login

Open the WeChat card under Plugins settings and select **Connect WeChat**. Scan and confirm in WeChat; the plugin saves the account and starts receiving messages automatically, without writing settings. The card presents a numeric verification field if WeChat requests one. No user ID, administrator ID, or separate start action is required. **Add account** starts another authorization flow and includes the new account in an existing account selection.

Chat is open to anyone who can send a direct message to the bot. No WeChat name, allowed-user ID, account selection or enable switch is needed. Management commands and WeChat tool approvals belong to the scanning owner, identified automatically by the iLink callback; other users' tool approvals remain with the DSH Host. Separate account/peer pairs have separate sessions. If the callback has no owner identity, reconnect instead of granting management to arbitrary users.

The card contains QR binding, add-account and refresh actions, plus a separate receiver status. “Bound” means credentials were saved; “receiver running” describes the local polling service and is not a guarantee of upstream connectivity. Keep DSH running to receive messages. Disable/unload the plugin to stop; loading it again resumes bound accounts without another QR scan. Existing `enabled`, `accountIds`, `allowedUsers` and `adminUsers` settings are retired and do not control startup or access.

Credentials, poll cursors and peer context tokens remain under `<dsh-home>/channels/wechat/accounts.json`, with owner-only permissions. They never enter the browser response or composition. Newly created default conversations use `<dsh-home>/workspaces/wechat`, separate from channel credentials. Existing sessions and explicitly selected workspaces are retained.

## Automatic defaults

New sessions use the managed “微信机器人” workspace and inherit the DSH default agent preset and model when the channel has not pinned a preset. The settings card and `/preset` write the same channel-wide `agentPreset`; leaving it unset follows the deployment default, and a pin rebuilds only the current conversation's session. See [channel default policy](../../docs/decisions/channel-default-policy.md). Defaults are a five-minute turn observation limit, 20 MiB inbound image limit, a thinking message and typing indicators. The card does not collect user IDs or expose a channel model picker: `/model` and `/effort` also change the DSH default model. Channel access does not bypass DSH tool permissions or approval policies.

## Protocol limits

Tencent iLink currently exposes direct-chat semantics to this plugin. Group behavior is not advertised. Harness prompt transport accepts text and image bytes, so voice uses Tencent's transcript when available; files and videos retain descriptive metadata instead of injecting unsupported binary prompt blocks. Outbound images are sent: each attachment is encrypted with AES-128-ECB, published to the iLink CDN through `getuploadurl`, and delivered as its own image message after the turn's text. A turn that produces only images still sends a short lead-in so the reply is never an empty bubble. Images that cannot be uploaded or sent are reported by count rather than dropped silently. Voice, file and video attachments remain text-only.

## Development

```sh
pnpm --filter @shamcleren/dsh-wechat test
pnpm --filter @shamcleren/dsh-wechat typecheck
pnpm --filter @shamcleren/dsh-wechat build
```
