#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

NO_CACHE=""
if [[ "${1:-}" == "--no-cache" || "${1:-}" == "-n" ]]; then
  NO_CACHE="--no-cache"
fi

ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')

# ── Preflight: gitignored host files the image depends on ────────
# These hold secrets and are intentionally not committed. A build without
# models.json produces an unusable agent, and mcp.json is rewritten by the
# image build — fail fast rather than halfway through a long build.
missing=0
for f in pi/models.json pi/mcp.json; do
  if [[ ! -f "$f" ]]; then
    printf 'ERROR: %s is missing (gitignored, host-specific).\n' "$f"
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  printf 'Create the missing file(s) on the host, then rebuild.\n'
  exit 1
fi

# ── Preflight: extra CA drop folder ───────────────────────────────
# The image build COPYs dotfiles-agent/certs/, so the folder has to exist — but
# being EMPTY is a legitimate state on a machine with no corporate CA (its
# contents are gitignored; only .gitkeep is tracked). mkdir keeps `COPY` from
# failing on a fresh clone, and the count below is informational, never fatal.
mkdir -p dotfiles-agent/certs
ca_count=0
ca_key=""
while IFS= read -r f; do
  if grep -qs -e "-----BEGIN .*PRIVATE KEY-----" "$f"; then ca_key="$f"; continue; fi
  ca_count=$((ca_count + 1))
  printf 'CA: will trust %s\n' "$f"
done < <(find dotfiles-agent/certs -maxdepth 1 -type f \( -name '*.pem' -o -name '*.crt' \) | sort)

# A private key here is skipped by the Dockerfile loop, but it means the folder
# is used wrongly and a secret is sitting in a build context — stop and say so.
if [ -n "$ca_key" ]; then
  printf 'ERROR: %s contains a PRIVATE KEY.\n' "$ca_key" >&2
  printf '       Only certificates belong in dotfiles-agent/certs/.\n' >&2
  exit 1
fi
if [ "$ca_count" -eq 0 ]; then
  printf 'CA: none in dotfiles-agent/certs/ — using the standard Debian store.\n'
fi

docker build \
  ${NO_CACHE} \
  --platform "linux/${ARCH}" \
  --build-arg "AGENT_UID=$(id -u)" \
  --build-arg "AGENT_GID=$(id -g)" \
  -t dotfiles-agent \
  -f dotfiles-agent/Dockerfile \
  .
