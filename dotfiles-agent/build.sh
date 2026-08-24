#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')

docker build \
  --platform "linux/${ARCH}" \
  --build-arg "AGENT_UID=$(id -u)" \
  --build-arg "AGENT_GID=$(id -g)" \
  -t dotfiles-agent \
  -f dotfiles-agent/Dockerfile \
  .
