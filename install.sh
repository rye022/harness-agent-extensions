#!/usr/bin/env bash
# Installs the Harness Agent Extensions bundles into a DeepSeek Harness profile.
#
# Usage:
#   ./install.sh                    # profile "desktop"
#   ./install.sh --profile myprof
#   ./install.sh --dsh /path/to/dsh
#
# Put this script in the same directory as the three release tarballs:
#   harness-ext-shared-0.1.0.tgz
#   harness-ext-time-machine-0.1.0.tgz
#   harness-ext-context-os-0.1.0.tgz
#
# The script copies the shared tarball into the profile, writes the pnpm override
# that makes @harness-ext/shared resolvable, and adds both plugin tarballs.
# Restart DeepSeek Harness afterwards: bundles are mounted at startup only.
set -euo pipefail

PROFILE="desktop"
DSH_BIN=""
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?missing value for --profile}"; shift 2 ;;
    --dsh) DSH_BIN="${2:?missing value for --dsh}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; exit 1 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }

if [ -z "$DSH_BIN" ]; then
  if command -v dsh >/dev/null 2>&1; then
    DSH_BIN="$(command -v dsh)"
  elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]; then
    DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  elif [ -x "$HOME/.local/share/deepseek-harness/resources/runtime/cli/bin/dsh" ]; then
    DSH_BIN="$HOME/.local/share/deepseek-harness/resources/runtime/cli/bin/dsh"
  else
    fail "could not find the dsh launcher; pass --dsh <path>"
  fi
fi
echo "dsh:     $DSH_BIN"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
echo "profile: $PROFILE_DIR"

for file in harness-ext-shared-0.1.0.tgz harness-ext-time-machine-0.1.0.tgz harness-ext-context-os-0.1.0.tgz; do
  [ -f "$SOURCE/$file" ] || fail "missing tarball: $SOURCE/$file"
done

# Creating the profile is a side effect of any `dsh plugin --profile <name>` call.
if [ ! -d "$PROFILE_DIR" ]; then
  echo "seeding profile (first dsh plugin call creates it) ..."
  "$DSH_BIN" plugin --profile "$PROFILE" list >/dev/null || true
fi
[ -d "$PROFILE_DIR" ] || fail "profile was not created: $PROFILE_DIR"

cp "$SOURCE/harness-ext-shared-0.1.0.tgz" "$PROFILE_DIR/harness-ext-shared-0.1.0.tgz"
WORKSPACE="$PROFILE_DIR/pnpm-workspace.yaml"
[ -f "$WORKSPACE" ] || fail "missing $WORKSPACE"
if ! grep -q '@harness-ext/shared' "$WORKSPACE"; then
  printf "\noverrides:\n  '@harness-ext/shared': 'file:./harness-ext-shared-0.1.0.tgz'\n" >> "$WORKSPACE"
  echo "added the pnpm override for @harness-ext/shared"
else
  echo "pnpm override already present"
fi

"$DSH_BIN" plugin --profile "$PROFILE" add \
  "$SOURCE/harness-ext-time-machine-0.1.0.tgz" \
  "$SOURCE/harness-ext-context-os-0.1.0.tgz"

cat <<EOF

installed. Quit DeepSeek Harness completely and start it again.
Check that it works: edit a file through the agent, then look for a new line in
  $DSH_HOME_DIR/time-machine/checkpoints.jsonl
Remove everything again with:
  dsh plugin --profile $PROFILE remove @harness-ext/time-machine @harness-ext/context-os
EOF
