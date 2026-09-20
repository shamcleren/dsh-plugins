# Mode template manager

Status: planned

## Problem

DeepSeek Harness supports profile bundles and patch layers, but assembling a useful operating mode can require selecting several plugins and supplying coordinated configuration. Users need to inspect a named template and enable the complete composition with one action, without manually editing multiple patch rows.

## Direction

Implement a DSH plugin that manages declarative mode templates over the existing profile and bundle mechanisms. A mode is a reviewed composition template, not a second plugin format. Activating a mode resolves its required bundles and configuration, previews the complete change, applies it atomically, restarts only the owning runtime when required, verifies health, and retains the previous state for rollback.

The manager does not become a remote marketplace. Package installation, publisher trust, signature verification, and remote update distribution remain separate concerns.

## Vocabulary

- **Template**: a versioned declarative description of required bundles, patch layers, configuration inputs, and health checks.
- **Mode**: one template resolved with user-owned configuration for one target profile.
- **Activation**: the atomic transition from the current profile composition to a resolved mode.

## Version 0.1 scope

- Discover templates shipped by installed, trusted packages.
- List template name, purpose, required plugins, required inputs, and compatibility constraints.
- Preview the exact profile and patch changes before activation.
- Validate missing bundles, unresolved credentials, incompatible versions, and conflicting rows before writing.
- Activate one mode for a selected DSH profile with a single command or UI action.
- Persist the selected template version and user-owned input references.
- Retain the previous valid composition and support one-action rollback.
- Report activation and health-check failures without presenting a partial mode as active.

## Initial package boundary

```text
plugins/mode-manager/
├── package.json
├── cordis.patch.yml
├── src/
│   ├── index.ts              Cordis plugin entry
│   ├── catalog.ts            Installed template discovery
│   ├── resolve.ts            Template plus user inputs to profile changes
│   ├── activate.ts           Atomic activation and rollback
│   └── service.ts            Command/UI-facing operations
└── tests/
```

The template schema is not finalized until two concrete modes exist. Candidate first consumers are a WeCom conversation mode and a local coding mode.

## Deferred

- Searching or downloading packages from a remote registry.
- Installing arbitrary npm or Git dependencies.
- Publisher signatures and rollout policy.
- Automatic background upgrades.
- Combining several active templates through implicit precedence.
- A general-purpose visual editor for arbitrary Cordis configuration.

## Acceptance criteria

1. A user can list installed templates and understand the plugins and inputs each one requires.
2. Preview is deterministic and matches the files an activation would write.
3. Invalid or incomplete inputs produce no profile mutation.
4. Successful activation makes the selected mode the only recorded active version for the target profile.
5. A failed restart or health check restores the prior valid composition.
6. The same activation request is idempotent.

## Open design questions

- Which package owns the template schema once two real templates establish the common fields?
- Should a mode target an existing profile or create a dedicated profile with an explicit name?
- Which configuration values remain template defaults, which are ordinary settings, and which must be credential references?
- What health signal proves that a composition is ready without encoding plugin-specific checks in the manager?
