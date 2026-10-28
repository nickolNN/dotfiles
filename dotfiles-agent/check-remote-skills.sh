#!/usr/bin/env bash
#
# Warn when the image is missing remote skills that the Dockerfile declares.
#
# Why this exists: remote skills are baked at BUILD time, while the launch only
# overlays the repo's `agent-skills/`. So a skill added to the Dockerfile list
# (or one deleted from agent-skills/ but never rebuilt into the image) is
# silently absent in every container created from the CURRENT image. Silent is
# the problem: a step prompt that injects a missing file injects an empty
# string, and the agent works happily with no doctrine at all. Same class as
# the prompt-cache bug — build and reality drifted, nobody noticed.
#
# Usage: check-remote-skills.sh <container> [dockerfile]
# Always exits 0: a missing skill must warn, never block the room.

set -uo pipefail

CONTAINER="${1:-}"
DOCKERFILE="${2:-$(dirname "${BASH_SOURCE[0]}")/Dockerfile}"

[ -n "${CONTAINER}" ] || exit 0
docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null | grep -q true || exit 0

# Names come from the same `set -- "repo:subpath"` block the build consumes, and
# the repo→name mapping is copied from the build loop: a bare `.` subpath means
# the skill is the repository's own basename.
if ! block=$(sed -n '/skills-clone/,/&& repos=/p' "${DOCKERFILE}" 2>/dev/null); then
  exit 0
fi

names=""
while IFS= read -r entry; do
  [ -n "${entry}" ] || continue
  repo="${entry%%:*}"
  sub="${entry#*:}"
  if [ "${sub}" = "." ]; then
    names="${names} ${repo##*/}"
  else
    names="${names} ${sub##*/}"
  fi
done < <(printf '%s\n' "${block}" | grep -oE '"[^"]+:[^"]+"' | tr -d '"')

# clean-code is not cloned — it is curl'd straight from an aggregator's raw URL.
names="${names} clean-code"

missing="$(docker exec "${CONTAINER}" sh -c \
  'for n in '"${names}"'; do [ -d "/home/agent/.agents/skills/$n" ] || echo "$n"; done' \
  2>/dev/null | sort -u)"

if [ -n "${missing}" ]; then
  count=$(printf '%s\n' "${missing}" | grep -c .)
  echo "WARNING: image is missing ${count} declared remote skill(s): $(echo ${missing} | tr '\n' ' ')" >&2
  echo "  They were added to ${DOCKERFILE##*/} after the last build — a step that" >&2
  echo "  injects one of them gets an EMPTY prompt block and will not fail loudly." >&2
  echo "  Rebuild the image: $(dirname "${BASH_SOURCE[0]}")/build.sh" >&2
fi

exit 0
