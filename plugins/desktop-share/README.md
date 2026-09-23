# Desktop Share

`@shamcleren/dsh-desktop-share` imports macOS shared files into an existing DSH conversation draft. It requires the independently maintained DSH macOS shell **0.2.11+**, built with its Share Extension enabled, and the tested official runtime **0.1.6-alpha.2**.

## Use

1. Build/update the shell with a Developer ID signing identity and its team ID, following [the macOS instructions](../../apps/macos/README.md#sharing-from-wechat).
2. Run `dhp plugin install desktop-share`, then restart the App.
3. Enable **Send to DSH / 发送到 DSH** in macOS System Settings → General → Login Items & Extensions → Extensions → By Category → Sharing (labels vary by macOS version).
4. In WeChat 4.1.13+, select messages and choose **转发到其他应用 → 选择电脑中的应用 → 发送到 DSH**. WeChat's first-level row (企业微信, 元宝) is a Tencent partner list; Apple Share Extensions, including this one, only appear in the nested system picker.
5. Shared files appear in a small global box at the top right of the DSH window (portaled out of `shell.overlay` so it is not trapped under the traffic lights). Open the desired conversation from DSH's usual sidebar, then click the filename / **加入当前对话** once. No second session picker is required; no model prompt is submitted.
6. The **×** beside a pending share removes it from the inbox. After adding, the same compact box shows the current conversation's draft attachments and upload status; **×** removes an attachment and cancels its upload. Click the heading to collapse the box. It disappears when no pending share, current draft attachment or error remains.

Version **0.1.3** keeps that compact box but mounts it on `document.body` at the top right. Version **0.1.2** replaced the input dock and extra conversation picker with one global compact box. The target is resolved when you click; switching conversations while file bytes are being read cancels that import and leaves the share pending. Existing signed shell 0.2.11 installations only need `dhp plugin install desktop-share` after closing the App, followed by a restart; no shell rebuild or signing changes are required.

WeChat's merged chat export is received as its original ZIP. This version does not expand archives or render chat-history cards. The selected agent needs file/archive-reading capability to analyze its contents. Directly shared PNG/JPEG/GIF/WebP files become image attachments; other files use DSH's generic file upload path. Each share accepts up to 20 regular files and 50 MiB total; the Host's own upload limits still apply.

## Data and recovery

Files are copied into this installation's signed App Group, under `ShareInbox/Ready/<batch-id>/`. **打开已保存文件** opens the inbox. An imported or dismissed batch moves to `Imported/`, retaining its original bytes and a manifest mapping storage IDs to filenames. This version does not automatically delete originals. If an unsent draft is lost after a page reload, the retained files can be uploaded again using DSH's attachment picker (use the manifest's original filename when making a copy).

Sharing saves files locally. **加入当前对话** may upload the file to the shell's local DSH Host, but never submits a model prompt. The extension has no network entitlement. The page bridge accepts only the shell's current loopback Host origin and main frame, and exposes batch/file IDs rather than arbitrary paths. A browser without the native bridge remains unaffected.

The implementation uses Apple's `com.apple.share-services`, `NSExtensionContext` and `NSItemProvider`, plus DSH's exported `ConversationController.createDrafts` / `releaseDraftAttachments` and `InputActions.addAttachments`. The current destination comes from `ctx.sessions.list`, with its composer resolved through the public session scope; removal uses `conversation.input.for(scope).removeAttachment` and releases bytes only after the input accepts removal. It does not modify official DSH source or installed modules.

Reference: [Apple Share Extension guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html), [Dukou's WeChat handoff design](https://github.com/qzz0518/Dukou). The code here is independently implemented; no Dukou source is bundled.

## Validation

`npm run typecheck`, `npm test`, `npm run build`. Native inbox, bridge and signing tests live under `apps/macos/tests/`. Real WeChat acceptance requires enabling the built extension in macOS and forwarding a sample; unit tests do not replace that check.
