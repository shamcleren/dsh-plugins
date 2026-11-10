# `@shamcleren/dsh-wechat`

Personal WeChat channel for DeepSeek Harness, backed by Tencent's official iLink Bot protocol.

## Install

Install through **Remote Market** or from this repository's local release tarball. For source changes, build `plugins/wechat` before installing the directory. See the [plugin management guide](../../docs/plugin-management.md) for commands, updates, removal, and the `before-web-app` ordering required after local installation. Loading the plugin starts all previously bound accounts automatically. New accounts need only QR authorization.

## Capabilities

- QR-code login with local owner-only credential persistence.
- Multiple authorized accounts, all started automatically.
- Restart-safe long-poll cursors and per-peer reply context tokens.
- Direct text, image, file and video intake; voice transcription and available inline quote text are preserved. Files use Session-owned upload receipts, and image bytes follow the Host attachment path.
- Durable account-and-peer Session routing and callback deduplication. Messages steer an active channel-owned turn; otherwise they queue through the upstream Host API. A rejected steer retries once as queued input.
- Final assistant output accumulated across model steps, Unicode-safe outbound chunking, and typing indicators.
- `/help`, `/status`, `/tasks`, `/cancel`, `/new`, `/workspace`, `/preset`, `/model`, `/effort`, `/compact`, `/approve`, `/reject`, and `/answer`. `/preset` is channel-local; `/model` and `/effort` change only the current conversation through public Agent hooks.
- Channel-owned approvals use the upstream approval waterfall and canonical audit id; unrelated sessions delegate to the Host UI. Questions use the Host interaction API. Web and WeChat do not present the same approval concurrently. Ask and approve requests for an active WeChat turn stay on WeChat even though DSH scopes those events to the Agent fiber.
- Channel sessions keep a `【微信】` title prefix after DSH generates a title, and the session header shows a WeChat badge. The sidebar has no public row-icon slot, so list identity is the title prefix.
- Durable text notifications from other sessions, scheduled turns, and Host plugins, with explicit multi-account routing, shared outbound budgets, receipts, cancellation, and restart recovery.

## Remote task controls

The scanning owner can send `/tasks` to list active turns owned by this account/peer conversation, including turns in an earlier conversation after `/new`. `/cancel` requests cancellation of the current active turn; `/cancel <session-id>` selects an active turn shown by `/tasks`. Unknown or other peers' sessions are rejected. These commands use the public Session controller without starting a model turn. Cancellation admission is not completion; the final turn message remains authoritative. This initial task view shows channel-owned active turns, not every desktop task or a scheduler dashboard.

## Proactive notifications

After connecting, send the bot a WeChat message to establish a recipient and its interaction context. In any DSH conversation, ask it to notify you when a task finishes. The plugin registers these tools through the public DSH tool registry; existing tool visibility restrictions and permission gates remain authoritative:

| Tool | Purpose |
| --- | --- |
| `wechat_recipients` | List known recipients, account IDs, and interaction-window availability. Never returns credentials. |
| `wechat_notify` | Persist a text notification and return a receipt immediately. Accepts `text`, optional `accountId`, `recipientId`, and `idempotencyKey`. |
| `wechat_notification_status` | Read this session's receipt using its `id`. |
| `wechat_notification_cancel` | Cancel this session's queued notification. Already dispatched sends cannot be recalled. |

A WeChat session can notify only its own bound peer and only lists that peer. An unrelated desktop session defaults to the scanning owner when there is exactly one authorized account. **With multiple authorized accounts, select `accountId` or `recipientId` explicitly**, even when only one account has received a message. `accountId` alone selects that account's owner; `recipientId` selects an exact previously contacted account/peer pair. Unknown recipients, old unbound WeChat sessions, expired interaction contexts, and ambiguous defaults are rejected. There is no broadcast or first-user fallback.

`wechat_notify` accepts nonempty text up to 16,000 UTF-16 code units and splits it into Unicode-safe chunks of at most 4,000 units. Its initial `queued` receipt acknowledges durable admission. `sent` means iLink accepted every chunk, not that the phone displayed or read it. Other terminal statuses are `failed`, `uncertain`, and `cancelled`; receipts include `sentChunks`, `totalChunks`, `code`, and expiry. An `uncertain` result requires checking the actual conversation before sending a new notification.

The outbox conservatively allows one proactive chunk per ten seconds across all accounts. Replies and notifications serialize per account/peer and share a ten-message interaction budget; proactive sends stop at eight to reserve two reply slots. A new, nonduplicate inbound message refreshes the budget and the estimated 24-hour interaction window. These are conservative client limits based on community iLink behavior, not a guarantee of server acceptance. Server context/limit refusals pause that peer's notifications until another inbound message; the plugin never deletes a context token to try to bypass the refusal.

HTTP 429 responses retry after `Retry-After` (numeric seconds, at most one hour; otherwise one minute). Network errors, timeouts, malformed success responses, HTTP 5xx, and interrupted in-flight sends become `uncertain` and are **not automatically replayed**. Definite other refusals become `failed`. Accepted chunks are checkpointed individually, so a restart resumes only unsent chunks; a crash between dispatch and checkpoint is recorded as uncertain. Every notification expires 24 hours after admission. The queue accepts at most 100 pending notifications, retains at most 300 receipts, and removes terminal history older than seven days during admission. Reuse a stable `idempotencyKey` for retries of the same occurrence; changing its text or destination is rejected while the receipt is retained. A different scheduled occurrence needs a different key.

