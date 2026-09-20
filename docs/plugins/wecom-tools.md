# WeCom office tools

Status: implemented

## Purpose

Provide enterprise-office actions through the upstream `wecom-unified` Skill without coupling user authorization to the WeCom AI Bot message channel.

## Boundary

`@shamcleren/dsh-wecom-aibot` owns message transport and uses Bot ID/Secret credentials. `@shamcleren/dsh-wecom-tools` owns the Skill bundle and uses the separate user authorization maintained by `@wecom/cli`. Either plugin can be installed independently.

The tools plugin mounts one read-only bundled Skill through the official DSH filesystem Skill provider. The Skill guides CLI installation and `wecom-cli auth init --noninteractive` on first use. DSH shell and approval policy remain authoritative for command execution.

## Shared-identity warning

All sessions on one Host process share the operating-system account's `wecom-cli` authorization. A multi-user Chatbot deployment must restrict who may invoke the Skill and keep write approvals enabled; installing the package does not create per-chat-user WeCom identities.

## Upstream ownership

The packaged content is pinned to `wecomTeam/wecom-unified` commit `33aaa7155b0d1584828bc143a3877c4b5ec438fe`; only trailing Markdown whitespace is normalized for repository checks. The package carries the upstream MIT license and notice. Updating the snapshot requires an explicit source review, test run, version bump, and new Marketplace artifact hash.

## Acceptance criteria

1. Installing the package makes `wecom-unified` available through the native DSH Skill catalog after restart.
2. Installing or removing the package does not alter WeCom AI Bot settings or credentials.
3. Skill references and scripts resolve from the installed package directory.
4. The packaged upstream commit and license are reviewable from the artifact.
