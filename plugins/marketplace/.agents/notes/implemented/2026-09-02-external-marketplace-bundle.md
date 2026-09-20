# External Marketplace bundle

## Decision

The trusted single-source Marketplace ships as an external profile bundle. It inserts one row owning the Host service, validated loopback-only RPC, and browser client. No private composition rows or generated remote types are required.

## Rationale

Marketplace release cadence and interaction design can evolve without changing the Harness repository. The package carries credential, artifact verification, transaction, and rollback code so it remains installable even though the original Host package is not published independently.

The browser uses the upstream `settings.plugins.tab` slot and its own `/trusted-marketplace` RPC. Operations are allowlisted and JSON-validated. UI state is derived from the catalog and installed dependency list; mutation success triggers a fresh read. Catalog compatibility uses the installed official DSH version, not the plugin version.

## Alternatives considered

Depending on the original Host package would avoid duplication but cannot produce an installable external bundle because that package is not published. Building on the public `dshmarket` registry would replace the single-source trust model with a different product rather than externalizing it.

## Verification

Tests cover catalog validation, repository responses, OAuth state and refresh behavior, command bounds, cache integrity, catalog/install joins, compatibility-aware updates, UI filters, and RPC rejection. TypeScript checks cover Host and browser entry points. A clean official `0.1.0-rc.8` Web profile installs the built tarball and serves its settings tab without private Host packages. Newer upstream releases and live Gongfeng sign-in require separate compatibility verification.
