# DSH macOS App

Independent AppKit and WKWebView shell for the official DeepSeek Harness npm distribution. The application has its own release version and a frozen runtime dependency lockfile. Building does not read or modify a DeepSeek Harness source checkout.

The default [repository bootstrap](../../README.md) (`make init`, which also handles missing Node.js/npm) builds this app on macOS after installing clean official DSH. `make init MARKETPLACE=1` optionally adds the remote Marketplace alongside the native plugin UI and any separately installed marketplaces; configuring its source is optional. It checks Xcode Command Line Tools, reuses the installed official runtime, and stores `DeepSeek Harness.app` directly under the installation root (by default, the repository's `dist/`). `DSHInstallationRoot` in its Info.plist identifies the installed runtime and auxiliary paths; `DSHHome` pins the same configuration root used by the Web launcher, defaulting to `~/.dsh`.

For a standalone shell build, run `pnpm build:macos` at the repository root. It uses the shared `runtime/` lock and produces `apps/macos/dist/DeepSeek Harness.app`. Node archives are pinned by SHA-256; the final application is signed locally unless `CODESIGN_IDENTITY` selects a distribution identity.

The runtime uses the official rc.8 package as the first migration baseline. Upgrading DSH requires updating the runtime lockfile and verifying every installed plugin against that official version. New installations reuse credentials and plugin data from `~/.dsh`. Existing installed apps keep their originally configured data directory.

Optionally install the trusted Marketplace, WeChat, WeCom Bot, WeCom Tools, Codex Controller and AIDEV as separate profile bundles. The native application provides window/menu behavior, Host startup/restart, and an origin-restricted browser bridge for OAuth handoff. macOS signing and notarization are distribution responsibilities of this repository.

`pnpm test:macos` at the repository root validates the official runtime lock, compiles the native launcher, and executes its shared-profile path selection. The bootstrap tests and a fresh installation verify the actual official package installation. No live channel is enabled and no model prompt is sent.

To verify CLI restart from inside a Host against a built application, run `dist/node/bin/node apps/macos/scripts/restart-smoke.mjs "dist/DeepSeek Harness.app" dist/bin/dhp` from the repository root. This opens a temporary App with a unique bundle identifier, isolated profile and port, and the shipped official runtime. A fixture plugin invokes the real CLI through the official subprocess service twice; the test checks that the native App survives, each old Host exits, a new Host serves the authenticated Web page, and the source installation remains running. The temporary App and profile are removed afterward. See [restart behavior](../../docs/plugin-management.md#重启与配置生效) for the command's scope and active-turn boundary.

Append `--recovery` to exercise internal Bash SIGTERM, abrupt SIGKILL, repeated-exit limits, explicit restart and stop, startup failure, installation update locks, and foreign port ownership. It also checks the lifecycle section in the official assembled model prompt. These tests use isolated resources and do not call a model or use account credentials.

Version 0.2.12 ships `Contents/MacOS/DeepSeekHarnessControl` for explicit Host restart. It sends a native notification scoped to this App's canonical path; Dock activation still only restores the window and ensures the Host is running. Managed installations use `dhp restart`; the bundled lifecycle policy uses the control executable directly for standalone Apps. Rebuild or update the App to install this entry point.

Version 0.2.10 forwards the click that activates an inactive window to the page through AppKit's public `acceptsFirstMouse(for:)` hook. Workspace, mode and other controls can respond to that first click. The native regression test checks the WebView attached to the real window using an ephemeral website data store. Existing installations receive this shell change with `dhp update` after closing the App.

New standalone builds and bootstrap installations default to `~/.dsh`, including `~/.dsh/settings.yaml`. They reuse this directory directly without copying or resetting it. The signed app and executable launcher pin the selected configuration root. Bootstrap schema-v1 installations retain their private profile when updated; they are not silently migrated. Do not run multiple DSH instances simultaneously against the same profile, even with different ports. Gongfeng authorization uses OAuth only and does not require a bundled CLI. The registered OAuth callback uses port 3080 temporarily; the App service can use another port. An occupied port is reported without terminating another installation. No existing application under `/Applications` is replaced.

Managed app builds derive a distinct bundle identifier from the installation directory, isolating macOS preferences and WebKit storage between installations; DSH configuration and profile data are still shared through `~/.dsh`. Launching an app does not terminate other application instances. New app builds default to port 3080; changing the port does not isolate the shared profile. To select a different free port at build time, use e.g. `DSH_APP_PORT=3082 make init DIR=/absolute/path/dsh-clean`. The value is validated and saved in the signed app's `DSHServicePort`; the default is 3080. Preserve this environment variable when resuming a failed build. The native bridge accepts messages only from the current Host origin, including its configured port. Web CLI launches select their port separately with `web --port 3080`.

The app filename is always `DeepSeek Harness.app`; the version is stored in Info.plist. Builds use private staging directories and an exclusive `.app-build.lock`, publishing only after compilation, signature verification and plist validation succeed. Standalone builds refuse an existing output; move that output aside before rebuilding. Managed `dhp update` detects changed runtime/build inputs and stages a replacement, retaining the old files for rollback until verification succeeds. `dhp update --rebuild` forces this rebuild. Close this installation's App/Web first. Configuration, profile plugins and the recorded desktop port are preserved; `DSH_APP_PORT` explicitly overrides the port. Launchers refuse to start while installation/update markers are present.

Version 0.2.6 supports report downloads through WebKit's public navigation/download delegates. HTML and JSON Blob downloads from the current Host origin open the system Save panel. Downloads stage in an owned temporary file beside the chosen destination, publish only on success, preserve files changed while downloading, and cancel when the window closes. Foreign origins and download redirects outside the Host origin are refused. Files are saved without automatically opening or executing them. Existing desktop installations receive this shell update with `dhp update` after closing the App.

## Link navigation

The main window stays on the current Host origin (including its port). External HTTP/HTTPS links open in the default browser, including ordinary links, links targeting a new window, script navigation and page redirects. Same-origin pages remain in the app. Non-web schemes and URLs containing credentials cannot replace the main page. Existing origin-restricted downloads continue to use the Save panel.

The native navigation regression test uses a real WKWebView, an ephemeral website data store and an isolated local HTTP server. Browser handoffs are captured without opening real websites. Receive this shell fix through `dhp update` after closing the installed App; editing the repository does not update a running installation.

## Text input

The macOS shell disables WebKit writing suggestions, automatic capitalization, spelling correction and text replacement for prompt editors. The preferences are injected at document start through a public `WKUserScript`, apply to dynamically focused text fields and editable regions in every frame, and do not modify the official DSH frontend package. The native regression test loads a real WKWebView and verifies both the document defaults and focused editor overrides.

## Sharing from WeChat

Version **0.2.11** can embed a sandboxed **Send to DSH / 发送到 DSH** Share Extension. This is an opt-in signed build: the existing ad-hoc build remains available without sharing. The extension and shell use an installation-specific App Group; the team-prefixed identifier is supported on macOS without a provisioning profile. Use a signing certificate owned by the specified team:

```sh
CODESIGN_IDENTITY='Developer ID Application: Your Name (TEAMID1234)' \
DSH_SHARE_TEAM_ID=TEAMID1234 dhp update --rebuild
dhp plugin install desktop-share
```

Close the installed App before updating. The installer records the sharing team and signing identity for subsequent updates. A missing or mismatched certificate fails the staged build and preserves the existing installation. No signing keys or credentials are stored in the repository. Standalone builds accept the same environment variables with `pnpm build:macos`.

Enable the new extension in macOS Sharing extensions, then choose it from WeChat's **转发到其他应用 → 选择电脑中的应用** menu. WeChat keeps 企业微信 and 元宝 on the first-level partner row; third-party Share Extensions are listed in that nested system picker. The shell opens after receiving the files; choose a workspace/conversation and click **加入当前草稿**. The [Desktop Share plugin](../../plugins/desktop-share/README.md) documents limits, retained files, archive handling and recovery. If macOS refuses automatic App activation, open DSH manually to pick up the saved batch. This integration only uses the independent shell and public DSH plugin interfaces; the official source checkout and runtime modules are unchanged.
