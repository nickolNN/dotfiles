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

# The internal-registry CA bundle is OPTIONAL: machines that never talk to
# @kc/artifactory (public registries only) build fine without it — the
# image then ships stock CAs and the Dockerfile prints a NOTE. When it IS
# present it is baked into the trust stores. On a YADRO host, regenerate
# from the macOS keychain with:
#   security find-certificate -c "T-SPB-CA" -p /Library/Keychains/System.keychain \
#     > dotfiles-agent/certs/yadro-ca.pem
if [[ ! -s dotfiles-agent/certs/yadro-ca.pem ]]; then
  printf 'WARNING: dotfiles-agent/certs/yadro-ca.pem missing or empty —\n'
  printf '  the image will NOT trust the internal registry CA; npm ci\n'
  printf '  against @kc fails with SELF_SIGNED_CERT_IN_CHAIN.\n'
  # The Dockerfile COPYs the certs dir unconditionally; ensure it exists.
  mkdir -p dotfiles-agent/certs
fi

docker build \
  ${NO_CACHE} \
  --platform "linux/${ARCH}" \
  --build-arg "AGENT_UID=$(id -u)" \
  --build-arg "AGENT_GID=$(id -g)" \
  -t dotfiles-agent \
  -f dotfiles-agent/Dockerfile \
  .
