#!/usr/bin/env bash
set -euo pipefail

# Refresh a RUNNING container's pi model list from the HOST config, and make
# the local-inference endpoint reachable from inside the container.
#
# Why: the image bakes `models.json` at build time, so a model added to the
# router (or to the host's models.json) after the last build is invisible until
# a rebuild. And the host config points local inference at `127.0.0.1` — inside
# a bridge-networked container that address is the container's OWN loopback,
# not the host's. Both halves are fixed by copying the host file in and
# rewriting host-loopback `baseUrl`s to the container's gateway (the host as
# seen from the bridge), keeping each URL's own port.
#
# Called by spawn-pi-agent.sh / attach.sh on every launch, next to the skills
# sync, so "edited a preset on the PC" no longer needs an image rebuild.
#
# Usage: sync-models.sh <container>
#   AGENT_LOCAL_INFERENCE_HOST   override the rewrite target: `host`, or
#                                `host:port` when the router sits behind a relay
#                                or in a sibling container
#
# Never fatal on its own: an unsynced container keeps running on the baked copy.

CONTAINER="${1:-}"
if [ -z "${CONTAINER}" ]; then
  echo "usage: sync-models.sh <container>" >&2
  exit 2
fi

# Same file the image build copies (`pi/models.json`), resolved the same way
# here: the host's pi config dir.
MODELS="${PI_CODING_AGENT_DIR:-$HOME/.config/pi}/models.json"
DEST=/home/agent/.pi/agent/models.json

if [ ! -f "${MODELS}" ]; then
  echo "⚠ ${MODELS} missing on the host — container keeps the baked model list" >&2
  exit 0
fi

# Rewrite target. Empty = leave the file untouched, which is correct only for
# host networking: that container shares the host's netns, so `127.0.0.1`
# already means the host.
GW=""
if [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "${CONTAINER}" 2>/dev/null)" != "host" ]; then
  GW="${AGENT_LOCAL_INFERENCE_HOST:-}"
  if [ -z "${GW}" ]; then
    GW="$(docker inspect \
      -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' \
      "${CONTAINER}" 2>/dev/null | awk '{print $1}')"
  fi
fi

# jq 1.6-compatible. Named groups are interpolated in the replacement string;
# the port is kept unless the override supplies one of its own.
REWRITE='walk(if type == "object" and ((.baseUrl? | type) == "string")
             then .baseUrl |= sub("^(?<scheme>https?)://(localhost|127\\.0\\.0\\.1)(?<port>:[0-9]+)?";
                                  "\(.scheme)://" + $gw +
                                  (if ($gw | test(":[0-9]+$")) then "" else (.port // "") end))
             else . end)'

emit() {
  if [ -z "${GW}" ]; then
    cat "${MODELS}"
  elif command -v jq >/dev/null 2>&1; then
    jq --arg gw "${GW}" "${REWRITE}" "${MODELS}"
  else
    # Copying a host-loopback baseUrl verbatim would be a working-looking
    # config that cannot connect; say so rather than stay silent.
    echo "⚠ jq not found on the host — copying models.json unmodified" >&2
    echo "  (host-loopback baseUrls will NOT work in this container)" >&2
    cat "${MODELS}"
  fi
}

# Write via a temp file created by the container's own user (`docker cp` would
# land it root:0600) and validate before replacing, so a truncated/failed
# payload can never clobber a working model list.
write_into() {
  docker exec -i "${CONTAINER}" bash -c '
    set -e
    dest="$1"
    tmp="$(mktemp "$dest.XXXXXX")"
    cat > "$tmp"
    jq -e . "$tmp" >/dev/null
    chmod 600 "$tmp"
    mv "$tmp" "$dest"
  ' _ "${DEST}"
}

if ! emit | write_into; then
  echo "⚠ model list not synced — keeping the container's current copy" >&2
fi