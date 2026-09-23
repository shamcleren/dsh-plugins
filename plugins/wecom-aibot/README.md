# `@shamcleren/dsh-wecom-aibot`

WeCom AI Bot channel package for DeepSeek Harness.

## Install

Install through **Remote Market** or from this repository's local release tarball. For source changes, build `plugins/wecom-aibot` before installing the directory. See the [plugin management guide](../../docs/plugin-management.md) for commands, updates, removal, and the `before-web-app` ordering required after local installation. Installation does not configure Bot credentials or complete account authorization.

## Current milestone

The package connects the official WeCom AI Bot WebSocket SDK to the same-process DeepSeek Harness Host API. It accepts text callbacks, creates or resumes a deterministic durable session for each direct or group conversation, suppresses a previously admitted `msgid`, and submits messages through upstream `queue` and `steer` admission. A channel-owned active turn receives steering and an immediate acknowledgement. Other messages queue; a steer rejected as `agent-busy` retries once as queued input. The original WeCom stream remains the main output and accumulates assistant text across model steps.

The bundle row always mounts so the plugin remains visible and configurable. Installing the package is the enablement decision: the SDK connects as soon as both credential references resolve and disconnects when either one is cleared. The same package exports a dynamic `./client` bundle that contributes its card to the generic Plugins settings section, so `dsh plugin --profile web add <package>` installs the Host channel and its UI together without modifying or rebuilding DeepSeek Harness. Environment variables remain a fallback for headless deployments. The implementation has automated Host/SDK boundary coverage; a live Bot credential smoke remains before a production rollout. See the repository-level [design document](../../docs/plugins/wecom-aibot.md).

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `botIdEnv` | `WECOM_BOT_ID` | Credential reference containing the WeCom Bot ID. |
| `secretEnv` | `WECOM_BOT_SECRET` | Credential reference containing the WeCom Bot secret. |
| `allowedUsers` | `[]` | WeCom userids allowed to send messages. An empty list accepts every user visible to the Bot. |
| `adminUsers` | `[]` | WeCom userids allowed to run `/help`, `/status`, `/new`, `/workspace`, `/preset`, `/model`, `/effort`, and `/compact`. `/whoami` is open to everyone. |
| `workspaceId` | omitted | Existing Harness Workspace used by new conversations. The settings card lists the current Workspace registry. |
| `workspaceName` | `企业微信机器人` | Title of the managed fallback Workspace created when `workspaceId` is omitted. |
| `preventIdleSleep` | `false` | On macOS, run a managed idle-sleep assertion while the Bot is active. |
| `agentPreset` | omitted | Harness agent preset used when a new WeCom session is created. Omitted inherits the deployment default. |
| `thinkingText` | `正在思考…` | Initial content of the WeCom stream while the Harness turn starts. |
| `turnTimeoutMs` | `300000` | Maximum observation time for one admitted Harness turn. |

The reference fields are names, not credential literals. The plugin resolves the Host credentials service first and then the process environment. Installing the plugin without both values keeps it disconnected and emits one warning per unconfigured streak; writing either referenced credential or changing settings reconciles the connection without remounting the plugin.

The settings card shows Bot ID, Secret, the two userid lists, and the default Workspace directly, and keeps `preventIdleSleep`, `agentPreset`, `thinkingText`, and `turnTimeoutMs` under a collapsed **Advanced settings** group. `botIdEnv`, `secretEnv`, and `workspaceName` stay configuration-file only.

The UI stores Bot ID and Secret through the Host credentials API, never in the settings document or a browser response. A save that does not land names the fields the deployment refused, and a credential write reports the deployment's own refusal text — or, when the write was accepted while the reference still reads unconfigured, says exactly that. Refusal text is diagnostic only and never carries the value back. Ordinary settings and credentials remain under the Harness home and survive application restarts.

