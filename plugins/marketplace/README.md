# DSH Plugin Marketplace

`@shamcleren/dsh-plugin-marketplace` is an external bundle for a trusted single-source DeepSeek Harness Marketplace. It adds its own Host service and browser tab using upstream profile and UI extension points. It does not modify the DSH checkout or require private Marketplace packages in the Host.

## Install

For a new installation, use the [repository bootstrap](../../README.md) with `make init MARKETPLACE=1`. For an existing installation, add the Marketplace tarball from this same repository; see the [plugin management guide](../../docs/plugin-management.md). The default bootstrap does not add this bundle. Other plugins can be installed through **Remote Market** or directly from local tarballs/built source directories without installing or authorizing this market. The canonical source is `plugins/marketplace`; no separate GitHub checkout is required.

The tested runtime is the official DeepSeek Harness `0.1.6-alpha.2` npm distribution. Newer upstream releases require compatibility testing before updating this pin. Catalog compatibility uses the installed DSH version, not this plugin's version.

## Behavior

The Host accepts one configured Gongfeng repository and ref, validates the catalog, verifies artifact byte length and SHA-256, rejects packages outside the catalog, disables package installation scripts, serializes profile mutations, and restores the profile manifest and lockfile when a mutation fails.

Profile mutations retain the pnpm store and node linker recorded by the original installation, so launching the desktop App outside the installer's shell does not require moving dependencies or changing global pnpm settings. Update counts include newer compatible releases, never an older remote release than the locally installed version. The local catalog cache is scoped to the trusted source, running DSH version, and installed profile package versions. A runtime or plugin update automatically refetches the catalog on its next use; unchanged installations reuse the cache until Refresh catalog is selected.

The browser UI adds a separate **Git repository marketplace / Git 仓库市场** tab (`trusted-marketplace`) without replacing the upstream plugin UI or claiming the `marketplace` tab ID. The pinned official rc.8 runtime provides plugin configuration and inventory tabs by default; a marketplace such as `dshmarket` needs separate installation. Source configuration and authorization are optional: without them, DSH and other installed marketplaces remain usable, the remote tab explains this choice, and its source form opens only when requested. No remote catalog is fetched until credentials are configured.

The browser UI provides source status, a single repository URL and OAuth sign-in, catalog refresh, search, compatibility and update filters, installed and update counts, per-plugin progress, guarded uninstall, batch updates with partial-failure reporting, and a single restart prompt after a batch of changes.

The bundle inserts `trusted-marketplace`. Its `./client` export uses `settings.plugins.tab` and a loopback-only `/trusted-marketplace` RPC with validated, allowlisted operations. No private `remote.marketplace` or generated Typert descriptor is required. Configuration is stored under `trusted-marketplace`; configure the trusted source again when migrating from a private Host build. Public catalogs such as `dshmarket` remain independent plugins.

## Source connection

Enter one repository home URL. `https://gitlab.example.com/group/project` uses the bundled Gongfeng OAuth application, PKCE, and the registered loopback callback `http://127.0.0.1:3080/oauth/gongfeng/callback`. `https://github.com/owner/repo` is read as a public repository: the default branch, catalog, and artifacts come from GitHub's public content hosts, with no OAuth and no Gongfeng token. A `.git` suffix is accepted. Other hosts, file paths, and private GitHub repositories are rejected. Redirects may stay only on `api.github.com`, `raw.githubusercontent.com`, and `objects.githubusercontent.com`.

When DSH runs on another port, a temporary loopback listener owns port 3080 only during authorization, then releases it on completion, timeout, or unload. If another process owns 3080, login fails with an actionable message; it never terminates or redirects through that process.

There is no Private Token login, application-ID field, branch field, or `gongfeng` CLI dependency. Existing OAuth credentials are reused; installations previously using Private Token must authorize through OAuth. Saving another repository reuses the authorization and resolves that repository's default branch. Failed project access does not replace the previous source. Use **Authorize again** if authorization expires. If the browser blocks the popup, use **Open authorization page** while the connection is pending.

## Security

This package does not aggregate public registries and does not install arbitrary npm packages. A configured GitHub repository must be public; its catalog artifacts are still checked by size and SHA-256. Gongfeng credentials remain in the Harness credential service, are never returned to the browser, and are never sent to GitHub. Installation scripts stay disabled. A catalog entry is not a general trust assertion: the configured repository owner remains responsible for reviewing every published artifact.

## Model Experience

The plugin adds no model-facing prompt sections or tools. It changes the Host composition through human-operated settings, and installed plugins own any later model-visible behavior.

## Known Limitations and Deferred Work

- This repository owns the trusted-source implementation and its security updates; it is not an upstream built-in Marketplace package.
- Only one trusted repository is active at a time. Public catalog aggregation belongs in a separate plugin such as `dshmarket`.
- Web Host changes require a restart. The UI batches mutations and requests one restart but does not hot-load arbitrary package code.

## Verification

`pnpm check` runs Host and browser type checks, tests for catalog validation, repository responses, OAuth state and refresh behavior, command bounds, cache integrity, view filters, and RPC validation, then builds both artifacts. Integration verification installs the tarball into an isolated official Web profile and checks that the settings tab reads its installed package list. Live Gongfeng authorization and private artifact installation require an authorized account.

Invalid RPC requests return `bad-request` with structured validation issues, including an empty issue list for unknown operations; internal failures return bounded diagnostics without exposing credential values.
