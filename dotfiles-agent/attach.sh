#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: attach.sh [-p PORT] [--no-install] [FOLDER] [-- pi|CMD...]

  -p PORT     Expose port (e.g. -p 3000:3000). Repeatable.
              Only applies on container creation.
              Ports are auto-detected from project config
              (vite, next, nuxt, angular, .env, docker-compose).
              Use -p to override or add more.
  --no-install  Skip auto npm install when package.json detected
  FOLDER      Path to mount as /home/agent/workspace (default: \$PWD)
  CMD         Command to run (default: bash). Use "pi" to start pi agent.
EOF
  exit 1
}

# ── Auto-detect dev server ports ─────────────────────────────────
auto_detect_ports() {
  local folder="$1"
  local detected=""

  # Vite: vite.config.{ts,js,mjs} → server.port (default 5173)
  for f in "$folder/vite.config.ts" "$folder/vite.config.js" "$folder/vite.config.mjs"; do
    [ -f "$f" ] || continue
    local port
    port=$(sed -nE 's/.*port:[[:space:]]*([0-9]+).*/\1/p' "$f" | head -1)
    detected="$detected ${port:-5173}"
    break
  done

  # Next.js: next.config.{ts,js,mjs} (default 3000)
  for f in "$folder/next.config.ts" "$folder/next.config.js" "$folder/next.config.mjs"; do
    [ -f "$f" ] && {
      detected="$detected 3000"
      break
    }
  done

  # Nuxt: nuxt.config.{ts,js} → devServer.port (default 3000)
  for f in "$folder/nuxt.config.ts" "$folder/nuxt.config.js"; do
    [ -f "$f" ] || continue
    local port
    port=$(sed -nE 's/.*port:[[:space:]]*([0-9]+).*/\1/p' "$f" | head -1)
    detected="$detected ${port:-3000}"
    break
  done

  # Angular: angular.json → serve.options.port (default 4200)
  if [ -f "$folder/angular.json" ]; then
    local port
    port=$(sed -nE 's/.*"port":[[:space:]]*([0-9]+).*/\1/p' "$folder/angular.json" | head -1)
    detected="$detected ${port:-4200}"
  fi

  # .env / .env.local → PORT=
  for f in "$folder/.env" "$folder/.env.local"; do
    [ -f "$f" ] || continue
    local port
    port=$(sed -nE 's/^PORT=[[:space:]]*([0-9]+).*/\1/p' "$f" | head -1)
    [ -n "$port" ] && detected="$detected $port"
  done

  # docker-compose / compose.yaml
  for f in "$folder/docker-compose.yml" "$folder/compose.yaml" "$folder/compose.yml"; do
    [ -f "$f" ] || continue
    local ports
    ports=$(grep -oE '"[0-9]+(:[0-9]+)?"' "$f" | sed -E 's/"//g; s/.*://' | sort -u | tr '\n' ' ')
    detected="$detected $ports"
  done

  # Deduplicate
  echo "$detected" | tr ' ' '\n' | sort -u | tr '\n' ' '
}

# Check if container port is already in PORTS array
is_port_mapped() {
  local port="$1"
  local i
  for ((i = 0; i < ${#PORTS[@]}; i += 2)); do
    [ "${PORTS[$i + 1]##*:}" = "$port" ] && return 0
  done
  return 1
}

# ── Parse flags ──────────────────────────────────────────────────
PORTS=()
NO_INSTALL=false
FOLDER=""

while [ $# -gt 0 ]; do
  case "$1" in
  -p | --port)
    PORTS+=("-p" "$2")
    shift 2
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

# ── Resolve folder ───────────────────────────────────────────────
FOLDER="$(realpath "${FOLDER:-$PWD}")"

# ── Remaining args are CMD ───────────────────────────────────────
CMD=("${@:-bash}")

# ── Derive container name ────────────────────────────────────────
# /Users/foo/code/my-project → dotfiles-agent-my-project
# /Users/foo/dotfiles-agent     → dotfiles-agent (no duplication)
SLUG="$(basename "${FOLDER}" | sed 's|[^a-zA-Z0-9_-]||g')"
if [ "${SLUG}" = "dotfiles-agent" ]; then
  CONTAINER_NAME="dotfiles-agent"
else
  CONTAINER_NAME="dotfiles-agent-${SLUG}"
fi

# ── Attach or create ─────────────────────────────────────────────
STATE="$(docker inspect -f '{{.State.Status}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
if [ -n "${STATE}" ]; then
  if [ "${STATE}" != "running" ]; then
    echo "→ Starting container ${CONTAINER_NAME}..."
    docker start "${CONTAINER_NAME}" >/dev/null
  fi
  if [ ${#PORTS[@]} -gt 0 ]; then
    echo "→ Warning: -p flags ignored (ports are set at container creation)." >&2
    echo "  Remove container first: docker rm ${CONTAINER_NAME}" >&2
  fi
else
  # Auto-detect ports from project config
  for port in $(auto_detect_ports "$FOLDER"); do
    is_port_mapped "$port" && continue
    PORTS+=("-p" "${port}:${port}")
    echo "→ Auto-detected port $port"
  done
  echo "→ Creating container ${CONTAINER_NAME} for ${FOLDER}..."
  docker run -d --name "${CONTAINER_NAME}" \
    "${PORTS[@]+"${PORTS[@]}"}" \
    -v "${FOLDER}:/home/agent/workspace" \
    -v "${HOME}/.gitconfig:/home/agent/.gitconfig:ro" \
    -v "${HOME}/.ssh:/home/agent/.ssh:ro" \
    --entrypoint sleep \
    dotfiles-agent \
    infinity
fi

# ── Auto npm install ─────────────────────────────────────────────
if [ "${NO_INSTALL}" = false ] &&
  [ -f "${FOLDER}/package.json" ] &&
  [ ! -d "${FOLDER}/node_modules" ]; then
  echo "→ Installing npm dependencies..."
  docker exec -w /home/agent/workspace "${CONTAINER_NAME}" \
    bash -c 'corepack enable 2>/dev/null; npm install --legacy-peer-deps'
fi

# ── Attach ───────────────────────────────────────────────────────
echo "→ Attaching to ${CONTAINER_NAME}..."
exec docker exec -it -w /home/agent/workspace "${CONTAINER_NAME}" "${CMD[@]}"
