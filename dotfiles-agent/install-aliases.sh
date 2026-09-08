#!/usr/bin/env bash
set -euo pipefail

# Installs zsh aliases for the dotfiles-agent scripts.
# Idempotent: re-running REPLACES the managed block (markers + aliases),
# so paths stay correct if the repo moves. No other ~/.zshrc lines touched.
#
# Adds:
#   agent-spawn  -> spawn-pi-agent.sh "$PWD"
#   agent-attach -> attach.sh "$PWD"
#   agent-stop   -> stop-all.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"
BEGIN="# >>> dotfiles-agent aliases (managed) >>>"
END="# <<< dotfiles-agent aliases (managed) <<<"

# \"\$PWD\" stays literal so the alias expands $PWD at *call* time,
# not when this installer runs.
ALIASES=(
  "alias agent-spawn='${SCRIPT_DIR}/spawn-pi-agent.sh \"\$PWD\"'"
  "alias agent-attach='${SCRIPT_DIR}/attach.sh \"\$PWD\"'"
  "alias agent-stop='${SCRIPT_DIR}/stop-all.sh'"
)

block="$(mktemp)"
tmp="$(mktemp)"
trap 'rm -f "$block" "$tmp"' EXIT
{
  printf '%s\n' "$BEGIN"
  printf '%s\n' "${ALIASES[@]}"
  printf '%s\n' "$END"
} >"$block"

mkdir -p "$(dirname "$ZSHRC")"
touch "$ZSHRC"

if grep -qF "$BEGIN" "$ZSHRC"; then
  # Drop the old managed block (markers and everything between), then
  # append a fresh one below. awk index() avoids regex-special markers.
  awk -v b="$BEGIN" -v e="$END" '
    index($0, b) == 1 { drop = 1; next }
    drop && index($0, e) == 1 { drop = 0; next }
    !drop { print }
  ' "$ZSHRC" >"$tmp"
  mv "$tmp" "$ZSHRC"
  echo "→ Updated existing dotfiles-agent aliases in ${ZSHRC}"
else
  echo "→ Added dotfiles-agent aliases to ${ZSHRC}"
fi

# Separate the appended block from any existing content.
if [ -s "$ZSHRC" ]; then
  [ "$(tail -c1 "$ZSHRC")" = "" ] || printf '\n' >>"$ZSHRC"
  printf '\n' >>"$ZSHRC"
fi
cat "$block" >>"$ZSHRC"

echo "✓ agent-spawn, agent-attach, agent-stop"
echo "  Reload with: source ${ZSHRC}   (or open a new terminal)"
