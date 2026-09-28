#!/bin/sh
# Minimal recovery dispatch when the command's Node interpreter no longer works.
set -eu
repository=$1
installation=$2
shift 2
if [ "${1:-}" = --dir ]; then
  [ -n "${2:-}" ] || { printf '%s\n' '--dir requires a directory' >&2; exit 1; }
  installation=$2
  shift 2
fi
if [ "${1:-}" != update ]; then
  printf '%s\n' 'Node.js is unavailable. Run make init in the repository, or dhp update, to repair this installation.' >&2
  exit 1
fi
shift
case "$#:${1:-}" in
  0:) set -- ;;
  1:--rebuild) set -- --rebuild-app ;;
  *) printf '%s\n' 'Usage: dhp [--dir DIR] update [--rebuild]' >&2; exit 1 ;;
esac
# Make-specific options from a caller must not select a different installation.
unset DSH_INIT_DIR DSH_INIT_WEB_ONLY DSH_INIT_MARKETPLACE DSH_INIT_RESUME DSH_INIT_REBUILD
exec /bin/sh "$repository/scripts/init.sh" --dir "$installation" "$@"
