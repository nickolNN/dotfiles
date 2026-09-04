#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: attach.sh [-p PORT] [--build] [--no-install] [FOLDER] [-- CMD...]

  FOLDER      Path to mount as /home/agent/workspace (default: \$PWD)
  -p PORT     Expose port (e.g. -p 3000:3000). Repeatable.
  --build     Force rebuild the image even if it exists.
  --no-install  Skip auto npm install when package.json detected.
  CMD         Command to run (default: bash). Use "pi" for pi agent.
EOF
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="dotfiles-agent"

# ── Parse args ───────────────────────────────────────────────────
USER_PORTS=()
FORCE_BUILD=false
NO_INSTALL=false
FOLDER=""

while [ $# -gt 0 ]; do
  case "$1" in
  -p | --port)
    USER_PORTS+=("$2")
    shift 2
    ;;
  --build)
    FORCE_BUILD=true
    shift
    ;;
  --no-install)
    NO_INSTALL=true
    shift
    ;;
  --)
    shift
    break
    ;;
  -*)
    usage
    ;;
  *)
    if [ -z "${FOLDER}" ]; then
      FOLDER="$1"
      shift
    else
      break
    fi
    ;;
  esac
done

FOLDER="$(realpath "${FOLDER:-$PWD}")"
CMD=("${@:-bash}")
# Per-directory container name — never steals/kills another folder's container.
CONTAINER="$(bash "${SCRIPT_DIR}/container-name.sh" "${FOLDER}")"

# ── Build image if needed ────────────────────────────────────────
if [ "${FORCE_BUILD}" = true ] || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "→ Building ${IMAGE} image..."
  bash "${SCRIPT_DIR}/build.sh"
fi

# ── Ensure container exists ──────────────────────────────────────
STATE="$(docker inspect -f '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || true)"

if [ -z "${STATE}" ]; then
  PORT_ARGS=()
  if [ ${#USER_PORTS[@]} -gt 0 ]; then
    for port in "${USER_PORTS[@]}"; do
      PORT_ARGS+=("-p" "${port}:${port}")
    done
  fi

  echo "→ Creating container ${CONTAINER} for ${FOLDER}..."
  [ ${#PORT_ARGS[@]} -gt 0 ] && echo "→ Ports: ${USER_PORTS[*]}"

  docker run -d --name "${CONTAINER}" \
    ${PORT_ARGS[@]+"${PORT_ARGS[@]}"} \
    -v "${FOLDER}:/home/agent/workspace" \
    -v "${HOME}/.gitconfig:/home/agent/.gitconfig:ro" \
    -v "${HOME}/.ssh:/home/agent/.ssh:ro" \
    -v "agent-sessions:/home/agent/.pi/agent/sessions" \
    --entrypoint sleep \
    "${IMAGE}" \
    infinity

elif [ "${STATE}" != "running" ]; then
  echo "→ Starting container ${CONTAINER}..."
  docker start "${CONTAINER}" >/dev/null
fi

# ── Auto npm install ─────────────────────────────────────────────
if [ "${NO_INSTALL}" = false ] &&
  [ -f "${FOLDER}/package.json" ] &&
  [ ! -d "${FOLDER}/node_modules" ]; then
  echo "→ Installing npm dependencies..."
  docker exec -w /home/agent/workspace "${CONTAINER}" \
    bash -c 'corepack enable 2>/dev/null; npm install --legacy-peer-deps'
fi

# ── Attach ───────────────────────────────────────────────────────
echo "→ Attaching to ${CONTAINER}..."
exec docker exec -it -w /home/agent/workspace "${CONTAINER}" "${CMD[@]}"
