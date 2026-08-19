#!/usr/bin/env bash
# Bootstrap dotfiles: set env vars and install packages via Homebrew.
# Idempotent — safe to re-run.
set -euo pipefail

DOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHELL_RC="${SHELL_RC:-$HOME/.zshrc}"

# --- 1. Environment variables -------------------------------------------

ENV_VARS=(
  "PI_CODING_AGENT_DIR|\$HOME/.config/pi"
)

for entry in "${ENV_VARS[@]}"; do
  var="${entry%%|*}"
  val="${entry##*|}"
  if grep -q "^export ${var}=" "$SHELL_RC" 2>/dev/null; then
    echo "Already set in $SHELL_RC: ${var}"
  else
    echo "Adding to $SHELL_RC: export ${var}=${val}"
    printf '\nexport %s="%s"\n' "$var" "$val" >>"$SHELL_RC"
  fi
done

# --- 2. Homebrew packages ------------------------------------------------

echo ""
echo "Syncing packages from Brewfile..."
brew bundle --file="$DOT_DIR/Brewfile"

# --- 3. Pi extensions ---------------------------------------------------

if [[ -f "$HOME/.config/pi/npm/package.json" ]]; then
  echo ""
  echo "Syncing Pi extensions..."
  (
    cd "$HOME/.config/pi/npm"
    npm install --no-audit --no-fund
  )
fi

echo ""
echo "Done. Restart your shell or run 'source $SHELL_RC' to apply env vars."
