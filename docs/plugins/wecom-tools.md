# WeCom office tools

Status: implemented

## Purpose

Provide enterprise-office actions through the upstream `wecom-unified` Skill without coupling user authorization to the WeCom AI Bot message channel.

## Boundary

The WeCom adapter in `@shamcleren/dsh-im` owns message transport and uses Bot ID/Secret credentials. `@shamcleren/dsh-wecom-tools` owns the Skill bundle and uses the separate user authorization maintained by `@wecom/cli`. Either plugin can be installed independently.

The tools plugin mounts one read-only bundled Skill through the official DSH filesystem Skill provider. The Skill guides CLI installation and `wecom-cli auth init --noninteractive` on first use. DSH shell and approval policy remain authoritative for command execution.

The Skill uses `message send` for employee text messages and `message aibot` when a user explicitly chooses the bot as sender. It uses `chat groups list` and `chat messages list` to look up a group and read history from the last 7 days. Employee messaging and history are subject to the organization's WeCom permissions. See the [plugin guide](../../plugins/wecom-tools/README.md) for supported requests.

## Shared-identity warning

All sessions on one Host process share the operating-system account's `wecom-cli` authorization. A multi-user Chatbot deployment must restrict who may invoke the Skill and keep write approvals enabled; installing the package does not create per-chat-user WeCom identities.

## Upstream ownership

The upstream snapshot and local additions are recorded in [THIRD_PARTY_NOTICES.md](../../plugins/wecom-tools/THIRD_PARTY_NOTICES.md). The package carries the upstream MIT license. Updating it requires source review, tests, a version bump, and a new catalog artifact hash.

## Acceptance criteria

1. Installing the package makes `wecom-unified` available through the native DSH Skill catalog after restart.
2. Installing or removing the package does not alter WeCom AI Bot settings or credentials.
3. Skill references and scripts resolve from the installed package directory.
4. The packaged upstream commit and license are reviewable from the artifact.
