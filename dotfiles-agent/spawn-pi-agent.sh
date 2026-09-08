#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
# Launch pi agent in the dotfiles-agent container, connected to a
# default room named after the given folder.
#
# Usage: spawn-pi-agent.sh [FOLDER]
#   FOLDER  Path to derive room name from (default: $PWD)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="dotfiles-agent"
FOLDER="$(realpath "${1:-$PWD}")"
ROOM="$(basename "$FOLDER")"
# Per-directory container name — never steals/kills another folder's container.
CONTAINER="$(bash "${SCRIPT_DIR}/container-name.sh" "${FOLDER}")"

# ── Build image if needed ────────────────────────────────────────
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "→ Building ${IMAGE} image..."
  bash "${SCRIPT_DIR}/build.sh"
fi

# ── Ensure container exists ──────────────────────────────────────
STATE="$(docker inspect -f '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || true)"

if [ -z "${STATE}" ]; then
  echo "→ Creating container ${CONTAINER} for ${FOLDER}..."
  MOUNTS=(-v "${FOLDER}:/home/agent/workspace")
  # Only bind host git/ssh config when it actually exists. A missing source
  # makes Docker auto-create a DIRECTORY, which then can't be mounted over
  # the container's existing file (~/.gitconfig is baked in by the build's
  # `git config --global protocol.version 2`) -> OCI "not a directory".
  [ -f "${HOME}/.gitconfig" ] && MOUNTS+=(-v "${HOME}/.gitconfig:/home/agent/.gitconfig:ro")
  [ -d "${HOME}/.ssh" ] && MOUNTS+=(-v "${HOME}/.ssh:/home/agent/.ssh:ro")
  MOUNTS+=(-v "agent-sessions:/home/agent/.pi/agent/sessions")
  docker run -d --name "${CONTAINER}" \
    "${MOUNTS[@]}" \
    --entrypoint sleep \
    "${IMAGE}" \
    infinity
elif [ "${STATE}" != "running" ]; then
  echo "→ Starting container ${CONTAINER}..."
  docker start "${CONTAINER}" >/dev/null
fi

# ── Set default room + launch pi ─────────────────────────────────
# Extensions are installed/updated at build time (Dockerfile). Don't re-run
# `pi update --extensions` here: it was a full network npm install on every
# launch. Skip the startup pi.dev version check too.
echo "→ Launching pi agent in room «${ROOM}»..."
exec docker exec -it -w /home/agent/workspace "${CONTAINER}" \
  bash -c "mkdir -p ~/.pi/agent/rooms && echo '{\"defaultRoom\":\"${ROOM}\"}' > ~/.pi/agent/rooms/config.json && export PI_SKIP_VERSION_CHECK=1; exec pi"
