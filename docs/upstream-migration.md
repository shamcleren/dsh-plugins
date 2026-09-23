# Upstream-only distribution

The verified runtime is the official `@deepseek-ai/dsh@0.1.5-rc.1` npm distribution. Plugin sources and release artifacts live outside the DSH repository. A clean upstream source checkout can track upstream independently; runtime upgrades require a tested plugin release because upstream pre-release APIs are not stable. The catalog pins this tested version rather than advertising compatibility with untested alpha releases.

| Capability | Owner | Upstream extension |
| --- | --- | --- |
| macOS app | `apps/macos` | Independent native distribution around the official npm runtime |
| Git repository marketplace | `plugins/marketplace` | Profile bundle, connection RPC, settings tab |
| Desktop Pet | `plugins/dsh-pet` | Profile bundle, settings card, session events, native macOS helper |
| WeChat | `plugins/wechat` | Channel bundle, queue/steer, approval waterfall, settings card |
| WeCom Bot | `plugins/wecom-aibot` | Channel bundle, queue/steer, approval waterfall, settings card |
| WeCom Tools | `plugins/wecom-tools` | Independent Skill bundle and user authorization |
| Codex Controller | `plugins/codex-controller` | Persistent Codex session mirror over the pinned app-server |

The public `dshmarket` plugin and this Git repository marketplace are separate catalog providers. A mode-template manager remains a proposal, not an additional required runtime capability.

The repository's [bootstrap workflow](../README.md) installs the official npm runtime and its local, digest-verified Marketplace artifact. On macOS it also builds the native app and configures that shell to use the same bootstrap profile. Neither the app nor the installer patches DSH source. The copied GitHub sources retain their licenses and design notes; their prior repositories are historical references, not installation dependencies.

## Channel behavior

Messages steer only a turn owned by that channel. Other messages queue. A steer rejected as `agent-busy` retries once with the same prompt identity as queued input. This is not the private Host's atomic `continue` API.

Channel-owned approvals use the upstream waterfall and canonical approval audit id. Only the originating channel user may answer; unrelated sessions delegate to the Host UI. Web and Bot do not concurrently present the same approval. Policy denial, missing presentation, cancellation, and plugin disposal cannot grant permission. The upstream audit service owns the decision record; the plugin does not extend that record with a private actor schema.


## Release verification

Run `pnpm typecheck`, `pnpm test`, and `pnpm build`; install the resulting tarballs with `--ignore-scripts` into an isolated official Web profile. Check settings navigation, plugin cards, Marketplace installed state, and browser diagnostics. Live QR login, WeCom callbacks, AIDEV resources, and private Gongfeng downloads require the corresponding authorized accounts and are not implied by keyless tests.
