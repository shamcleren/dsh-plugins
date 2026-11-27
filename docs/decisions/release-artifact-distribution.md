# Release artifact distribution via GitHub Releases

## Context

Committing packed `.tgz` plugin tarballs directly into Git under `artifacts/` keeps offline checkout installation simple, but causes rapid repository growth: binary archives do not delta-compress well in Git packfiles, and asset-heavy plugins (such as `dsh-pet`, ~8 MB per tarball) accumulate tens of megabytes in `.git` history across only a few releases.

## Decision

Extend the `marketplace.json` `artifact` descriptor to support immutable GitHub Release asset URLs alongside repository-local `artifacts/*.tgz` paths, while keeping identical integrity, identity, and provenance checks:

```json
{
  "artifact": {
    "url": "https://github.com/shamcleren/dsh-plugins/releases/download/plugins-2026-11/shamcleren-dsh-pet-0.2.9.tgz",
    "sha256": "<64-hex>",
    "size": 8041178
  }
}
```

### Contract and security boundaries

1. **Required fields**: Every `artifact` must declare `sha256` (64 lowercase hex characters), `size` (positive safe integer `<= 50 MiB`), and at least one of `path` (`artifacts/<filename>.tgz`) or `url`.
2. **Strict URL allowlist**: `artifact.url` must be an HTTPS URL matching `https://github.com/<owner>/<repo>/releases/download/<tag>/<filename>.tgz` with no userinfo, query string, fragment, or path traversal segments. Redirects are followed manually (at most 3 hops) and restricted to `github.com`, `objects.githubusercontent.com`, and `release-assets.githubusercontent.com` over HTTPS.
3. **Same-repository scope for remote Marketplace**: The `marketplace` plugin only accepts `artifact.url` entries whose `<owner>/<repo>` matches the configured GitHub repository source; cross-repository artifact URLs are rejected.
4. **Resolution order**:
   - Reuse a verified cached copy in `<dshHome>/plugin-cache/<sha256>.tgz` when present.
   - Otherwise, if `artifact.path` is declared and exists locally as a regular non-symlink file, read and verify it (supporting local staging, offline checkouts, and CI without external network fetches).
   - Otherwise, fetch `artifact.url` with bounded byte streaming (`<= artifact.size`), verify exact byte size, exact SHA-256, tarball `package/package.json` identity/version/bundle patch, and `dshPluginRelease.sourceDigest` provenance before writing atomically into the cache.
5. **No orphaned local artifacts**: `scripts/tests/catalog-compatibility.test.mjs` rejects unreferenced `.tgz` files under `artifacts/` and unreferenced lock snapshots under `artifacts/locks/`.

### Migration workflow

- Existing repositories with local `artifacts/*.tgz` remain fully valid until release assets are uploaded to GitHub Releases.
- `node scripts/release-plugin.mjs <id> --github-release=<owner/repo@tag>` prepares a release tarball and records the target GitHub Release `url` in `marketplace.json`.
- `node scripts/publish-github-release.mjs --tag <tag> [--repo <owner/repo>]` validates all local catalog tarballs and prints the exact `gh release` upload plan (dry-run by default). Passing `--execute` uploads the verified assets; passing `--update-catalog` transitions `marketplace.json` entries to `url`-only distribution and removes the superseded local `.tgz` files once uploaded.
