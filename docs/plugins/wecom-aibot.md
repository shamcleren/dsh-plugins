# WeCom AI Bot channel

Status: in progress

## Problem

DeepSeek Harness currently has no public WeCom chat channel. Users need to converse with a Harness agent through WeCom direct messages and group chats without moving the agent loop, tools, session history, or configuration authority into a separate bot framework.

## Direction

Implement a DSH-native channel plugin and use the official `@wecom/aibot-node-sdk` for the WeCom WebSocket protocol. The plugin owns message normalization, session routing, deduplication, authorization policy, DSH turn dispatch, streamed reply projection, and lifecycle cleanup. It does not embed or depend on OpenClaw.

The official `WecomTeam/wecom-openclaw-plugin` is a behavioral reference for WeCom semantics and failure cases. Its OpenClaw `ChannelPlugin`, Gateway routing, session keys, and runtime APIs are host-specific and must not cross into this package.

Office actions are intentionally outside this Channel. The independent `@shamcleren/dsh-wecom-tools` bundle owns the `wecom-unified` Skill and its separate `wecom-cli` user authorization, so neither installation nor credential lifecycle is coupled to Bot ID/Secret configuration.

## Version 0.1 scope

- Bot WebSocket connection using `botId` and `secret`.
- Text messages in direct chats.
- Group messages that explicitly mention the bot.
- Stable conversation routing by account plus `userid` for direct chats and account plus `chatid` for groups.
- Automatic rebinding from legacy cwd-bound Sessions into the channel Workspace without deleting history.
- Durable DSH session binding so process restarts do not create a new conversation for an existing chat.
- `msgid` deduplication before a DSH turn starts.
- Incremental DSH output accumulated across model steps in one WeCom streaming reply, followed by exactly one final frame.
- Configurable userid allowlist and WeCom AI Bot group callback semantics. Both the allowlist and the administrator list match `from.userid`, which WeCom sends in plaintext only when the Bot's creator is a corp super admin and otherwise sends as the corp-scoped encrypted userid.
- Connection health, bounded reconnect behavior, and complete Cordis-effect cleanup on plugin disposal.
- Redacted diagnostics that do not log credentials or full private message content.
- A selectable default Workspace for new Bot conversations, with a managed `企业微信机器人` fallback when none is configured.
- Durable per-conversation Workspace selection: `/workspace` lists choices, `/workspace <name-or-id>` switches through a new Session, and `/workspace reset` returns to the configured default without changing an existing Session cwd.
- Administrator-only `/help`, `/status`, `/new`, `/workspace`, `/preset`, `/model`, `/effort`, and `/compact` commands.
- Channel-local agent preset, following [channel default policy](../decisions/channel-default-policy.md): `/preset` lists the roster, `/preset <id>` pins one into this plugin's own settings section, and `/preset reset` clears the pin so new Sessions inherit the deployment default. The pin rebuilds the conversation's Session because a Session keeps the preset it was composed from, and it stays outside the connection key so persisting it does not reopen the socket carrying the reply.
- `/whoami`, open to every sender, answers with the userid the Bot received, because the encrypted form appears on no WeCom console screen. Both refusals carry the same value, so a mistyped list cannot lock everyone out irrecoverably. Each sender sees only their own identity.
- Group management commands recognize the leading Bot mention without changing ordinary prompt text.
- DSH approval requests from an active WeCom turn are routed through the upstream approval waterfall to WeCom. The standalone card contains the tool, the reason within WeCom's template limits, and the unredacted command resolved from the exact `callId`, using the same Session ownership as the WeCom conversation. A click updates the resolved title and uses WeCom's `replace_text` field to replace the decisions with a gray non-clickable `操作成功` state before continuing the Host operation. `/approve` and `/reject` remain fallbacks, and unrelated sessions delegate to the Host UI.
- DSH `ask_user_question` requests from an active WeCom turn render numbered questions and options in the existing stream. Single-select questions with at most six options use native buttons, with the first option emphasized; multi-select, free-text, and larger option sets use `/answer`. The final choice replaces the buttons with the resolved state. The first valid Web or WeCom response wins.
- Approval and question waits finalize the current stream. Text answers receive a completed acknowledgement on their own callback; text and card answers both buffer the continuation and send the completed remainder as a proactive Markdown message. Neither path rewrites the pre-interaction bubble.
- An optional macOS idle-sleep assertion owned by the active Bot lifecycle.

