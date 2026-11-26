#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: attach.sh [-p HOST:GUEST]... [--network-host] [--build] [FOLDER] [-- CMD...]

  FOLDER      Path to mount as /home/agent/workspace (default: \$PWD)
  -p HOST:GUEST  Publish host:container port (bare PORT ≡ PORT:PORT). Repeatable.
  --network-host  Use host network (all container ports exposed, no -p needed).
  --build     Force rebuild the image even if it exists.
  CMD         Command to run (default: bash). Use "pi" for pi agent.

  Env: AGENT_DOCKER_ARGS="…"  raw extra `docker run` arguments, applied when
       the container is created (--dns, --add-host, -e HTTP_PROXY=…,
       --cap-add/--device). Changing it recreates the container, like -p does.
       Word-split: an argument must not contain spaces.
EOF
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="dotfiles-agent"

# ── Parse args ───────────────────────────────────────────────────
USER_PORTS=()
NETWORK_HOST=false
FORCE_BUILD=false
FOLDER=""

while [ $# -gt 0 ]; do
  case "$1" in
  -p | --port)
    USER_PORTS+=("$2")
    shift 2
    ;;
  --network-host)
    NETWORK_HOST=true
    shift
    ;;
  --build)
    FORCE_BUILD=true
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

# ── Guards ───────────────────────────────────────────────────────
if [ "${NETWORK_HOST}" = true ] && [ ${#USER_PORTS[@]} -gt 0 ]; then
  echo "ERROR: --network-host and -p are incompatible. With host networking," >&2
  echo "       all container ports are already on the host — drop -p." >&2
  exit 1
fi

FOLDER="$(realpath "${FOLDER:-$PWD}")"
CMD=("${@:-bash}")
# Per-directory container name — never steals/kills another folder's container.
CONTAINER="$(bash "${SCRIPT_DIR}/container-name.sh" "${FOLDER}")"
ROOM="$(basename "${FOLDER}")"

# ── Port reconciliation (stateless — CLI is source of truth) ─────
# `-p HOST:GUEST` (bare PORT ≡ PORT:PORT). When `-p` is passed, the
# container's live mapping is compared and it is recreated to match exactly
# (safe: all durable state lives in volumes). With no `-p`, ports are
# left untouched so `agent-attach` never clobbers an existing container.
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

current_network() {
  docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null || echo ""
}

network_match() {
  local cur="$(current_network "${CONTAINER}")"
  if [ "${NETWORK_HOST}" = true ]; then
    [ "${cur}" = "host" ]
  else
    [ "${cur}" != "host" ]
  fi
}

# ── AGENT_DOCKER_ARGS: host-specific escape hatch ────────────────
# Extra `docker run` flags can only take effect when the container is CREATED,
# so a change must recreate it — same rule as ports and network mode. Docker
# cannot be asked "which flags did you start with", therefore the value is
# hashed into a label at create time and the hash is compared on every launch.
# No flags are validated here: this is deliberately the un-shaped hole for
# options the script does not know about (corporate DNS, proxy env, a tun
# device for an in-container VPN client).
# The hash is empty when the variable is unset, which is also what `docker
# inspect` reports for a container created without the label — so existing
# containers are NOT recreated just because this feature was added.
docker_args_hash() {
  local raw
  raw="$(printf '%s' "${AGENT_DOCKER_ARGS:-}" | tr -s '[:space:]' ' ')"
  raw="${raw# }"; raw="${raw% }"
  [ -z "$raw" ] && return 0
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$raw" | shasum -a 256 | cut -d' ' -f1
  else
    printf '%s' "$raw" | sha256sum | cut -d' ' -f1
  fi
}

current_docker_args_hash() {
  docker inspect -f '{{ index .Config.Labels "agent.docker-args-hash" }}' \
    "$1" 2>/dev/null | tr -d '[:space:]' || true
}

docker_args_match() {
  [ "$(current_docker_args_hash "${CONTAINER}")" = "$(docker_args_hash)" ]
}

# The node_modules volume is retired: a container created before that still
# mounts a persistent tree the scripts no longer create, so recreate it once to
# take the tmpfs. Same rule as ports/network/args — a mount is fixed at create.
node_modules_shadowed() {
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/agent/workspace/node_modules"}}{{.Type}}{{end}}{{end}}' "${CONTAINER}" 2>/dev/null)" = "tmpfs" ]
}

# ── Build image if needed ────────────────────────────────────────
if [ "${FORCE_BUILD}" = true ] || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "→ Building ${IMAGE} image..."
  bash "${SCRIPT_DIR}/build.sh"
fi

# ── Ensure container exists ──────────────────────────────────────
STATE="$(docker inspect -f '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || true)"
NEED_CREATE=false

if [ -z "${STATE}" ]; then
  NEED_CREATE=true
elif [ ${#USER_PORTS[@]} -gt 0 ] && ! ports_match; then
  echo "→ Port map changed (${USER_PORTS[*]}) — recreating ${CONTAINER}..."
  docker rm -f "${CONTAINER}" >/dev/null
  NEED_CREATE=true
elif ! network_match; then
  cur_net="$(current_network "${CONTAINER}")"
  echo "→ Network mode changed (${cur_net} → host) — recreating ${CONTAINER}..."
  docker rm -f "${CONTAINER}" >/dev/null
  NEED_CREATE=true
elif ! node_modules_shadowed; then
  echo "→ node_modules is no longer a volume — recreating ${CONTAINER}..."
  echo "   ⚠ Any agent running in this container is killed by the recreate."
  docker rm -f "${CONTAINER}" >/dev/null
  NEED_CREATE=true
elif ! docker_args_match; then
  echo "→ AGENT_DOCKER_ARGS changed (${AGENT_DOCKER_ARGS:-<unset>}) — recreating ${CONTAINER}..."
  echo "   ⚠ Any agent running in this container is killed by the recreate."
  docker rm -f "${CONTAINER}" >/dev/null
  NEED_CREATE=true
fi

if [ "${NEED_CREATE}" = true ]; then
  PORT_ARGS=()
  for p in ${USER_PORTS[@]+"${USER_PORTS[@]}"}; do
    PORT_ARGS+=("-p" "$(normalize_port "$p")")
  done

  echo "→ Creating container ${CONTAINER} for ${FOLDER}..."
  [ ${#USER_PORTS[@]} -gt 0 ] && echo "→ Ports: ${USER_PORTS[*]}"

  MOUNTS=(-v "${FOLDER}:/home/agent/workspace")

  # Shadow the host's node_modules (plus anything in AGENT_SHADOW_DIRS) with a
  # tmpfs: the host copy may hold macOS-built native modules (node-gyp) that
  # break on Linux, and virtiofs IO is ~10-22x slower than the VM's tmpfs for
  # small files. A tmpfs dies with the container, so a stale install cannot
  # survive a rebuild. AGENT_SHADOW_DIRS: space-separated workspace-relative
  # names; the mount is agent-owned, else installs hit EACCES.
  for dir in node_modules ${AGENT_SHADOW_DIRS:-}; do
    [ -n "$dir" ] || continue
    MOUNTS+=(--tmpfs "/home/agent/workspace/${dir}:exec,uid=$(id -u),gid=$(id -g),mode=755")
  done

  # Only bind host git/ssh config when it actually exists. A missing source
  # makes Docker auto-create a DIRECTORY that can't mount over the image's
  # baked-in ~/.gitconfig file -> OCI "not a directory".
  [ -f "${HOME}/.gitconfig" ] && MOUNTS+=(-v "${HOME}/.gitconfig:/home/agent/.gitconfig:ro")
  [ -d "${HOME}/.ssh" ] && MOUNTS+=(-v "${HOME}/.ssh:/home/agent/.ssh:ro")
  # Sessions and long-term memory are both one shared volume per name, so
  # every room's agent sees the same history and the same brain. The image
  # pre-creates both dirs so a fresh volume is seeded agent-owned.
  MOUNTS+=(-v "agent-sessions:/home/agent/.pi/agent/sessions")
  MOUNTS+=(-v "agent-memory:/home/agent/.pi/agent/memory")
  MOUNTS+=(-v "agent-rooms:/home/agent/.pi/agent/rooms")

  NET_ARGS=()
  if [ "${NETWORK_HOST}" = true ]; then
    NET_ARGS+=(--network host)
  fi

  # Word-split on purpose: `-e HTTP_PROXY=http://host.docker.internal:3128`
  # becomes two argv entries, which is exactly how docker wants it.
  EXTRA_ARGS=()
  for a in ${AGENT_DOCKER_ARGS:-}; do EXTRA_ARGS+=("$a"); done
  # Record what was applied so the next launch can tell unchanged from
  # "the host changed its mind". An empty value is fine and means "nothing".
  NET_ARGS+=(--label "agent.docker-args-hash=$(docker_args_hash)")

  docker run -d --name "${CONTAINER}" \
    --init \
    ${PORT_ARGS[@]+"${PORT_ARGS[@]}"} \
    ${NET_ARGS[@]+"${NET_ARGS[@]}"} \
    ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
    "${MOUNTS[@]}" \
    --entrypoint sleep \
    "${IMAGE}" \
    infinity

elif [ "${STATE}" != "running" ]; then
  echo "→ Starting container ${CONTAINER}..."
  docker start "${CONTAINER}" >/dev/null
fi

# ── Sync local skills into the container ─────────────────────────
# Skills ship baked into the image, but a skill added/edited in the repo
# after the image was built would never reach a container — the image is
# only rebuilt on demand and the container is reused across launches.
# Overlay the repo's agent-skills/ every launch (idempotent, cheap) so
# local skills stay current; remote skills baked into the image (and any
# files pi wrote there) are left untouched because docker cp only merges
# the local subdirectories over the top.
SKILLS_DIR="${SCRIPT_DIR}/../agent-skills"
if [ -d "${SKILLS_DIR}" ]; then
  docker exec "${CONTAINER}" mkdir -p /home/agent/.agents/skills
  docker cp "${SKILLS_DIR}/." "${CONTAINER}:/home/agent/.agents/skills/"
fi

# Remote skills are baked at build time and the repo overlay cannot add them,
# so a skill that entered the Dockerfile list after the last image build is
# missing here in silence. Make it a warning (never a failure) — pipeline step
# prompts inject those files and an empty injection is invisible otherwise.
"${SCRIPT_DIR}/check-remote-skills.sh" "${CONTAINER}" || true

# ── Attach ───────────────────────────────────────────────────────
echo "→ Attaching to ${CONTAINER}..."
exec docker exec -it -w /home/agent/workspace -e "PI_AGENT_ROOM=${ROOM}" "${CONTAINER}" "${CMD[@]}"
