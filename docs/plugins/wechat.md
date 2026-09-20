# Personal WeChat channel

Status: implemented; live iLink credential smoke pending

## Purpose

`@shamcleren/dsh-wechat` connects personal WeChat direct messages to durable DeepSeek Harness Sessions through Tencent's official iLink Bot APIs. The plugin owns transport authentication, account state, peer authorization, message normalization, callback deduplication, reply context, and channel presentation. Harness continues to own Workspaces, Sessions, agent composition, model execution, tools, approvals, and durable events.

The implementation adapts the protocol behavior of the MIT-licensed `Tencent/openclaw-weixin` project. It does not import OpenClaw runtime or its channel SDK.

## Runtime flow

1. The Plugins settings card calls the authenticated `wechatLogin` Remote namespace to create a QR flow, render it in the browser, submit optional numeric verification, and display the connected account count. The Remote result never contains tokens.
2. QR confirmation saves credentials and waits for the runtime to start before reporting success. The scanning owner is derived from iLink; missing identity fails closed. The card also selects the channel-wide agent preset described by [channel default policy](../decisions/channel-default-policy.md). Details are maintained in the [plugin README](../../plugins/wechat/README.md).
3. Each account resumes its opaque `get_updates_buf` and long-polls `ilink/bot/getupdates`.
4. The channel persists the latest `(account, peer)` context token before dispatch.
5. Text and supported image bytes become one Host `session.prompt` request with `mode: steer` for a channel-owned active turn, otherwise `mode: queue`.
6. A rejected steer retries once as queued input. Queued admission owns the new durable turn; successful steering receives `已加入当前任务。` while the existing turn keeps reply ownership.
7. The channel folds durable assistant output across every step and sends the final result through `ilink/bot/sendmessage`.

Account ids, peer ids, message ids, tokens, and cursors do not enter Session ids or logs in raw form. Stable SHA-256 identities derive Session bindings and prompt RPC ids. The owner-only account document is the only token-bearing file.

## Interaction behavior

An active WeChat turn handles its approval through the upstream approval waterfall. Approval requests are presented as text and accept `/approve` or `/reject` only from the originating peer. The upstream approval service retains its canonical audit id and permission policy. Unrelated requests delegate to the Host UI; Web and WeChat do not present the same approval concurrently.

`/preset` writes this plugin's own settings and rebuilds the current conversation. `/model` and `/effort` also change the deployment-wide default model, and their replies say so. `ask_user_question` requests render numbered questions and choices. `/answer <answer>` handles one question; batches use `/answer <number-or-id> <answer>`. Comma-separated selections support multi-select. The channel submits the original stable question ids through the Host response path without starting another model turn.

## Media behavior

Inbound images download from the iLink CDN, enforce the configured byte cap before and after AES-128-ECB decryption, detect PNG/JPEG/WebP/GIF bytes, and enter the Host's durable attachment path. Voice messages use Tencent transcription when present. File names and video presence remain visible as text because the Host prompt API does not accept arbitrary file, audio, or video blocks.

Outbound assistant text is split at Unicode boundaries to satisfy the iLink message size. iLink context tokens survive process restarts and are echoed on replies. Typing tickets are resolved per peer and cancelled after settlement.

## Failure and lifecycle behavior

- Normal long-poll timeouts retry without counting as failures.
- Three consecutive API failures enter a bounded 30-second backoff; one poison callback is retried three times before the cursor advances past it with an attributable error.
- Poll cursors advance only after every callback in the batch reaches Host admission; a partial failure replays the batch and durable prompt ids suppress already-admitted messages.
- Plugin disposal aborts long polls, waits for admitted router work, notifies iLink, stops idle-sleep assertions, and drains atomic stores.
- Unknown or malformed durable state fails startup instead of discarding credentials or silently resetting a cursor.

## Current external constraints

The Tencent iLink surface used here exposes direct chats; the plugin does not claim group support. The settings card polls browser-safe login status through the Host Remote service; closing or unloading the plugin cancels the active QR poll. Proactive delivery without a current or persisted peer context token is intentionally not exposed.

## Verification

Automated tests cover QR and verification state transitions, browser QR rendering, iLink request encoding, owner-only state restart, multi-account selection, mixed inbound normalization, account-and-peer identity isolation, durable turn projection, continuation acknowledgement, and restart-safe duplicate suppression. A live QR login and message round trip remains necessary before production rollout.
