#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: attach.sh [-p HOST:GUEST]... [--build] [--no-install] [FOLDER] [-- CMD...]

  FOLDER      Path to mount as /home/agent/workspace (default: \$PWD)
  -p HOST:GUEST  Publish host:container port (bare PORT ≡ PORT:PORT). Repeatable.
  --build     Force rebuild the image even if it exists.
  --no-install  Skip auto dependency install when package.json detected.
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
fi

if [ "${NEED_CREATE}" = true ]; then
  PORT_ARGS=()
  for p in ${USER_PORTS[@]+"${USER_PORTS[@]}"}; do
    PORT_ARGS+=("-p" "$(normalize_port "$p")")
  done

  echo "→ Creating container ${CONTAINER} for ${FOLDER}..."
  [ ${#USER_PORTS[@]} -gt 0 ] && echo "→ Ports: ${USER_PORTS[*]}"

  # Only bind host git/ssh config when it actually exists. A missing source
  # makes Docker auto-create a DIRECTORY that can't mount over the image's
  # baked-in ~/.gitconfig file -> OCI "not a directory".
  MOUNTS=(-v "${FOLDER}:/home/agent/workspace")

  # Shadow the host's node_modules with a PERSISTENT named volume keyed by
  # the derived container name. Two reasons the host copy must stay hidden:
  # it may hold macOS-built native modules (node-gyp) that break on Linux,
  # and virtiofs IO is ~10-22x slower than the VM's ext4 for small files.
  # volume-nocopy is essential: without it Docker would seed the fresh
  # volume from the virtiofs content — copying the macOS tree into Linux.
  # A fresh nocopy volume comes up root-owned, so chown it via a root exec
  # (cheap: only when the uid actually mismatches).
  MOUNTS+=(--mount "type=volume,source=agent-node-modules-${CONTAINER},target=/home/agent/workspace/node_modules,volume-nocopy=true")

  # Other host-only dirs stay on tmpfs (throwaway by design).
  # Extend via AGENT_SHADOW_DIRS: space-separated workspace-relative names.
  for dir in ${AGENT_SHADOW_DIRS:-}; do
    [ -n "$dir" ] || continue
    MOUNTS+=(--tmpfs "/home/agent/workspace/${dir}:exec,uid=$(id -u),gid=$(id -g),mode=755")
  done

  [ -f "${HOME}/.gitconfig" ] && MOUNTS+=(-v "${HOME}/.gitconfig:/home/agent/.gitconfig:ro")
  [ -d "${HOME}/.ssh" ] && MOUNTS+=(-v "${HOME}/.ssh:/home/agent/.ssh:ro")
  # Sessions and long-term memory are both one shared volume per name, so
  # every room's agent sees the same history and the same brain. The image
  # pre-creates both dirs so a fresh volume is seeded agent-owned.
  MOUNTS+=(-v "agent-sessions:/home/agent/.pi/agent/sessions")
  MOUNTS+=(-v "agent-memory:/home/agent/.pi/agent/memory")
  # Durable caches (npm cache, jest cache via TMPDIR, qmd models) — one
  # shared volume, seeded from the image's agent-owned dir on first use.
  MOUNTS+=(-v "agent-cache:/home/agent/.cache")

  # Memory ceiling: the VM has no swap and rooms have hit 8 concurrent
  # agents (jest 1.5G x8 + node > 11.9G RAM -> VM-wide SIGKILL storms).
  # A per-container limit makes a runaway killable *inside* its own
  # container instead of taking the whole VM down. Override with
  # AGENT_MEMORY_LIMIT (empty string = no limit).
  MEM_ARGS=()
  [ -n "${AGENT_MEMORY_LIMIT-10g}" ] && MEM_ARGS=(--memory="${AGENT_MEMORY_LIMIT-10g}")
  docker run -d --name "${CONTAINER}" \
    ${MEM_ARGS[@]+"${MEM_ARGS[@]}"} \
    ${PORT_ARGS[@]+"${PORT_ARGS[@]}"} \
    "${MOUNTS[@]}" \
    --entrypoint sleep \
    "${IMAGE}" \
    infinity

  # Fix root-owned fresh volume (see note above); stat-first so the
  # common case costs one exec and no recursive chown.
  docker exec -u root "${CONTAINER}" bash -c \
    "[ \"\$(stat -c %u /home/agent/workspace/node_modules)\" = \"$(id -u)\" ] || chown -R $(id -u):$(id -g) /home/agent/workspace/node_modules"

elif [ "${STATE}" != "running" ]; then
  echo "→ Starting container ${CONTAINER}..."
  docker start "${CONTAINER}" >/dev/null
fi

# ── Sync patched pi extensions into the container ─────────────
# Pi config (settings.json, models.json, extensions/) is baked at build
# time via `COPY pi/`, so an extension patched in the repo after the last
# build never reaches a reused container. docker cp the whole dir every
# launch — pi auto-discovers *.ts and <name>/index.ts subdirectory
# packages, so a vendored package lands too. permissions.ts stays
# excluded — the image deliberately removes it (re-drop after the cp).
PI_EXT_DIR="${SCRIPT_DIR}/../pi/extensions"
if [ -d "${PI_EXT_DIR}" ]; then
  docker exec "${CONTAINER}" mkdir -p /home/agent/.pi/agent/extensions
  docker cp "${PI_EXT_DIR}/." "${CONTAINER}:/home/agent/.pi/agent/extensions/"
  docker exec "${CONTAINER}" rm -f /home/agent/.pi/agent/extensions/permissions.ts
fi

# Vendored patches for installed pi packages (e.g. pi-memory). Drop files
# at pi/npm-patches/<pkg>/ and they merge onto
# ~/.pi/agent/npm/node_modules/<pkg>/ on every launch — same re-sync
# idea as extensions, for package fixes that cannot wait for an upstream
# release or an image rebuild. Merge semantics (like skills): removing a
# patched file needs manual cleanup inside the container.
PI_PATCH_DIR="${SCRIPT_DIR}/../pi/npm-patches"
if [ -d "${PI_PATCH_DIR}" ]; then
  for pkg in "${PI_PATCH_DIR}"/*; do
    [ -d "$pkg" ] || continue
    docker cp "${pkg}/." "${CONTAINER}:/home/agent/.pi/agent/npm/node_modules/$(basename "$pkg")/"
  done
fi

# ── node_modules staleness guard ─────────────────────────────────
# A persisted-but-stale node_modules is worse than an empty one. npm does
# not record the source lock's hash in node_modules/.package-lock.json,
# so keep a marker file on the volume and combine it with an mtime check.
docker exec "${CONTAINER}" bash -c '
  nm=/home/agent/workspace/node_modules
  lock=/home/agent/workspace/package-lock.json
  [ -f "$lock" ] || exit 0
  [ -d "$nm" ] || exit 0
  h_new=$(sha256sum "$lock" | cut -d" " -f1)
  marker="$nm/.dotfiles-agent-lock-hash"
  h_old=$(cat "$marker" 2>/dev/null || true)
  if [ ! -f "$nm/.package-lock.json" ]; then
    if [ -n "$(ls -A "$nm" 2>/dev/null)" ]; then
      echo "⚠ node_modules has content but no .package-lock.json — run: npm ci"
    else
      echo "⚠ node_modules volume is EMPTY — run: npm ci"
    fi
  elif [ -n "$h_old" ] && [ "$h_new" != "$h_old" ] && \
       [ "$lock" -nt "$nm/.package-lock.json" ]; then
    echo "⚠ package-lock.json changed since node_modules was installed — run: npm ci"
  fi
  echo "$h_new" > "$marker" 2>/dev/null || true
' || true

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

# ── Auto dependency install ────────────────────────────────────
# Prefer bun (in-image, ~5-10× faster than npm); fall back to npm.
# node_modules is now a container-private volume — check inside the
# container (not the host) to decide whether to install.
if [ "${NO_INSTALL}" = false ] &&
  [ -f "${FOLDER}/package.json" ] &&
  docker exec "${CONTAINER}" bash -c '[ -z "$(ls -A /home/agent/workspace/node_modules 2>/dev/null)" ]'; then
  echo "→ Installing dependencies (bun)..."
  docker exec -w /home/agent/workspace "${CONTAINER}" \
    bash -c 'if command -v bun >/dev/null 2>&1; then bun install || npm install --legacy-peer-deps; else npm install --legacy-peer-deps; fi'
fi

# ── Attach ───────────────────────────────────────────────────────
echo "→ Attaching to ${CONTAINER}..."
exec docker exec -it -w /home/agent/workspace "${CONTAINER}" "${CMD[@]}"
