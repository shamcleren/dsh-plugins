#!/usr/bin/env node
// Readable source of rules/baseline.yml. The bundled file stays in YAML's JSON subset so the runtime reads it without a YAML parser.
// After editing run `node scripts/build-rules.mjs`; `--check` exits 1 when the committed file is stale.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const p = pattern => ({ pattern })
const not = pattern => ({ 'pattern-not': pattern })
const inside = pattern => ({ 'pattern-inside': pattern })
const either = (...items) => ({ 'pattern-either': items.map(item => typeof item === 'string' ? p(item) : item) })
const all = (...items) => ({ patterns: items.map(item => typeof item === 'string' ? p(item) : item) })
const regex = (metavariable, value) => ({ 'metavariable-regex': { metavariable, regex: value } })
const sink = (...items) => ({ patterns: [either(...items), { 'focus-metavariable': '$SINK' }] })
const taint = (sources, sanitizers, sinks) => ({ mode: 'taint', 'pattern-sources': sources, 'pattern-sanitizers': sanitizers, 'pattern-sinks': sinks })
const rule = (id, languages, cwe, message, body) => ({ id: 'dsh-security.' + id, languages, severity: 'WARNING', message, metadata: { cwe }, ...body })
const PY = ['python'], GO = ['go'], JS = ['javascript', 'typescript']

// Request-controlled values in the supported frameworks.
const pySources = [p('flask.request.$ATTR'), p('flask.request.get_json(...)'),
  all('$REQ.$PART', regex('$REQ', '^(self\\.)?request$'), regex('$PART', '^(GET|POST|COOKIES|FILES|META|body|data|query_params|headers)$'))]
const jsSources = [all('$REQ.$PART', regex('$REQ', '^(req|request|ctx|ctx\\.request)$'), regex('$PART', '^(query|body|params|headers|cookies)$')), p('$REQ.nextUrl.searchParams')]
const goSources = [p('($R : *http.Request).URL.Query()'), p('($R : *http.Request).FormValue(...)'), p('($R : *http.Request).PostFormValue(...)'), p('($R : *http.Request).PathValue(...)'), p('mux.Vars(...)'),
  all('($C : *gin.Context).$M(...)', regex('$M', '^(Query|DefaultQuery|Param|PostForm|DefaultPostForm|GetHeader)$')),
  all('($C : echo.Context).$M(...)', regex('$M', '^(QueryParam|Param|FormValue)$'))]
// An expression that starts with a fixed scheme and host keeps the destination under application control.
const fixedOrigin = all('$EXPR', regex('$EXPR', '^f?["\'`]https?://[^/"\'`{$]+/'))
// An expression that starts with a same-site path: "/x", never "//" or "/\".
const relativePath = all('$EXPR', regex('$EXPR', '^f?["\'`]/[^/\\\\"\'`]'))
// Lookups in constant tables (Python/JS upper-case names, Go allow-list maps) select application-owned values.
const constantTable = all(either('$MAP[...]', '$MAP.get(...)'), regex('$MAP', '^[A-Z][A-Z0-9_]*$'))
const goAllowList = all('$MAP[...]', regex('$MAP', '^(?i:allowed|allow|trusted|known|safe)[A-Za-z0-9_]*$'))
// SQL text assembled at runtime; concatenating only literals is excluded.
const built = (metavariable, shapes) => ({ 'metavariable-pattern': { metavariable, patterns: [either(...shapes), not('"..." + "..."')] } })
const pyBuilt = ['f"..."', '"..." % $VALUE', '"...".format(...)', '"..." + $VALUE']
const goBuilt = ['fmt.Sprintf(...)', '"..." + $VALUE']
const jsBuilt = ['"..." + $VALUE', '`...${$VALUE}...`']
const pySql = either('$CUR.execute($QUERY, ...)', '$CUR.executemany($QUERY, ...)', '$MODEL.objects.raw($QUERY, ...)', 'sqlalchemy.text($QUERY)')
const jsSqlMethods = '^(query|execute|raw|\\$queryRawUnsafe|\\$executeRawUnsafe)$'
const goSqlMethods = '^(Query|QueryRow|Exec|Prepare|Raw|Where|Order|Group|Having)$'

