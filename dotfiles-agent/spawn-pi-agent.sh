#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: spawn-pi-agent.sh [-p HOST:GUEST]... [FOLDER]

  FOLDER       Path to derive room name from (default: \$PWD)
  -p HOST:GUEST  Publish host:container port (bare PORT ≡ PORT:PORT). Repeatable.
EOF
  exit 1
}

# Launch pi agent in the dotfiles-agent container, connected to a
# default room named after the given folder.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="dotfiles-agent"

# ── Parse args ───────────────────────────────────────────────────
USER_PORTS=()
FOLDER=""
while [ $# -gt 0 ]; do
  case "$1" in
  -p | --port)
    USER_PORTS+=("$2")
    shift 2
    ;;
  -*)
    usage
    ;;
  *)
    FOLDER="$1"
    shift
    ;;
  esac
done

FOLDER="$(realpath "${FOLDER:-$PWD}")"
ROOM="$(basename "$FOLDER")"
# Per-directory container name — never steals/kills another folder's container.
CONTAINER="$(bash "${SCRIPT_DIR}/container-name.sh" "${FOLDER}")"

# ── Port reconciliation (stateless — CLI is source of truth) ─────
# `-p HOST:GUEST` (bare PORT ≡ PORT:PORT). When `-p` is passed, the
# container's live mapping is compared and it is recreated to match exactly
# (safe: all durable state lives in volumes). With no `-p`, ports are
# left untouched so `agent-spawn` never clobbers an existing container.
normalize_port() {
  case "$1" in
  *:*) printf '%s\n' "$1" ;;
  *) printf '%s:%s\n' "$1" "$1" ;;
  esac
}

desired_ports() {
  local p
  for p in ${USER_PORTS[@]+"${USER_PORTS[@]}"}; do normalize_port "$p"; done | sort
}

current_ports() {
  docker inspect -f \
    '{{range $cp, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}}=>{{$cp}}{{"\n"}}{{end}}{{end}}' \
    "$1" 2>/dev/null |
    sed -e 's|/tcp||g; s|/udp||g' -e 's|=>|:|' |
    sort
}

ports_match() {
  [ "$(desired_ports)" = "$(current_ports "${CONTAINER}")" ]
}

# ── Build image if needed ────────────────────────────────────────
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "→ Building ${IMAGE} image..."
  bash "${SCRIPT_DIR}/build.sh"
fi

# ── Ensure container exists ──────────────────────────────────────
create_container() {
  echo "→ Creating container ${CONTAINER} for ${FOLDER}..."
  local PORT_ARGS=()
  local p
  for p in ${USER_PORTS[@]+"${USER_PORTS[@]}"}; do
    PORT_ARGS+=("-p" "$(normalize_port "$p")")
  done
  [ ${#USER_PORTS[@]} -gt 0 ] && echo "→ Ports: ${USER_PORTS[*]}"

  local MOUNTS=(-v "${FOLDER}:/home/agent/workspace")
  # Only bind host git/ssh config when it actually exists. A missing source
  # makes Docker auto-create a DIRECTORY, which then can't be mounted over
  # the container's existing file (~/.gitconfig is baked in by the build's
  # `git config --global protocol.version 2`) -> OCI "not a directory".
  [ -f "${HOME}/.gitconfig" ] && MOUNTS+=(-v "${HOME}/.gitconfig:/home/agent/.gitconfig:ro")
  [ -d "${HOME}/.ssh" ] && MOUNTS+=(-v "${HOME}/.ssh:/home/agent/.ssh:ro")
  MOUNTS+=(-v "agent-sessions:/home/agent/.pi/agent/sessions")

  docker run -d --name "${CONTAINER}" \
    ${PORT_ARGS[@]+"${PORT_ARGS[@]}"} \
    "${MOUNTS[@]}" \
    --entrypoint sleep \
    "${IMAGE}" \
    infinity
}

STATE="$(docker inspect -f '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || true)"

if [ -z "${STATE}" ]; then
  create_container
elif [ ${#USER_PORTS[@]} -gt 0 ] && ! ports_match; then
  echo "→ Port map changed (${USER_PORTS[*]}) — recreating ${CONTAINER}..."
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  create_container
elif [ "${STATE}" != "running" ]; then
  echo "→ Starting container ${CONTAINER}..."
  # A `docker start` failure means the container was created with a stale
  # mount (e.g. an old unconditional ~/.gitconfig bind). Recreate it rather
  # than loop on the same error — its only durable state is in the image +
  # the workspace/sessions volumes, so this is safe and self-healing.
  if ! docker start "${CONTAINER}" >/dev/null; then
    echo "→ Start failed (stale mount?) — recreating ${CONTAINER}..."
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    create_container
  fi
fi

# ── Sync local skills into the container ─────────────────────────
# Skills ship baked into the image, but a skill added/edited in the repo
# after the image was built would never reach a container — the image is
# only rebuilt on demand and the container is reused across launches.
# Overlay the repo's agent-skills/ every launch (idempotent, cheap) so
# local skills stay current; remote skills baked into the image are left
# untouched because docker cp only merges the local subdirectories over
# the top.
SKILLS_DIR="${SCRIPT_DIR}/../agent-skills"
if [ -d "${SKILLS_DIR}" ]; then
  docker exec "${CONTAINER}" mkdir -p /home/agent/.agents/skills
  docker cp "${SKILLS_DIR}/." "${CONTAINER}:/home/agent/.agents/skills/"
fi

# ── Set default room + launch pi ─────────────────────────────────
# Extensions are installed/updated at build time (Dockerfile). Don't re-run
# `pi update --extensions` here: it was a full network npm install on every
# launch. Skip the startup pi.dev version check too.
echo "→ Launching pi agent in room «${ROOM}»..."
exec docker exec -it -w /home/agent/workspace "${CONTAINER}" \
  bash -c "mkdir -p ~/.pi/agent/rooms && echo '{\"defaultRoom\":\"${ROOM}\"}' > ~/.pi/agent/rooms/config.json && export PI_SKIP_VERSION_CHECK=1; exec pi"
