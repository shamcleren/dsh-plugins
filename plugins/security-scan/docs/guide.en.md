# DSH Security Scan guide

Evidence-oriented security scanning for Python, Go, JavaScript and TypeScript, with a standard DSH sidebar panel, offline HTML/JSON reports, Git baselines and optional AI source review. MIT licensed. Start with the [overview](../README.en.md) for installation and a first scan; this guide covers behavior and limits. [中文手册](guide.md).

## What it does

| Mode | Checks | Model tokens |
| --- | --- | --- |
| Deterministic static checks | 29 bundled Semgrep rules for Flask, Django, Express, Koa, Next.js, React, net/http, Gin, Echo and common SQL/HTTP libraries; optional Gitleaks secret candidates and OSV dependency advisories | None |
| Optional runtime baseline | Read-only HTTP checks against a running service you authorize: security headers, cookie attributes, CORS, debug error pages, directory listing and exposed `.git` / `.env` files | None |
| Optional AI source review | Trace source and callers, review candidates and record evidence for business risks | Uses your configured DSH model |

AI review is source analysis. The runtime baseline is **not full DAST**: it does not log in, submit forms, send injection or exploit payloads, or confirm exploitability. Rules produce candidates, not automatic proof of vulnerabilities. Partial coverage and failed engines remain visible.

**New workbench tasks enable AI by default. Disable “Agentic AI” before running for a model-free scan, or use the CLI/hooks.** Calling a rules-only tool from an AI conversation can still consume tokens in that outer conversation. Toolchain preparation needs network downloads; once tools are ready, local checks can run offline with OSV disabled. OSV sends package names/versions over the network and does not call an LLM.

## Install a release

Requires official DSH **0.2.1-rc.5**, as declared in `engines.dsh`. Other versions, including the 0.2.2 prereleases, have not been verified. The plugin uses only public extension points, does not patch DSH, and needs no other plugin or custom shell.

