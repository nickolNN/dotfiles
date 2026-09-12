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

docker build \
  ${NO_CACHE} \
  --platform "linux/${ARCH}" \
  --build-arg "AGENT_UID=$(id -u)" \
  --build-arg "AGENT_GID=$(id -g)" \
  -t dotfiles-agent \
  -f dotfiles-agent/Dockerfile \
  .