Both lists match `from.userid` exactly and case-sensitively, and that value is not always the account name the WeCom console displays: [WeCom sends a plaintext userid only when the Bot's creator is a corp super admin](https://developer.work.weixin.qq.com/document/path/100719), and otherwise sends the corp-scoped encrypted userid. Because no console screen shows that encrypted value, `/whoami` answers every sender with the identity the Bot received, and both refusals — the allowlist rejection and the administrator-only command rejection — carry it too. A sender only ever learns their own identity this way.

Conversation and prompt identities are SHA-256-derived from the Bot and WeCom identifiers. Raw userids and chatids do not appear in Harness session ids. Deduplication reads the Host's durable `rpcId` admission receipt, so replaying a callback after restart does not enqueue another turn.

When a deterministic conversation id already belongs to a pre-Workspace release with another cwd, the plugin creates a new channel-Workspace Session, persists that active binding, and retains the legacy Session unchanged.

The plugin persists only the hashed conversation key and current opaque Session id under the Harness home. The Session's Workspace account preserves each conversation's selection across restarts. `/workspace` reports the current and default Workspaces; `/workspace <name-or-id>` creates a Session in the selected Workspace and switches the conversation only after creation succeeds, while `/workspace reset` returns it to the configured default. Duplicate display names require the stable Workspace id. `/new` creates the replacement Session in the conversation's current Workspace. Prior Sessions remain available in the App. Management commands are an explicit allowlist and never expand when Harness adds another command.

`/preset` follows the [channel default policy](../../docs/decisions/channel-default-policy.md) and is channel-local. The settings card selects the same value from the deployment preset roster; the first option follows the deployment default, and a roster that cannot be read does not fall back to a free-text preset. It reports the roster and the preset the channel currently names, `/preset <id>` pins one, and `/preset reset` clears the pin so new Sessions inherit the deployment default again. A pin is written to this plugin's own settings section through path ops, so it survives restarts and never touches a deployment-wide default; an unknown or broken preset is refused before anything is written, and a refused write is reported rather than reported as applied. Because a Session names its preset at creation and keeps it for life, the switch rebuilds the conversation's Session and leaves the prior one intact. The preset is deliberately outside the connection key so persisting it does not reopen the socket carrying the command's own reply. A deployment that mounts no preset registry still accepts `/preset <id>`; only the roster listing is unavailable.

`/model` and `/effort`, unlike `/preset`, are **not** channel-local: `sessions.selectModel` installs the Session selection and then saves it as the deployment-wide default for every future Agent, and the desktop client's own `/model` runs that same code. Harness exposes no public API that sets a Session model without that save, so both commands state the reach in their reply instead of implying an isolation this plugin cannot provide. A conversation that has already taken a turn keeps the model recorded in its last request header, so a changed default only reaches it through `/new`.

When an active WeCom turn requests approval, the plugin intercepts its channel-owned request through the upstream approval waterfall and sends an Allow/Reject template card as a standalone message alongside the existing reply stream. The card presents the tool, the approval reason within WeCom's template limits, and the command recovered from the request's exact `callId`; command visibility follows the same Session ownership as the surrounding WeCom conversation and is not additionally redacted. Clicking a button first updates the title to `已允许` or `已拒绝` and uses WeCom's `replace_text` field to replace the decisions with a gray non-clickable `操作成功` state, then resumes or rejects the Host operation. `/approve` and `/reject` remain text fallbacks. Web and WeCom do not present the same approval concurrently. Unrelated requests delegate to the Host UI. Only the user who started the WeCom turn can decide; the upstream approval service owns the canonical audit record. Approval prompts, resolution notices, continuation acknowledgements, and final replies use the SDK's ordered reliable path; high-frequency text updates use its best-effort non-blocking path. Ask and approve requests for an active WeCom turn stay on WeCom even though DSH scopes those events to the Agent fiber.

Channel sessions keep a `【企业微信】` title prefix after DSH generates a title, and the session header shows a WeCom badge. The sidebar has no public row-icon slot, so list identity is the title prefix.

An interaction ends the current stream before waiting for the human. A text `/approve`, `/reject`, or final `/answer` receives a completed acknowledgement on that reply callback. After either a text answer or template-card click, the plugin buffers the remaining turn and sends its final text as a new proactive Markdown message. Earlier assistant text remains in the earlier bubble instead of being copied or reordered around the user's decision.

`ask_user_question` requests from an active WeCom turn are shown in the same stream with numbered questions, choices, descriptions, supporting detail, and multi-select guidance. A single-select question with one to six options also gets native buttons; the first option is primary and the remaining options are secondary. Consecutive eligible questions reuse and update the same card, and the final choice replaces its buttons with a resolved notice. Multi-select, free-text, and larger option sets retain the text flow. For one question, reply `/answer <choice number, label, or custom text>`. For a batch, reply to each item with `/answer <question number or id> <answer>`; comma-separated values select multiple choices. Answers retain the caller's stable question ids and are submitted as one Host response after the batch is complete. Web and WeCom share the Host request, so the first valid response wins.

## Known limitations

- User messages are limited to text; template-card click events are handled. Images, voice, files, video, mixed messages, and proactive sends are deferred.
- A turn's durable images are uploaded as WeCom temporary media and pushed as their own messages after the text reply. Whatever the deployment cannot upload or send is named in one notice rather than dropped silently. Voice, video, and files are still text-only.
- Group management commands accept the callback's leading Bot mention, such as `@dsh /help`; non-command text remains unchanged when sent to the Harness.
- Unloading the plugin stops its listeners, timers, and reply observation. A turn already admitted through the Host API remains Host-owned and may finish without sending another WeCom frame.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

The configuration card is available under **Plugins → this installed bundle** in DSH 0.1.6.
