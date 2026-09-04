#!/usr/bin/env bash
set -euo pipefail

# ── Usage ────────────────────────────────────────────────────────
# Resolve the container name for a folder without ever killing a
# container owned by another folder:
#
#   1. If no container named <basename> exists -> use it.
#   2. If it exists and is mounted to this folder -> reuse it.
#   3. Otherwise use <basename>-<path-hash8>; a stale stopped copy
#      mounted elsewhere is removed, a RUNNING one is an error.
#
# Usage: container-name.sh FOLDER
# Prints the container name on stdout.

FOLDER="$(realpath "$1")"

sanitize() {
  echo "$1" | sed -E 's/[^a-zA-Z0-9_.-]+/-/g; s/^[^a-zA-Z0-9]+//; s/[^a-zA-Z0-9]+$//'
}

mount_of() {
  # Strip Docker Desktop's /host_mnt prefix so the source compares
  # equal to the host path that was passed to `docker run -v`.
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/agent/workspace"}}{{.Source}}{{end}}{{end}}' "$1" 2>/dev/null | sed 's|^/host_mnt||' || true
}

BASE_NAME="$(sanitize "$(basename "$FOLDER")")"
[ -n "${BASE_NAME}" ] || BASE_NAME="agent"
HASH_SUFFIX="$(printf '%s' "${FOLDER}" | shasum | cut -c1-8)"

NAME="${BASE_NAME}"
if docker inspect -f . "${NAME}" >/dev/null 2>&1 &&
  [ "$(mount_of "${NAME}")" != "${FOLDER}" ]; then
  NAME="${BASE_NAME}-${HASH_SUFFIX}"
  if docker inspect -f . "${NAME}" >/dev/null 2>&1 &&
    [ "$(mount_of "${NAME}")" != "${FOLDER}" ]; then
    if [ "$(docker inspect -f '{{.State.Status}}' "${NAME}")" = "running" ]; then
      echo "✗ Container ${NAME} is running but mounted to $(mount_of "${NAME}"), not ${FOLDER}. Resolve manually." >&2
      exit 1
    fi
    docker rm "${NAME}" >/dev/null 2>&1 || true
  fi
fi

echo "${NAME}"
