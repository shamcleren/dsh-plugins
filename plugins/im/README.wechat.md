# WeChat adapter in `@shamcleren/dsh-im`

Personal WeChat channel for DeepSeek Harness, backed by Tencent's official iLink Bot protocol.

## Install

Install the unified `im` release and open **IM workbench → WeChat**. The reception switch connects bound accounts or pauses this platform without removing its configuration. Scanning a new account also enables reception. See the [IM guide](README.md) for installation and legacy migration, and the [plugin management guide](../../docs/plugin-management.md) for development commands. The source package is `plugins/im`.

## Capabilities

- QR-code login with local owner-only credential persistence.
- Multiple authorized accounts, all started automatically.
- Restart-safe long-poll cursors and per-peer reply context tokens.
- Direct text, image, file and video intake; voice transcription and available inline quote text are preserved. Files use Session-owned upload receipts, and image bytes follow the Host attachment path.
- Durable account-and-peer Session routing and callback deduplication. Messages steer an active channel-owned turn; otherwise they queue through the upstream Host API. A rejected steer retries once as queued input.
- Replies follow the public Host Session journal, backfilling the opening history to the admitted prompt before consuming live events. Completed replies remain recoverable when their initial channel event notifications were missed. Observation failure or timeout sends a notice directing the peer to the DSH conversation; unloading cancels and joins the journal follower.
- iLink may acknowledge a send with only `message_id`, omitting zero-valued status fields. Such receipts are accepted; explicit nonzero errors still fail, and unconfirmed or malformed receipts remain uncertain.
- Final assistant output accumulated across model steps, Unicode-safe outbound chunking, and typing indicators. Processing sends no thinking-message bubble: the indicator refreshes every five seconds while a reply is pending and stops after delivery, failure, admission timeout or unload. Once a prompt is associated with an executing turn, observation continues until the journal reports its completion, including long tools and approval waits. Concurrent turns for the same peer share one indicator; retiring requests are cancelled and joined before the terminal cancel. Indicator errors do not prevent the final reply.
- Ordinary assistant replies adapt common Markdown blocks for narrow chats: headings become `【标题】`, lists use native Markdown markers/nesting and task marks, and each table row becomes one compact list item with labeled values separated by semicolons. Section labels join their first prose line, ordinary paragraphs remain separate, and redundant blanks around/between list items are removed without flattening literal code; no hard-break padding or fullwidth indentation is injected. Inline Markdown, links and code remain literal; fenced and indented code are excluded from block conversion. Original Session text stays unchanged. Outbound text prefers paragraph/line boundaries and keeps a fenced block together when it fits within the 4,000 UTF-16-unit message budget; larger code blocks or unbroken lines still split without dropping characters or splitting surrogate pairs. Unsupported syntax remains text rather than being rendered to HTML.
- WeChat controls the visible typing header. Switching chats can leave a brief display gap until a later refresh; the header is not the authoritative task status. `/tasks` and the `/session` running mark report execution independently of that display.
- `/help`, `/status`, `/tasks`, `/cancel`, `/new`, `/session`, `/workspace`, `/preset`, `/model`, `/effort`, `/compact`, `/approve`, `/reject`, and `/answer`. `/preset` is channel-local; `/model` and `/effort` change only the current conversation through public Agent hooks.
- Channel-owned approvals use the upstream approval waterfall and canonical audit id; unrelated sessions delegate to the Host UI. Questions use the Host interaction API. Web and WeChat do not present the same approval concurrently. Ask and approve requests for an active WeChat turn stay on WeChat even though DSH scopes those events to the Agent fiber.
- Channel sessions keep a `【微信】` title prefix after DSH generates a title, and the session header shows a WeChat badge. The sidebar has no public row-icon slot, so list identity is the title prefix.
- Durable text notifications from other sessions, scheduled turns, and Host plugins, with explicit multi-account routing, shared outbound budgets, receipts, cancellation, and restart recovery.

## Remote task controls