Install from npm as shown in the [overview](../README.en.md#install): the package is `@shamcleren/dsh-security-scan`, pinned to a version. The pnpm used by DSH skips versions published less than a day ago unless the version is pinned. The npm package is the same file as the `.tgz` of that version on [GitHub Releases](https://github.com/shamcleren/dsh-security-scan/releases), with the same digest. You can also open the **Plugins** page in the DSH sidebar, choose **Add plugin** and enter the pinned package name or the Release URL, or download the tarball, compare it with the SHA-256 in the release notes and pass its absolute path instead. Use your actual `desktop` profile for the official desktop app and `web` for the Web host. Restart DSH and select **Security Scan** in the upper sidebar panel list. To upgrade, run the command again with the new version. Installations managed by the DeepSeek Harness plugin collection (`dhp`) use `dhp plugin install security-scan` and `dhp update` instead.

## Scan without model credentials

After installing, run the plugin's `dsh-security` CLI from the profile's `node_modules/.bin`. Adjust the path for your profile and `DSH_HOME`, or add that directory to `PATH`:

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-security scan --target /absolute/path/project
# Optional known dependency advisories (sends names and versions to OSV)
~/.dsh/profiles/web/node_modules/.bin/dsh-security scan --target /absolute/path/project --dependencies
# Compare the full changed files against an explicit Git merge base
~/.dsh/profiles/web/node_modules/.bin/dsh-security scan --target /absolute/path/project --scope diff --base origin/main
```

With `dhp`, `dhp plugin exec security-scan -- scan ...` is equivalent. `dsh-security setup` prepares Semgrep CE 1.176.1 and Gitleaks 8.24.2; `--semgrep`/`--gitleaks` may select your own matching versions. Downloads and Python wheels are pinned and verified. Real installation/scanning has been validated on macOS arm64; other packaged platforms need separate acceptance testing.

Every scan saves a new JSON report and an offline HTML view. `render --report report.json --output new-report.sarif --format sarif` exports SARIF. `full`, `diff`, and `staged` scan scopes share the same workflow; local/remote Git targets, explicit baselines, evidence snapshots, and report revisions are documented in [the Chinese guide](guide.md). The scanner does not run target project scripts, install target dependencies or execute payloads. Installing a Git hook is a separate explicit action and preserves existing hooks. CLI exit codes: 0 completed/no configured policy failure, 1 confirmed findings exceeded policy, 2 incomplete/unavailable/error. Inventory mode is not a completed security scan.

Supported dependency inputs: npm package-lock v2/v3, pnpm lock v9, Go go.sum, exact Python requirements, and **uv.lock schema v1**. uv parsing includes all locked registry versions across markers and development groups; it does not infer the active environment or reachability. Workspace editable/virtual/directory packages are not queried as PyPI packages. Git/URL/archive and malformed entries are explicitly partial and never followed. Private registry names/versions are also queried against OSV's PyPI ecosystem and need identity review. uv findings currently identify the manifest's first line and disclose that the line mapping is approximate.

## Runtime baseline

Set a service URL in a task's **Checks** section and confirm you are authorized to test it, or pass `--dynamic URL` to the CLI or `dynamic_url` to `dsh_security_scan_start` / `dsh_security_scan_audit`; passing a URL explicitly is the authorization. Without a URL, no request is sent.

```sh
dsh-security scan --target /absolute/path/project --dynamic http://127.0.0.1:3000
```

At most 12 same-origin GET requests are sent, each with a 10 s timeout and a 256 KiB body cap. Same-origin redirects are followed up to 3 times; cross-origin redirects are not followed. URLs with credentials or fragments are rejected. Reports keep the endpoint, status and conclusion, never response bodies or cookie values. Sensitive-file probes are compared against a random missing path, so SPA fallbacks are not reported. An unreachable service marks the check failed and coverage partial; static results are still published. SARIF uses the endpoint URL as the location.

## Bundled rules

Rules cover shell execution, dynamic code (`eval`, `new Function`, Node `vm`), unsafe deserialization, disabled TLS verification, SQL built by concatenation/formatting, HTML sinks (`innerHTML`, `dangerouslySetInnerHTML`, `mark_safe`, `template.HTML`), server-side template source, Flask debug mode, unverified JWTs, credentialed CORS that reflects any origin, and request-controlled SSRF, path traversal and open redirects. The last three use intra-function taint tracking from framework request sources (`request.args`, `req.query`, `r.URL.Query()`, `c.Query()` …) and treat fixed-origin prefixes, constant lookup tables, `basename` / `secure_filename` / `filepath.IsLocal` and similar guards as handled. Pure string literals are no longer reported for shell, eval, HTML and SQL sinks. Rules do not follow values across functions or files, and do not resolve constant variables. The readable source is `scripts/build-rules.mjs`; it generates `rules/baseline.yml`, and a test fails when the two drift.

## Baselines

New tasks compare with the task's previous successful report by default; you no longer pick a report. A task's first scan is not compared and its report says so. Each later run takes the newest report when it is queued, preferring complete coverage and skipping repair-branch rescans and deleted reports, so only findings that appeared since then count as new. The editor shows which report the next run will compare with, and each run links to the report it used. New-finding counts appear only when the reports are comparable (same repository, rules, engines and complete coverage). Diff scans keep a Git baseline; staged scans compare with HEAD. Tasks from 0.17 or earlier that pinned a saved report migrate to the previous-report baseline. Conversation scans reuse one task per target, ref and scope, so they compare with their previous scan too; a task you edit in the workbench is yours and conversations never overwrite it.

## False-positive exclusions

Select findings under **Act on scan results** and choose **Mark as false positive** with a required reason (up to 500 characters). Later scans mark a finding as dismissed when the repository, engine, rule, file and code fingerprint all match: it is hidden by default, ignored by failure thresholds and CLI exit codes, omitted from SARIF and skipped by AI review. Line shifts still match; edited code, renamed files or another repository show the finding again, so one exclusion cannot hide a later change. Reports keep the record with the date and reason. The current report updates immediately without a rescan.

Exclusions live only on this machine in `security-scan/suppressions.json` next to the reports directory, never in the scanned repository, up to 5000 entries. Search and restore them under **Scan settings → Excluded findings**. AI-added findings have no stable fingerprint across runs and cannot be excluded. A symlinked, malformed or locked file never blocks a scan; the report says exclusions were not applied and the file is left untouched. The CLI and Git hooks use the same list by default:

```sh
dsh-security suppress --action list
dsh-security suppress --action add --report /path/report.json --finding ID1,ID2 --reason "constant input"
dsh-security suppress --action remove --id SUPPRESSION_ID
dsh-security scan --target /path/project --suppressions /path/suppressions.json   # or --ignore-suppressions
```

## Guided repair loop

Selected findings go to a DSH repair session with per-category guidance and six steps: verify, minimal fix, regression test, handle findings left unfixed, rescan, summary. When the session verifies a false positive, or you decide not to fix a finding, it states its evidence and calls `dsh_security_scan_exclude_findings`. DSH shows an approval prompt listing the findings, locations and reason; that prompt is your decision, and the exclusion is written only when you approve. A rejected request keeps the findings and is not repeated. The tool accepts findings from that session's repair chain, scans it started or observed, or local scans inside its workspace, up to 20 per call; AI-added findings cannot be excluded. `dsh_security_scan_findings` lists the IDs. Rescans then mark those findings as excluded and the next repair round omits them. The session calls `dsh_security_scan_repair_rescan` to queue exactly one rescan with the original configuration; the result is posted back to that session. On the rescan report, **Continue repairing remaining issues** sends remaining (matched by stable fingerprint) and newly added findings back to the same session as the next round, up to 20 per round. Commit, push and PR creation still require the user's decision in the conversation.

## AI source review and migration

Use the **dsh-security-review** Skill or enable AI per task. Existing DSH model configuration is reused; no additional API key is stored by this plugin. Selected source excerpts are sent to that model. Findings need real archived evidence; missing coverage is never converted to “safe”. Reports and native DSH sessions can contain sensitive metadata/excerpts, so review them before sharing.

Version 0.15 namespaces all global tools with `dsh_security_scan_` and renames the Skill from `security-review` to `dsh-security-review`. No generic aliases are registered: `security_audit` and `security_scan` remain available to other plugins. The main entry is `dsh_security_scan_start`, status is `dsh_security_scan_status`, and rules-only reporting is `dsh_security_scan_audit`. Update saved prompts, tool allowlists and external workflows using old names; restart DSH and start a new scan after upgrading. The [complete migration table](guide.md#015-工具命名迁移) includes all root tools. Profile configuration, CLI name, preset and stored tasks/reports retain their existing identities.

## Development

The synthetic evaluation corpus, its baseline and the `evaluate` command have been removed because the intentionally vulnerable source files trigger repository security scanners. The package no longer includes evaluation fixtures or a reproducible corpus benchmark. Regression tests remain; they do not establish a production vulnerability detection rate or AI review accuracy.

From the repository root, with Node.js 22.19+ or 24+ and the pnpm version in `packageManager`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

`lib/` holds the build of the current release so Git-based installs work; contributions only need the checks to pass, and maintainers rebuild `lib/` when releasing. Opt in to real scanner tests with `SECURITY_TEST_SEMGREP`; optional installed-profile integration requires an isolated `SECURITY_TEST_INSTALLATION`. Missing prerequisites are reported as skips, not passes. See [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md), [third-party notices](../THIRD_PARTY_NOTICES.md), and [LICENSE](../LICENSE).