export const rules = [
  // Sink families shared by all frameworks. A pure string literal cannot carry external input and is excluded.
  rule('python-shell', PY, 'CWE-78', 'Shell execution: verify untrusted input cannot reach the command.', all(
    either('subprocess.$FN($CMD, ..., shell=True, ...)', 'os.system($CMD)', 'os.popen($CMD, ...)'),
    not('subprocess.$FN("...", ..., shell=True, ...)'), not('os.system("...")'), not('os.popen("...", ...)'))),
  rule('python-eval', PY, 'CWE-95', 'Dynamic Python execution: trace the source of the executed value.', all(
    either('eval($CODE, ...)', 'exec($CODE, ...)'), not('eval("...", ...)'), not('exec("...", ...)'))),
  rule('python-pickle', PY, 'CWE-502', 'Pickle deserialization: verify input is trusted before loading.', either('pickle.loads(...)', 'pickle.load(...)', 'pickle.Unpickler(...)')),
  rule('python-tls', PY, 'CWE-295', 'TLS certificate verification is explicitly disabled.', either('requests.$FN(..., verify=False, ...)', 'httpx.$FN(..., verify=False, ...)', 'ssl._create_unverified_context(...)')),
  rule('python-yaml', PY, 'CWE-502', 'Unsafe YAML deserialization: verify trusted input or use a safe loader.', either('yaml.unsafe_load(...)', 'yaml.load(..., Loader=yaml.UnsafeLoader, ...)', 'yaml.load(..., Loader=yaml.Loader, ...)')),
  rule('go-shell', GO, 'CWE-78', 'Shell execution: trace the origin and validation of command text.', all(
    either('exec.Command("sh", "-c", ...)', 'exec.Command("bash", "-c", ...)', 'exec.CommandContext($CTX, "sh", "-c", ...)', 'exec.CommandContext($CTX, "bash", "-c", ...)'),
    not('exec.Command("sh", "-c", "...")'), not('exec.Command("bash", "-c", "...")'), not('exec.CommandContext($CTX, "sh", "-c", "...")'), not('exec.CommandContext($CTX, "bash", "-c", "...")'))),
  rule('go-tls', GO, 'CWE-295', 'TLS certificate verification is explicitly disabled.', either('tls.Config{..., InsecureSkipVerify: true, ...}')),
  rule('go-sql', GO, 'CWE-89', 'Formatted SQL query: confirm values use bind parameters.', either(
    all('$DB.$FN($QUERY, ...)', regex('$FN', goSqlMethods), built('$QUERY', goBuilt)),
    all('$DB.$FN($CTX, $QUERY, ...)', regex('$FN', '^(QueryContext|QueryRowContext|ExecContext|PrepareContext)$'), built('$QUERY', goBuilt)),
    all(either(inside('$QUERY := $BUILT\n...\n'), inside('$QUERY = $BUILT\n...\n')), '$DB.$FN($QUERY, ...)', regex('$FN', goSqlMethods), built('$BUILT', goBuilt)))),
  rule('js-eval', JS, 'CWE-95', 'Dynamic JavaScript execution: trace untrusted data before confirming a vulnerability.', all(
    either('eval($CODE)', 'new Function(...)', 'vm.runInNewContext($CODE, ...)', 'vm.runInThisContext($CODE, ...)', 'vm.runInContext($CODE, ...)', 'new vm.Script($CODE, ...)'),
    not('eval("...")'), not('vm.runInNewContext("...", ...)'), not('vm.runInThisContext("...", ...)'), not('vm.runInContext("...", ...)'))),
  rule('js-shell', JS, 'CWE-78', 'Shell execution: verify command text cannot contain untrusted input.', all(
    either('child_process.exec($CMD, ...)', 'child_process.execSync($CMD, ...)', 'child_process.spawn($CMD, $ARGS, {..., shell: true, ...})', 'child_process.spawnSync($CMD, $ARGS, {..., shell: true, ...})'),
    not('child_process.exec("...", ...)'), not('child_process.execSync("...", ...)'))),
  rule('js-tls', JS, 'CWE-295', 'TLS certificate verification is explicitly disabled.', either('{..., rejectUnauthorized: false, ...}', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"')),
  rule('js-html', JS, 'CWE-79', 'HTML sink: inspect sanitization and the source of the assigned value.', all(
    either('$ELEMENT.innerHTML = $HTML', '$ELEMENT.outerHTML = $HTML', '$ELEMENT.insertAdjacentHTML($WHERE, $HTML)', 'document.write($HTML)', '{__html: $HTML}'),
    not('$ELEMENT.innerHTML = "..."'), not('$ELEMENT.outerHTML = "..."'), not('$ELEMENT.insertAdjacentHTML($WHERE, "...")'), not('document.write("...")'), not('{__html: "..."}'),
    not('$ELEMENT.innerHTML = DOMPurify.sanitize(...)'), not('$ELEMENT.insertAdjacentHTML($WHERE, DOMPurify.sanitize(...))'), not('{__html: DOMPurify.sanitize(...)}'))),

  // Python: Flask, Django / DRF, Jinja2, requests / httpx, PyJWT.
  rule('python-sql', PY, 'CWE-89', 'SQL text built with an f-string, % formatting, format() or concatenation: confirm values use bind parameters.', either(
    all(pySql, built('$QUERY', pyBuilt)),
    all(inside('$QUERY = $BUILT\n...'), pySql, built('$BUILT', pyBuilt)))),
  rule('python-template', PY, 'CWE-1336', 'Template source built at runtime: user-controlled template text can execute server-side expressions.', all(
    either('flask.render_template_string($TEMPLATE, ...)', 'jinja2.Template($TEMPLATE, ...)', 'jinja2.Environment(...).from_string($TEMPLATE, ...)'),
    not('flask.render_template_string("...", ...)'), not('jinja2.Template("...", ...)'), not('jinja2.Environment(...).from_string("...", ...)'))),
  rule('python-html', PY, 'CWE-79', 'Value marked as safe HTML bypasses template escaping: confirm it cannot contain user content.', all(
    either('django.utils.safestring.mark_safe($HTML)', 'django.utils.safestring.SafeString($HTML)', 'markupsafe.Markup($HTML)', 'flask.Markup($HTML)'),
    not('django.utils.safestring.mark_safe("...")'), not('django.utils.safestring.SafeString("...")'), not('markupsafe.Markup("...")'), not('flask.Markup("...")'))),
  rule('python-debug', PY, 'CWE-489', 'Flask debug mode enables the interactive Werkzeug debugger; never expose it outside local development.', all(
    inside('$APP = flask.Flask(...)\n...'), '$APP.run(..., debug=True, ...)')),
  rule('python-jwt', PY, 'CWE-347', 'JWT signature verification is disabled or the none algorithm is accepted.', either(
    'jwt.decode(..., options={..., "verify_signature": False, ...}, ...)', 'jwt.decode(..., verify=False, ...)', 'jwt.decode(..., algorithms=[..., "none", ...], ...)')),
  rule('python-ssrf', PY, 'CWE-918', 'Server-side request to a request-controlled URL: enforce an allowed destination policy.', taint(pySources,
    [fixedOrigin, constantTable],
    [sink('requests.$FN($SINK, ...)', 'requests.request($METHOD, $SINK, ...)', 'httpx.$FN($SINK, ...)', 'urllib.request.urlopen($SINK, ...)')])),
  rule('python-path', PY, 'CWE-22', 'File path built from request input: confirm the resolved path stays inside the intended directory.', taint(pySources,
    [p('os.path.basename(...)'), p('werkzeug.utils.secure_filename(...)'), all(inside('if not $X.startswith(...):\n    ...\n...'), '$X'), all(inside('if not $X.is_relative_to(...):\n    ...\n...'), '$X')],
    [sink('open($SINK, ...)', 'flask.send_file($SINK, ...)', 'os.remove($SINK)', 'shutil.rmtree($SINK, ...)')])),
  rule('python-redirect', PY, 'CWE-601', 'Redirect target controlled by the request: restrict it to same-site paths or an allow list.', taint(pySources,
    [relativePath, constantTable, p('flask.url_for(...)'), all(either(inside('if url_has_allowed_host_and_scheme($X, ...):\n    ...'), inside('if not url_has_allowed_host_and_scheme($X, ...):\n    ...\n...')), '$X')],
    [sink('flask.redirect($SINK, ...)', 'django.shortcuts.redirect($SINK, ...)', 'django.http.HttpResponseRedirect($SINK, ...)')])),

  // JavaScript / TypeScript: Express, Koa, Next.js route handlers, React, node-postgres / mysql / knex.raw / Prisma.
  rule('js-sql', JS, 'CWE-89', 'SQL text built with concatenation or template interpolation: confirm values use bind parameters.', either(
    all('$DB.$FN($QUERY, ...)', regex('$FN', jsSqlMethods), built('$QUERY', jsBuilt)),
    all(inside('$QUERY = $BUILT;\n...'), '$DB.$FN($QUERY, ...)', regex('$FN', jsSqlMethods), built('$BUILT', jsBuilt)))),
  rule('js-ssrf', JS, 'CWE-918', 'Server-side request to a request-controlled URL: enforce an allowed destination policy.', taint(jsSources,
    [fixedOrigin, constantTable],
    [sink('fetch($SINK, ...)', 'axios($SINK, ...)', 'axios.$FN($SINK, ...)', 'got($SINK, ...)', 'got.$FN($SINK, ...)', 'http.get($SINK, ...)', 'https.get($SINK, ...)', 'http.request($SINK, ...)', 'https.request($SINK, ...)')])),
  rule('js-redirect', JS, 'CWE-601', 'Redirect target controlled by the request: restrict it to same-site paths or an allow list.', taint(jsSources,
    [relativePath, constantTable],
    [sink('$RES.redirect($SINK)', '$RES.redirect($STATUS, $SINK)', 'NextResponse.redirect($SINK, ...)')])),
  rule('js-path', JS, 'CWE-22', 'File path built from request input: confirm the resolved path stays inside the intended directory.', taint(jsSources,
    [p('path.basename(...)'), all(inside('if (!$X.startsWith(...)) { ... }\n...'), '$X')],
    [all(either(all('fs.$FN($SINK, ...)', regex('$FN', '^(readFile|readFileSync|createReadStream|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|open|openSync)$')),
      all('$RES.sendFile($SINK, ...)', not('$RES.sendFile($SINK, {..., root: $ROOT, ...}, ...)')), '$RES.download($SINK, ...)'), { 'focus-metavariable': '$SINK' })])),
  rule('js-cors', JS, 'CWE-942', 'CORS reflects any origin while allowing credentials: restrict origins to an explicit list.', either(
    'cors({..., origin: true, ..., credentials: true, ...})', 'cors({..., credentials: true, ..., origin: true, ...})')),

  // Go: net/http, gorilla/mux, Gin, Echo, html/template, database/sql and GORM.
  rule('go-path', GO, 'CWE-22', 'File path built from request input: confirm the resolved path stays inside the intended directory.', taint(goSources,
    [p('filepath.Base(...)'), all(inside('if !filepath.IsLocal($X) {\n  ...\n}\n...\n'), '$X'), all(inside('if !strings.HasPrefix($X, ...) {\n  ...\n}\n...\n'), '$X')],
    [sink('os.ReadFile($SINK)', 'os.Open($SINK)', 'os.OpenFile($SINK, ...)', 'os.Create($SINK)', 'os.Remove($SINK)', 'os.RemoveAll($SINK)', 'http.ServeFile($W, $REQ, $SINK)', '($CTX : *gin.Context).File($SINK)', '($CTX : *gin.Context).FileAttachment($SINK, ...)', '($CTX : echo.Context).File($SINK)')])),
  rule('go-redirect', GO, 'CWE-601', 'Redirect target controlled by the request: restrict it to same-site paths or an allow list.', taint(goSources,
    [relativePath, goAllowList, p('url.PathEscape(...)'), p('url.QueryEscape(...)')],
    [sink('http.Redirect($W, $REQ, $SINK, ...)', '($CTX : *gin.Context).Redirect($STATUS, $SINK)', '($CTX : echo.Context).Redirect($STATUS, $SINK)')])),
  rule('go-ssrf', GO, 'CWE-918', 'Server-side request to a request-controlled URL: enforce an allowed destination policy.', taint(goSources,
    [fixedOrigin, goAllowList, p('url.PathEscape(...)'), p('url.QueryEscape(...)')],
    [sink('http.Get($SINK)', 'http.Post($SINK, ...)', 'http.Head($SINK)', 'http.NewRequest($METHOD, $SINK, ...)', 'http.NewRequestWithContext($CTX, $METHOD, $SINK, ...)', '($CLIENT : *http.Client).Get($SINK)')])),
  rule('go-html', GO, 'CWE-79', 'Value converted to trusted html/template content bypasses escaping: confirm it cannot contain user content.', all(
    either('template.HTML($VALUE)', 'template.JS($VALUE)', 'template.HTMLAttr($VALUE)', 'template.URL($VALUE)'),
    not('template.HTML("...")'), not('template.JS("...")'), not('template.HTMLAttr("...")'), not('template.URL("...")'))),
]

export const render = () => JSON.stringify({ rules }, null, 2) + '\n'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('../rules/baseline.yml', import.meta.url)
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== render()) { console.error('rules/baseline.yml is stale; run node scripts/build-rules.mjs'); process.exit(1) }
  } else {
    writeFileSync(target, render())
    console.log('Wrote ' + rules.length + ' rules')
  }
}