Subagents and forked conversations inherit the source session's notification boundary. If their parent lineage cannot be resolved through the public Session store, the tool refuses the call instead of treating it as an unrelated desktop session.

### Scheduled tasks and other plugins

Official DSH scheduled reminders reenter their original Session. If that Session's preset exposes the tools, its scheduled turn can call `wechat_notify` with the chosen destination. Include the account/recipient and the schedule occurrence in the reminder instructions; do not poll status continuously. This plugin provides delivery, while DSH owns scheduling and model execution.

Host plugins can use the public `wechatPush` Cordis service without invoking a model. Declare the service type through this package's public `./push` export and inject `wechatPush` into the plugin that owns the scheduled job:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@shamcleren/dsh-wechat/push'

// Called by the scheduler's owned job; occurrenceId must identify this run.
async function notifyJobResult(ctx: Context, occurrenceId: string, text: string) {
  return ctx.wechatPush.notify({
    accountId: 'account-id-from-wechatPush.recipients()',
    text,
    idempotencyKey: `my-scheduler:${occurrenceId}`,
  })
}
```

The service also exposes `recipients()`, `status(id)`, and `cancel(id)`. It is a trusted Host-local API, with no public sending HTTP endpoint. Model calls retain session isolation; Host plugins own authorization for their scheduled sends. Queue admission transfers ownership to the durable outbox, so cancelling the originating turn after admission does not cancel its notification; use the cancel tool/service explicitly. Disabling the plugin stops admission, cancels and joins in-flight work, and leaves queued jobs for the next load. Account credential changes fail previously queued work instead of redirecting it to a new identity.

`<dsh-home>/channels/wechat/outbox.json` stores recipient identities, pending message text, budget counters, and receipts with owner-only permissions; it contains no bot or context tokens. Existing account files are retained, but an account needs a fresh incoming message after upgrading before it appears as a proactive recipient. Corrupt or unwritable outbox state stops delivery instead of discarding state or pretending a message was sent.

## Login

Open the WeChat card under Plugins settings and select **Connect WeChat**. Scan and confirm in WeChat; the plugin saves the account and starts receiving messages automatically, without writing settings. The card presents a numeric verification field if WeChat requests one. No user ID, administrator ID, or separate start action is required. **Add account** starts another authorization flow and includes the new account in an existing account selection.

Chat is open to anyone who can send a direct message to the bot. No WeChat name, allowed-user ID, account selection or enable switch is needed. Management commands and WeChat tool approvals belong to the scanning owner, identified automatically by the iLink callback; other users' tool approvals remain with the DSH Host. Separate account/peer pairs have separate sessions. If the callback has no owner identity, reconnect instead of granting management to arbitrary users.

The card contains QR binding, add-account and refresh actions, plus a separate receiver status. “Bound” means credentials were saved; “receiver running” describes the local polling service and is not a guarantee of upstream connectivity. Keep DSH running to receive messages. Disable/unload the plugin to stop; loading it again resumes bound accounts without another QR scan. Existing `enabled`, `accountIds`, `allowedUsers` and `adminUsers` settings are retired and do not control startup or access.

Credentials, poll cursors and peer context tokens remain under `<dsh-home>/channels/wechat/accounts.json`, with owner-only permissions. They never enter the browser response or composition. Newly created default conversations use `<dsh-home>/workspaces/wechat`, separate from channel credentials. Existing sessions and explicitly selected workspaces are retained.

## Automatic defaults

New sessions use the managed “微信机器人” workspace and inherit the DSH default agent preset and model when the channel has not pinned a preset. The settings card and `/preset` write the same channel-wide `agentPreset`; leaving it unset follows the deployment default, and a pin rebuilds only the current conversation's session. See [channel default policy](../../docs/decisions/channel-default-policy.md). Defaults are a five-minute turn observation limit, 20 MiB inbound image limit, a thinking message and typing indicators. The card does not collect user IDs or expose a channel model picker: `/model` and `/effort` change only the current conversation. Channel access does not bypass DSH tool permissions or approval policies.

## Protocol limits

Tencent iLink currently exposes direct-chat semantics to this plugin. Group behavior is not advertised. Harness prompt transport accepts text and image bytes, so voice uses Tencent's transcript when available; files and videos retain descriptive metadata instead of injecting unsupported binary prompt blocks. Outbound images are sent: each attachment is encrypted with AES-128-ECB, published to the iLink CDN through `getuploadurl`, and delivered as its own image message after the turn's text. A turn that produces only images still sends a short lead-in so the reply is never an empty bubble. Images that cannot be uploaded or sent are reported by count rather than dropped silently. Explicit file attachments and `present` tool deliveries are uploaded and sent as file or video messages after the text. Prose links do not trigger file reads; the public workspace filesystem enforces its normal read policy. Failed deliveries are reported by count. Voice output is not synthesized.

## Development

```sh
pnpm --filter @shamcleren/dsh-wechat test
pnpm --filter @shamcleren/dsh-wechat typecheck
pnpm --filter @shamcleren/dsh-wechat build
```

The configuration card is available under **Plugins → this installed bundle** in the catalog-pinned DSH runtime.
