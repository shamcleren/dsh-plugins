#!/bin/sh
# The first installation entry point must work without Node, npm, or Python.
set -eu
umask 077
repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "Initialization failed: $*" >&2; exit 1; }

if [ -n "${DSH_INIT_DIR:-}" ]; then set -- --dir "$DSH_INIT_DIR" "$@"; fi
case "${DSH_INIT_WEB_ONLY:-0}" in 1) set -- --no-app "$@" ;; 0) ;; *) fail 'WEB_ONLY must be 0 or 1' ;; esac
case "${DSH_INIT_MARKETPLACE:-0}" in 1) set -- --with-marketplace "$@" ;; 0) ;; *) fail 'MARKETPLACE must be 0 or 1' ;; esac
case "${DSH_INIT_RESUME:-0}" in 1) set -- --resume "$@" ;; 0) ;; *) fail 'RESUME must be 0 or 1' ;; esac
case "${DSH_INIT_REBUILD:-0}" in 1) set -- --rebuild-app "$@" ;; 0) ;; *) fail 'REBUILD must be 0 or 1' ;; esac
desktop=1
for argument in "$@"; do
  case "$argument" in
    --no-app) desktop=0 ;;
    --help)
      printf '%s\n' 'Usage: make init [DIR=/new/path] [WEB_ONLY=1] [MARKETPLACE=1] [RESUME=1] [REBUILD=1]' \
        'Without make: sh scripts/init.sh [--dir /new/path] [--no-app] [--with-marketplace] [--resume] [--rebuild-app]' \
        'Installs clean DSH by default. After init, reopen the terminal if needed and run: dhp help' \
        'Compatible Node.js and npm are reused; otherwise a verified private Node.js distribution is installed.'
      exit 0 ;;
  esac
done
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail 'Only macOS and Linux are supported' ;;
esac
if [ "$platform" = darwin ] && [ "$desktop" = 1 ]; then
  command -v xcrun >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1 \
    || fail 'Desktop builds need Xcode Command Line Tools. Run xcode-select --install, or use WEB_ONLY=1.'
fi

# Never pass a stale source directory from a caller into the bootstrap.
unset DSH_BOOTSTRAP_NODE_ROOT
unset NODE_OPTIONS NODE_PATH
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
  && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)' >/dev/null 2>&1 \
  && npm --version >/dev/null 2>&1; then
  exec node "$repository/scripts/bootstrap.mjs" "$@"
fi

case "$(uname -m)" in
  arm64|aarch64) architecture=arm64 ;;
  x86_64|amd64) architecture=x64 ;;
  *) fail 'Automatic Node.js installation supports arm64 and x64; install a compatible Node.js and npm for this architecture' ;;
esac
for tool in curl tar awk mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool; install it and retry"
done
if command -v sha256sum >/dev/null 2>&1; then digest_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then digest_tool=shasum
else fail 'SHA-256 verification needs sha256sum or shasum'; fi
entry=$(awk -v suffix="-$platform-$architecture.tar.gz" \
  'NF == 2 && substr($2, length($2) - length(suffix) + 1) == suffix { row = $0; count++ } END { if (count != 1) exit 1; print row }' \
  "$repository/runtime/node-release.sha256") || fail 'Missing or ambiguous pinned Node.js release'
read -r expected archive <<EOF
$entry
EOF
[ "${#expected}" = 64 ] || fail 'Invalid pinned Node.js SHA-256'
case "$expected" in *[!0-9a-f]*) fail 'Invalid pinned Node.js SHA-256' ;; esac
case "$archive" in node-v*"-$platform-$architecture.tar.gz") ;; *) fail 'Invalid pinned Node.js filename' ;; esac
version=${archive#node-v}
version=${version%-"$platform"-"$architecture".tar.gz}
case "$version" in ''|*[!0-9.]*) fail 'Invalid pinned Node.js version' ;; esac

temporary=$(mktemp -d "${TMPDIR:-/tmp}/dsh-init.XXXXXX")
child_pid=
cleanup() {
  result=$?
  trap - 0 INT TERM
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || :
    wait "$child_pid" 2>/dev/null || :
  fi
  rm -rf -- "$temporary"
  exit "$result"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "No compatible Node.js/npm found. Downloading private Node.js ${version}…"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
  "https://nodejs.org/dist/v$version/$archive" -o "$temporary/$archive"
if [ "$digest_tool" = sha256sum ]; then actual=$(sha256sum "$temporary/$archive")
else actual=$(shasum -a 256 "$temporary/$archive"); fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail 'Node.js archive SHA-256 mismatch; nothing was executed'
tar -xzf "$temporary/$archive" -C "$temporary"
DSH_BOOTSTRAP_NODE_ROOT="$temporary/${archive%.tar.gz}"
[ -x "$DSH_BOOTSTRAP_NODE_ROOT/bin/node" ] && [ -x "$DSH_BOOTSTRAP_NODE_ROOT/bin/npm" ] \
  || fail 'Verified archive is missing Node.js or npm'
PATH="$DSH_BOOTSTRAP_NODE_ROOT/bin:$PATH"
export DSH_BOOTSTRAP_NODE_ROOT PATH
"$DSH_BOOTSTRAP_NODE_ROOT/bin/node" "$repository/scripts/bootstrap.mjs" "$@" &
child_pid=$!
if wait "$child_pid"; then result=0; else result=$?; fi
child_pid=
exit "$result"