The current implementation covers this text path through the public `ctx.sessionController` and `ctx.workspaceRegistry` services: deterministic session creation/resume, durable prompt-identity deduplication, upstream queue/steer admission, raw session-event observation, bounded WeCom stream replies, and lifecycle cleanup. Admission is serialized only through the short session-binding and Host prompt operation; messages steer only a channel-owned active turn, otherwise they queue; a rejected steer retries once as queued input. A `next-step` result closes that callback with `已加入当前任务。`, while the original callback stream continues as the main response. Approval, acknowledgement, and final frames use the SDK's ordered reliable send; replaceable text updates use its non-blocking send. The bundle always mounts and registers its settings namespace; installation is the enablement decision and the SDK stays disconnected only until both referenced credentials are available. Its `dsh.client` browser half contributes the matching settings card from the same installed package, with the tuning fields collapsed under an advanced group; Harness contains no WeCom-specific UI code. A live Bot credential smoke is still required.

## Initial package boundary

```text
plugins/wecom-aibot/
├── package.json
├── cordis.patch.yml
├── src/
│   ├── index.ts              Cordis plugin entry and owned effects
│   ├── account.ts            One configured Bot connection
│   ├── inbound.ts            WeCom frame normalization and policy
│   ├── host-api.ts            Narrow same-process Host API contract
│   ├── router.ts              Session binding, deduplication, and turn observation
│   └── reply.ts              DSH output to WeCom stream projection
└── tests/
```

Split a protocol helper into `packages/` only after another plugin has a real need for the same contract.

## Deferred

- HTTP Bot webhook mode.
- Agent encrypted-XML callback mode.
- Voice, video, and files. Outbound images ship: durable image attachments are uploaded as temporary media and sent as their own messages after the text.
- Proactive sends not associated with a conversation turn.
- Multiple Bot accounts in one plugin instance.
- Administration UI and interactive onboarding.
- A group policy beyond the callbacks WeCom delivers to the AI Bot.
- A channel-local model selection. Upstream `sessions.selectModel` installs the Session choice and then saves it as the deployment-wide default for every future Agent, and the desktop client's `/model` runs the same code; no public API sets a Session model without that save, and `agentDefaultModel` is read from the controller's own context, so an agent preset cannot shadow it either. `/model` and `/effort` therefore state that reach in their reply rather than this plugin faking an isolation it cannot enforce. Removing the coupling needs an upstream session-local selection API.

## Acceptance criteria

1. A direct WeCom text message creates or resumes the correct DSH conversation and returns the final answer.
2. Two users in the same group share the group conversation; direct conversations remain isolated by user.
3. Replaying the same `msgid` never starts a second DSH turn or emits a second reply.
4. Stream failure settles with one attributable error or final response instead of leaving an open reply indefinitely.
5. Restarting the Harness preserves chat-to-session bindings and reconnects without requiring a public callback URL.
6. Clearing either referenced credential or unloading the plugin disconnects the Bot and removes every listener and timer.
7. An approval requested by a WeCom-owned turn is shown with Allow/Reject buttons in that turn's stream, uses the upstream canonical audit record, accepts WeCom decisions only from the originating user without starting another agent turn, and replaces handled buttons with the resolved state.
8. An `ask_user_question` request preserves every stable question id, offers buttons for eligible single-select questions, accepts text fallback for multi-select and custom answers, and submits the complete answer batch without starting another agent turn.
9. A message received while a channel-owned turn is running is admitted as next-step guidance and acknowledged without waiting for the active turn to finish.
10. A new conversation uses the configured default Workspace or the managed fallback; switching one conversation creates its next Session in the selected Workspace and leaves the prior Session unchanged.

## Host integration decision

The channel's local transport adapter uses public `sessionController.create/prompt/inspect/modelCatalog/selectModel` and `workspaceRegistry` methods. Scoped `session/event` observation supplies the active turn stream, and `user-questions/request` delivers questions only to the channel that owns the active turn. This keeps model selection, preset mounting, session repair, and persistence inside DeepSeek Harness while leaving WeCom transport behavior in this repository.
