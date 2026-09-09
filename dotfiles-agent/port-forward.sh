#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: port-forward.sh [-f FOLDER] up   HOST:GUEST [HOST:GUEST ...]
       port-forward.sh [-f FOLDER] down [HOST[:GUEST] ...]   # omit = remove all
       port-forward.sh [-f FOLDER] list

  Temporarily publish a host port into a RUNNING agent container by
  attaching a shared-network-namespace sidecar. No container restart.

  -f FOLDER    Derive the target container from FOLDER (default: \$PWD).
  HOST:GUEST   Host port to bind  →  port the dev server listens on
               inside the container. Bare HOST ≡ HOST:HOST.
EOF
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="dotfiles-agent"

# ── Parse leading -f FOLDER, then the subcommand ─────────────────
FOLDER=""
while [ $# -gt 0 ]; do
  case "$1" in
  -f | --folder)
    FOLDER="$2"
    shift 2
    ;;
  *) break ;;
  esac
done

ACTION="${1:-}"
if [ -z "${ACTION}" ]; then usage; fi
shift

FOLDER="$(realpath "${FOLDER:-$PWD}")"
# Per-directory container name — never steals/kills another folder's container.
CONTAINER="$(bash "${SCRIPT_DIR}/container-name.sh" "${FOLDER}")"

normalize_port() {
  case "$1" in
  *:*) printf '%s\n' "$1" ;;
  *) printf '%s:%s\n' "$1" "$1" ;;
  esac
}

host_port() { normalize_port "$1" | cut -d: -f1; }
sidecar_name() { printf '%s-fwd-%s\n' "${CONTAINER}" "$(host_port "$1")"; }

# List this container's forward sidecars by exact name prefix (glob match,
# not Docker's loose `name=` regex filter — avoids over-matching folders
# like "app" vs "myapp").
my_forwards() {
  local n
  while IFS= read -r n; do
    case "${n}" in
    "${CONTAINER}"-fwd-*) printf '%s\n' "${n}" ;;
    esac
  done < <(docker ps -a --format '{{.Names}}' 2>/dev/null || true)
}

require_running() {
  local state
  state="$(docker inspect -f '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || true)"
  if [ -z "${state}" ]; then
    echo "✗ No container for ${FOLDER}. Start one first: agent-spawn or agent-attach." >&2
    exit 1
  fi
  if [ "${state}" != "running" ]; then
    echo "✗ Container ${CONTAINER} is not running (state: ${state})." >&2
    exit 1
  fi
}

do_up() {
  if [ $# -eq 0 ]; then usage; fi
  require_running
  local spec name mapping state
  for spec in "$@"; do
    mapping="$(normalize_port "${spec}")"
    name="$(sidecar_name "${spec}")"
    if docker inspect -f . "${name}" >/dev/null 2>&1; then
      state="$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null || true)"
      if [ "${state}" = "running" ]; then
        echo "→ ${name} already forwarding ${mapping}"
        continue
      fi
      echo "→ Replacing stale ${name}..."
      docker rm -f "${name}" >/dev/null
    fi
    echo "→ Forwarding ${mapping} into ${CONTAINER} (${name})..."
    docker run -d --name "${name}" \
      --network "container:${CONTAINER}" \
      -p "${mapping}" \
      --entrypoint sleep \
      "${IMAGE}" infinity >/dev/null
  done
}

do_down() {
  if [ $# -eq 0 ]; then
    local names name
    names="$(my_forwards)"
    if [ -z "${names}" ]; then
      echo "→ No forwards for ${CONTAINER}."
      return
    fi
    for name in ${names}; do
      echo "→ Removing ${name}..."
      docker rm -f "${name}" >/dev/null
    done
    return
  fi
  local spec name
  for spec in "$@"; do
    name="$(sidecar_name "${spec}")"
    if docker inspect -f . "${name}" >/dev/null 2>&1; then
      echo "→ Removing ${name}..."
      docker rm -f "${name}" >/dev/null
    else
      echo "→ No forward named ${name}."
    fi
  done
}

do_list() {
  local names name mapping
  names="$(my_forwards)"
  if [ -z "${names}" ]; then
    echo "→ No forwards for ${CONTAINER}."
    return
  fi
  printf '%-40s %s\n' SIDECAR FORWARD
  for name in ${names}; do
    mapping="$(docker inspect -f \
      '{{range $cp, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}}->{{$cp}}{{"\n"}}{{end}}{{end}}' \
      "${name}" 2>/dev/null | sed -e 's|/tcp||; s|/udp||' | head -n1 || true)"
    printf '%-40s %s\n' "${name}" "${mapping}"
  done
}

case "${ACTION}" in
up) do_up "$@" ;;
down) do_down "$@" ;;
list | status) do_list ;;
*) usage ;;
esac
