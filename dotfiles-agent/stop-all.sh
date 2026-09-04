#!/usr/bin/env bash
set -euo pipefail

# Stop and remove every container created from the dotfiles-agent
# image (one per directory spawned via spawn-pi-agent.sh/attach.sh).

IMAGE="dotfiles-agent"
CONTAINERS="$(docker ps -aq --filter "ancestor=${IMAGE}" 2>/dev/null || true)"

if [ -z "${CONTAINERS}" ]; then
  echo "→ No ${IMAGE} containers found."
  exit 0
fi

for CONTAINER in ${CONTAINERS}; do
  NAME="$(docker inspect -f '{{.Name}}' "${CONTAINER}" | sed 's|^/||')"
  echo "→ Stopping ${NAME}..."
  docker stop "${CONTAINER}" >/dev/null
  docker rm "${CONTAINER}" >/dev/null
  echo "✓ ${NAME} stopped and removed."
done
