#!/bin/sh
# =============================================================================
# install-local-plugin.sh - mounts a LOCAL plugin package into a DSH profile.
#
# install-plugin.sh only accepts npm specs (name@version). This handles the
# other case: a plugin you develop on disk. It links the directory into the
# profile, appends the package to dsh.profile.bundles (without that the plugin
# stays installed but dormant) and runs pnpm install.
#
#   Usage:
#       sh install-local-plugin.sh ~/Projects/dsh-flutter-tools
#       sh install-local-plugin.sh <dir> --name <package-name>   # override
#
#   Quit DeepSeek Harness first (refuses otherwise; ALLOW_RUNNING=1 overrides).
#   Undo with: sh rollback-local-plugin.sh
#
#   Env overrides: PROFILE_DIR, SNAPSHOT_DIR, DSH_APP_DIR, DSH_NODE_BIN,
#                  DSH_PNPM_CLI, ALLOW_RUNNING
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

[ "$#" -gt 0 ] || die "usage: sh install-local-plugin.sh <plugin-dir> [--name <package-name>]"

SRC=$1
NAME=""
if [ "${2:-}" = "--name" ]; then
  NAME=${3:-}
  [ -n "$NAME" ] || die "--name needs a value"
fi

[ -d "$SRC" ] || die "plugin directory not found: $SRC"
SRC_ABS=$(CDPATH= cd -- "$SRC" && pwd)
[ -f "$SRC_ABS/package.json" ] || die "no package.json in $SRC_ABS"
[ -f "$SRC_ABS/cordis.patch.yml" ] || say "WARNING: no cordis.patch.yml - the plugin will not mount as a bundle"
[ -f "$SRC_ABS/client.js" ] && [ -f "$SRC_ABS/index.js" ] || say "WARNING: index.js/client.js missing"

if [ -z "$NAME" ]; then
  NAME=$("$NODE_BIN" -p "require('$SRC_ABS/package.json').name")
fi
case "$NAME" in
  */*) die "'$NAME' looks scoped/odd - pass --name explicitly if that is intended" ;;
esac

if [ "$ALLOW_RUNNING" != "1" ] && command -v pgrep >/dev/null 2>&1; then
  if pgrep -f "$GUARD_PATTERN" >/dev/null 2>&1; then
    say "REFUSING: DeepSeek Harness is running."
    say "  pnpm rewrites node_modules of a live process. Quit DeepSeek Harness,"
    say "  run this script again, then start DeepSeek Harness."
    exit 10
  fi
fi

[ -x "$NODE_BIN" ] || die "node executable not found: $NODE_BIN"
[ -f "$PNPM_CLI" ] || die "pnpm CLI not found: $PNPM_CLI"

say "== plugin =="
say "  name: $NAME"
say "  path: $SRC_ABS"

say "== snapshot =="
umask 077
mkdir -p "$SNAPSHOT_DIR"
for f in $SNAPSHOT_FILES; do
  cp -p "$PROFILE_DIR/$f" "$SNAPSHOT_DIR/$f"
  say "  saved $f"
done
printf '%s\n%s\n' "$NAME" "$SRC_ABS" > "$SNAPSHOT_DIR/target.txt"

say "== manifest =="
"$NODE_BIN" -e "
const { readFileSync, writeFileSync } = require('node:fs')
const [file, name, target] = process.argv.slice(1)
const json = JSON.parse(readFileSync(file, 'utf8'))
json.dependencies = json.dependencies || {}
const before = json.dependencies[name]
json.dependencies[name] = 'link:' + target
const bundles = json.dsh?.profile?.bundles
let bundled = 'n/a'
if (Array.isArray(bundles)) {
  if (!bundles.includes(name)) { bundles.push(name); bundled = 'appended' } else { bundled = 'already listed' }
}
writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
console.log('  ' + name + ': ' + (before === undefined ? '(new)' : before) + ' -> link:' + target + ' | bundles: ' + bundled)
" "$PROFILE_DIR/package.json" "$NAME" "$SRC_ABS" || die "could not rewrite package.json"

say "== pnpm install =="
LOG="$SNAPSHOT_DIR/pnpm-install.log"
: > "$LOG"
set +e
( cd "$PROFILE_DIR" && "$NODE_BIN" "$PNPM_CLI" install ) >>"$LOG" 2>&1
rc=$?
set -e
tail -n 15 "$LOG" | sed 's/^/  /'
[ "$rc" = "0" ] || die "pnpm install failed (rc=$rc) - see $LOG"

say "== checks =="
say "  linked dir: $(ls -ld "$PROFILE_DIR/node_modules/$NAME" 2>/dev/null | awk '{print $NF}')"
say "  bundle list: $("$NODE_BIN" -e "const j=require('$PROFILE_DIR/package.json');process.stdout.write(j.dsh.profile.bundles.includes('$NAME')?'contains $NAME':'MISSING')")"
say "  plugin row: $(grep -c "$NAME" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null || echo 0) mention(s) in cordis.patch.yml"
say ""
say "Next: start DeepSeek Harness. The plugin's bundle patch mounts itself;"
say "the Flutter page appears in the sidebar's + menu."
say "Undo: sh $SCRIPT_DIR/rollback-local-plugin.sh"
