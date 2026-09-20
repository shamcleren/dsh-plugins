# Security Policy

## Supported versions

The latest `0.2.x` release is supported. DeepSeek Harness is currently a pre-release dependency, so compatibility and security assumptions must be revalidated before upgrading the pinned DSH version.

## Reporting a vulnerability

Contact the repository maintainers through an approved private internal channel. Do not place credentials, private pet assets, local paths, session contents, or exploit details in a public issue.

Include the affected version, macOS version, DeepSeek Harness version, reproduction steps, and the smallest non-sensitive evidence needed to understand the issue.

## Data boundary

The plugin does not require account credentials. It copies validated bundled packs and optional packs from the configured local source directory into `DSH_HOME/desktop-pet/packs/`, stores the last screen anchor in `DSH_HOME/desktop-pet/state.json`, and consumes in-process DSH session events to render status. It does not persist model prompts or assistant responses.
