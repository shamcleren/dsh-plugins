#!/usr/bin/env node
import { Toolchains } from './toolchains.js'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { audit, loadSuppressions } from './workflow.js'
import { addSuppressions, defaultSuppressionsFile, readSuppressions, removeSuppression } from './suppressions.js'
import { defaultReportsRoot, listReports, exitCode, readReport, renderReport, reviewReport, ReviewSchema, sarif } from './report.js'
import { manageHook } from './hooks.js'
import { dynamicTarget } from './ui-contract.js'

export async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv, flags = new Map<string, string>()
  const booleans = new Set(['--dependencies', '--secrets', '--enforce', '--ignore-suppressions'])
  const commandFlags: Record<string, string[]> = {
    scan: ['target', 'url', 'ref', 'scope', 'base', 'baseline', 'output', 'engine', 'semgrep', 'gitleaks', 'view', 'fail-on', 'dependencies', 'secrets', 'dynamic', 'suppressions', 'ignore-suppressions'],
    suppress: ['action', 'report', 'finding', 'reason', 'id', 'suppressions'],
    list: ['output', 'target'], render: ['report', 'output', 'format'], review: ['report', 'reviews', 'output'], check: ['report', 'fail-on'],
    setup: [],
    hook: ['target', 'action', 'event', 'output', 'semgrep', 'enforce', 'base'], help: [], '--help': [],
  }
  const allowed = new Set((commandFlags[command] ?? []).map(flag => '--' + flag))
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!
    if (!allowed.has(key) || flags.has(key)) throw new Error('Unknown or duplicate flag: ' + key)
    if (booleans.has(key)) flags.set(key, '1')
    else { const value = rest[++index]; if (!value || value.startsWith('--')) throw new Error('Missing value for ' + key); flags.set(key, value) }
  }
  const get = (key: string, fallback?: string): string | undefined => flags.get('--' + key) ?? fallback
  const required = (key: string): string => { const value = get(key); if (!value) throw new Error('--' + key + ' is required'); return value }
  const toolchains = new Toolchains()
  const controller = new AbortController(), cancel = (): void => { controller.abort(); void toolchains.close() }
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    if (command === 'setup') { const paths = await toolchains.setup(); console.log('Semgrep: ' + paths.semgrepPath + '\nGitleaks: ' + paths.gitleaksPath); return 0 }
    if (command === 'scan') {
      if (flags.has('--url') && flags.has('--target')) throw new Error('Choose either --target or --url')
      const scope = z.enum(['full', 'diff', 'staged']).parse(get('scope', 'full'))
      const engine = z.enum(['auto', 'inventory', 'semgrep']).parse(get('engine', 'auto'))
      const view = z.enum(['all', 'new']).parse(get('view', 'all')), failOn = z.enum(['none', 'high', 'medium']).parse(get('fail-on', 'none'))
      const options = { target: resolve(get('target', '.')!), scope, engine, view, failOn, signal: controller.signal,
        dependencies: flags.has('--dependencies'), secrets: flags.has('--secrets'), output: resolve(get('output', defaultReportsRoot())!),
        // Passing --dynamic is the operator's explicit authorization for the read-only runtime baseline.
        ...(get('dynamic') ? { dynamicUrl: dynamicTarget(get('dynamic')!).href } : {}) }
      if (flags.has('--ignore-suppressions') && flags.has('--suppressions')) throw new Error('Choose either --suppressions or --ignore-suppressions')
      const paths = await toolchains.resolve(get('semgrep'), get('gitleaks'), controller.signal, { semgrep: engine !== 'inventory', gitleaks: flags.has('--secrets') })
      // Exclusions saved in DSH or by `suppress add` apply by default, so hooks and CI see the same results.
      const suppressions = flags.has('--ignore-suppressions') ? undefined : await loadSuppressions(resolve(get('suppressions', defaultSuppressionsFile())!))
      const result = await audit({ ...options, ...paths, ...(suppressions ? { suppressions } : {}), ...Object.fromEntries(['url', 'ref', 'base', 'baseline'].flatMap(key => get(key) ? [[key, get(key)!]] : [])) })
      console.log('HTML: ' + result.html + '\nJSON: ' + result.json + '\nFindings: ' + result.report.findings.length)
      return exitCode(result.report)
    }
    if (command === 'suppress') {
      const file = resolve(get('suppressions', defaultSuppressionsFile())!), action = z.enum(['list', 'add', 'remove']).parse(get('action', 'list'))
      if (action === 'list') { console.log(JSON.stringify(await readSuppressions(file), null, 2)); return 0 }
      if (action === 'remove') { await removeSuppression(file, required('id')); console.log('Removed: ' + get('id')); return 0 }
      const result = await addSuppressions(file, await readReport(resolve(required('report'))), required('finding').split(',').map(value => value.trim()).filter(Boolean), required('reason'))
      console.log(JSON.stringify({ ...result, file })); return 0
    }
    if (command === 'list') {
      console.log(JSON.stringify(await listReports(resolve(get('output', defaultReportsRoot())!), get('target') ? resolve(get('target')!) : undefined), null, 2)); return 0
    }
    if (command === 'check') {
      const report = await readReport(resolve(required('report')))
      report.policy.failOn = z.enum(['none', 'high', 'medium']).parse(get('fail-on', 'high'))
      return exitCode(report)
    }
    if (command === 'render') {
      const report = await readReport(resolve(required('report'))), output = resolve(required('output'))
      const format = z.enum(['html', 'sarif']).parse(get('format', 'html'))
      await writeFile(output, format === 'html' ? renderReport(report) : JSON.stringify(sarif(report), null, 2), { flag: 'wx', mode: 0o600 })
      console.log('Created: ' + output); return 0
    }
    if (command === 'review') {
      const input = await readFile(resolve(required('reviews')), 'utf8')
      if (input.length > 4 * 1024 * 1024) throw new Error('Review file too large')
      const paths = await reviewReport(resolve(required('report')), z.array(ReviewSchema).parse(JSON.parse(input)), resolve(get('output', defaultReportsRoot())!))
      console.log('HTML: ' + paths.html + '\nJSON: ' + paths.json); return 0
    }
    if (command === 'hook') {
      const paths = await toolchains.resolve(get('semgrep'), undefined, controller.signal, { semgrep: get('action', 'install') === 'install', gitleaks: false })
      console.log(await manageHook({ target: resolve(get('target', '.')!), action: z.enum(['install', 'remove']).parse(get('action', 'install')), event: z.enum(['pre-commit', 'pre-push']).parse(get('event', 'pre-commit')),
        cli: fileURLToPath(import.meta.url), output: resolve(get('output', defaultReportsRoot())!), semgrepPath: paths.semgrepPath, enforce: flags.has('--enforce'), signal: controller.signal,
        ...(get('base') ? { base: get('base')! } : {}) })); return 0
    }
    if (command !== 'help' && command !== '--help') throw new Error('Unknown command: ' + command)
    console.log('dsh-security setup\ndsh-security scan [--target PATH | --url HTTPS_OR_SSH_URL] [--ref REF] [--scope full|diff|staged] [--base REF | --baseline REPORT_JSON]\n  [--view all|new] [--semgrep PATH] [--secrets --gitleaks PATH] [--dependencies] [--dynamic http(s)://YOUR-SERVICE] [--output REPORTS_DIR] [--fail-on none|high|medium]\n  [--suppressions FILE | --ignore-suppressions]\ndsh-security suppress [--action list|add|remove] [--report REPORT_JSON --finding ID[,ID] --reason TEXT] [--id SUPPRESSION_ID] [--suppressions FILE]\ndsh-security list [--target PATH] [--output REPORTS_DIR]\ndsh-security check --report REPORT_JSON [--fail-on high|medium|none]\ndsh-security render --report REPORT_JSON --output NEW_HTML [--format html|sarif]\ndsh-security review --report REPORT_JSON --reviews REVIEWS_JSON [--output REPORTS_DIR]\ndsh-security hook --target PATH --action install|remove --event pre-commit|pre-push [--base REF] [--enforce]\nExit: 0 complete, 1 policy exceeded, 2 incomplete/unavailable/error. CLI runs rules only; DSH dsh-security-review performs model review. --dependencies sends package names and versions to OSV. --dynamic sends at most 12 read-only same-origin GET requests to a service you own. Exclusions live in ~/.dsh/security-scan/suppressions.json unless --suppressions is given.')
    return 0
  } finally { await toolchains.close(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
// npm bin shims and macOS /var paths can be symlinks; Node resolves the module URL.
const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try { process.exitCode = await main(process.argv.slice(2)) } catch (error) { console.error(error instanceof Error ? error.message : 'Security scan failed'); process.exitCode = 2 }
}