The scanning owner can send `/session` to list this account/peer's remembered sessions with their current DSH titles, stable selection numbers, current-session marks and running status. Each entry is a native Markdown list item, for example `- [1] Fix login（当前） · 工作区：Project Alpha`; the title and workspace stay together without relying on a soft line break. Ungrouped sessions show `工作区：未分组`. Bracketed numbers avoid Markdown list renumbering. The redundant `【微信】` prefix is hidden only in these replies, leaving canonical DSH titles intact. Titles and workspace labels normalize whitespace, keep whole Unicode code points and show an ellipsis when shortened. Workspace renames appear on the next request, and switch confirmations carry the same label. `/session 1` or `/session <session-id>` switches subsequent input to a listed session without creating a model turn or cancelling another task. `/new` creates and selects a new session while retaining the previous one; workspace and preset changes retain their prior sessions too. `/session list 2` opens the next page of up to 20 rows; a navigation hint appears only when needed. Numbers keep their creation order even as titles and activity change. Untitled sessions are labelled as new; archived or deleted sessions cannot be selected.

`/help` groups commands by conversations/workspaces, tasks/interactions, model/preset settings and help. Every command is a list item, so clients that fold ordinary single newlines keep the commands separate. Session entries and workspace choices also use native lists, avoiding Unicode bullets/spacing that PC WeChat folds into a paragraph. `/workspace` shows the current/default workspace and short names; full IDs appear only when labels would be ambiguous. Current/default status and navigation share a compact summary before each list, avoiding separate title/footer paragraphs. Name/ID selection and `reset` keep their existing meanings. Base font size and line height are controlled by the WeChat client.

Active bindings and selection order persist together in the owner-only `bindings.json`. Existing v1 files load their current binding as the first history item; older sessions that were never recorded as belonging to that peer are not inferred from a shared workspace. Titles remain canonical Host metadata, so automatic titles and desktop renames appear on the next list request. Other peers' sessions are never listed or selectable.

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

Host plugins can use the public `wechatPush` Cordis service without invoking a model. Declare the service type through this package's public `./wechat/push` export and inject `wechatPush` into the plugin that owns the scheduled job:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@shamcleren/dsh-im/wechat/push'

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

New sessions use the managed “微信机器人” workspace and inherit the DSH default agent preset and model when the channel has not pinned a preset. The settings card and `/preset` write the same channel-wide `agentPreset`; leaving it unset follows the deployment default, and a pin rebuilds only the current conversation's session. See [channel default policy](../../docs/decisions/channel-default-policy.md). Defaults are a five-minute deadline for a prompt to start executing (`turnTimeoutMs`), 20 MiB inbound image limit, and typing indicators. Running turns retain typing and reply observation through completion rather than expiring at that deadline. Legacy `thinkingText` values are accepted for configuration compatibility and no longer sent; `sendTyping: false` makes processing silent until the reply. The card does not collect user IDs or expose a channel model picker: `/model` and `/effort` change only the current conversation. Channel access does not bypass DSH tool permissions or approval policies.

## Protocol limits

Tencent iLink currently exposes direct-chat semantics to this plugin. Group behavior is not advertised. Harness prompt transport accepts text and image bytes, so voice uses Tencent's transcript when available; files and videos retain descriptive metadata instead of injecting unsupported binary prompt blocks. Outbound images are sent: each attachment is encrypted with AES-128-ECB, published to the iLink CDN through `getuploadurl`, and delivered as its own image message after the turn's text. A turn that produces only images still sends a short lead-in so the reply is never an empty bubble. Images that cannot be uploaded or sent are reported by count rather than dropped silently. Explicit file attachments and `present` tool deliveries are uploaded after the text; raster image signatures select native image messages, while other files retain file or video messages. Prose links do not trigger file reads; the public workspace filesystem enforces its normal read policy. Failed deliveries are reported by count. Voice output is not synthesized.

## Development

```sh
pnpm --filter @shamcleren/dsh-wechat test
pnpm --filter @shamcleren/dsh-wechat typecheck
pnpm --filter @shamcleren/dsh-wechat build
```

The configuration card is available under **Plugins → this installed bundle** in the catalog-pinned DSH runtime.

### Presented images and delivery diagnostics

`present` raster images (JPEG, PNG, GIF, WebP signatures) are delivered as native image messages, not generic file cards. Non-image files and videos retain their existing routes. A file extension alone does not select the image route.

Media failures log an allowlisted stage (`read`, `upload`, `send`) and category, without paths, credentials, signed CDN URLs or response bodies. Successful API acceptance is not proof that the recipient rendered the image; real-client display still requires confirmation.
