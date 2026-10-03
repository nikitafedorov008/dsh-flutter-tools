#!/bin/sh
# =============================================================================
# rollback-local-plugin.sh - undoes install-local-plugin.sh.
#
#   Restores package.json / pnpm-workspace.yaml / pnpm-lock.yaml from the
#   snapshot taken at install time and re-runs pnpm install.
#
#   Quit DeepSeek Harness first (refuses otherwise; ALLOW_RUNNING=1 overrides).
# =============================================================================
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE_DIR=${PROFILE_DIR:-"$HOME/.dsh/profiles/desktop"}
SNAPSHOT_DIR=${SNAPSHOT_DIR:-"$SCRIPT_DIR/.fix-snapshot-local-plugin"}
DSH_APP_DIR=${DSH_APP_DIR:-"/Applications/DeepSeek Harness.app"}
NODE_BIN=${DSH_NODE_BIN:-"$DSH_APP_DIR/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"}
PNPM_CLI=${DSH_PNPM_CLI:-"$DSH_APP_DIR/Contents/Resources/runtime/pnpm/dist/pnpm.mjs"}
ALLOW_RUNNING=${ALLOW_RUNNING:-0}
GUARD_PATTERN="DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
SNAPSHOT_FILES="package.json pnpm-workspace.yaml pnpm-lock.yaml"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$SNAPSHOT_DIR" ] || die "no snapshot at $SNAPSHOT_DIR - nothing to roll back"

if [ "$ALLOW_RUNNING" != "1" ] && command -v pgrep >/dev/null 2>&1; then
  if pgrep -f "$GUARD_PATTERN" >/dev/null 2>&1; then
    say "REFUSING: DeepSeek Harness is running. Quit it and re-run."
    exit 10
  fi
fi

say "== restore =="
for f in $SNAPSHOT_FILES; do
  cp -p "$SNAPSHOT_DIR/$f" "$PROFILE_DIR/$f"
  say "  restored $f"
done
if [ -f "$SNAPSHOT_DIR/target.txt" ]; then
  say "  was: $(head -n 1 "$SNAPSHOT_DIR/target.txt") ($(tail -n 1 "$SNAPSHOT_DIR/target.txt"))"
fi

say "== pnpm install =="
( cd "$PROFILE_DIR" && "$NODE_BIN" "$PNPM_CLI" install ) 2>&1 | tail -n 12 | sed 's/^/  /'

say "done. Start DeepSeek Harness."
