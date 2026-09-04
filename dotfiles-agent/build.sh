#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

NO_CACHE=""
if [[ "${1:-}" == "--no-cache" || "${1:-}" == "-n" ]]; then
  NO_CACHE="--no-cache"
fi

ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')

docker build \
  ${NO_CACHE} \
  --platform "linux/${ARCH}" \
  --build-arg "AGENT_UID=$(id -u)" \
  --build-arg "AGENT_GID=$(id -g)" \
  -t dotfiles-agent \
  -f dotfiles-agent/Dockerfile \
  .
