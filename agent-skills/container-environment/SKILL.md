---
name: container-environment
description: >
  Describes the Docker container environment the agent is running
  in (the dotfiles-agent image) and what to suggest to the user about it.
  Use when the user asks about the runtime environment, how to expose a dev
  server or port, what tooling is installed, whether work persists across
  container rebuilds/recreation, or how networking works here. Also consult
  before telling a user to install anything system-wide or write outside the
  mounted workspace.
---

# Container Environment (dotfiles-agent)

What I'm running in, what's durable, and what I should suggest to the user.

## At a glance

| Fact | Value |
| ---- | ----- |
| Container image | `dotfiles-agent` (Debian bookworm) |
| User / home | `agent` / `/home/agent` |
| Workspace | `/home/agent/workspace` — the host project folder, bind-mounted |
| cwd | `/home/agent/workspace` |
| Sessions | `/home/agent/.pi/agent/sessions` (named volume `agent-sessions`) |
| Skills | `/home/agent/.agents/skills` |

The container is **disposable**: it is created per project folder and
recreated whenever its config (ports, mounts) changes. Anything that must
survive has to live in the workspace or the sessions/skills volumes.

## Toolchain (preinstalled)

- node 24, Go, bun, python3, build-essential
- neovim, lua-language-server, lazygit
- LSPs / formatters / linters: `eslint_d`, `stylelint`,
  `typescript-language-server`, `bash-language-server`, `gopls`,
  `golangci-lint`, `delve`, …
- CLI: `git`, `gh`, `git-lfs`, `jq`, `ripgrep`/`rg`, `fd`, `fzf`, `htop`, `unzip`
- `nginx` (`nginx-light`) — run a repo's local proxy config natively.
  Micro-frontend repos ship `nginx-local/conf.d/*.conf` + `docker-compose.yaml`
  for a laptop; docker-in-docker does NOT work here, so translate the compose
  volumes/hosts (`host.docker.internal` → `127.0.0.1`, image paths → real
  `dist/`) and serve with `nginx -c <conf> -p <prefix>`. As non-root put `pid`,
  `error_log` and every `*_temp_path` under `/tmp` and omit the `user`
  directive.
- browser automation: MCP web tools first (websearch/webfetch), then
  `agent-browser` (system Chromium) as the fallback; playwright
  (chromium/firefox/webkit), puppeteer (shares the system Chromium via
  `PUPPETEER_EXECUTABLE_PATH`)
- the pi coding agent itself + `pi-lens`, `pi-goal`,
  `pi-agents-talk-to-each-other`, `web-search-mcp`
- baked remote skills: agent-browser, caveman, clean-code, code-review,
  codebase-design, diagnosing-bugs, domain-modeling, frontend-design, glyph,
  grilling, megacave, ponytail, pr, retro, tdd, teach,
  theme-factory, to-questionnaire, ultracave, verification-before-completion,
  wayfinder, web-design-guidelines, writing-for-agents
- repo skills (re-synced every launch): container-environment, coordinator,
  issue-resolver-ops, refine

Both lists are a snapshot, not a contract — **no count is trustworthy**, and a
skill added to the Dockerfile after the last image build is missing until a
rebuild (`check-remote-skills.sh` warns about exactly that on every launch).
Recount in one command:

```sh
sed -n '/skills-clone/,/&& repos=/p' dotfiles-agent/Dockerfile \
  | grep -oE '"[^"]+:[^"]+"' | tr -d '"' \
  | awk -F: '{n = ($2 == "." ? $1 : $2); sub(".*/", "", n); print n}' | sort -u
echo clean-code            # curl'd raw, not cloned
docker exec <c> ls /home/agent/.agents/skills   # what actually exists
```

A whole-file grep is wrong: it also matches quoted `a:b` strings in messages
and tarball URLs (54 "skills" instead of the real set).

See `dotfiles-agent/Dockerfile` for the authoritative list.

pi-lens ships with auto-format **disabled** in the image
(`~/.pi-lens/config.json` → `format.enabled: false`), so formatting is left to
each project's own tooling (e.g. `eslint_d`). A repo can opt pi-lens
formatting back in with `"format": { "enabled": true }` in its own
`.pi-lens.json`.

## Durable vs ephemeral

| Storage | Survives recreate? |
| ------- | ------------------ |
| `/home/agent/workspace` | Yes — bind-mounted from the host |
| `/home/agent/.pi/agent/sessions` | Yes — named volume |
| `/home/agent/.agents/skills` | Yes — baked into the image, then re-synced from the repo's `agent-skills/` on every `agent-spawn` / `agent-attach` |
| Everything else (`apt-get`, `/tmp`, other paths) | **No** — lost on recreate |

So: never `apt-get install` something the user will need again without also
noting it must be baked into `dotfiles-agent/Dockerfile` (then `build.sh`).
Warn the user before writing anything important outside the workspace.

## Networking & ports

- One container per project folder; the name is derived from the folder path.
- Port mappings are fixed at container create time. Two ways to expose a dev
  server (live-reload frontend etc.):
  - **Declared** — `agent-spawn -p HOST:GUEST` / `agent-attach -p HOST:GUEST`
    (repeatable; bare `PORT` ≡ `PORT:PORT`). Re-running with the same `-p`
    recreates the container only if the map changed; omitting `-p` keeps
    existing ports.
  - **Ad-hoc** — `agent-fwd up|down|list HOST:GUEST`: a sidecar publishes a
    port into a *running* container with no restart.
- The in-container server must listen on `0.0.0.0` (not `127.0.0.1`) for the
  host to reach it.
- Optionally: `agent-fwd down` removes all forwards for the folder;
  `agent-stop` tears down every `dotfiles-agent` container and its forwards.
- Corporate VPN traffic **does** reach the container: Docker Desktop NATs
  egress through the macOS host, which owns the VPN routes and DNS, so internal
  addresses resolve and connect from the default bridge (no `--network host`
  needed — and it would not help, it enters the Linux VM's namespace, not
  macOS's, so no `utun` shows up).
- What is missing by default is **trust**, not routing: internal sites are
  issued by a corporate CA that neither store knows. The image reads
  certificates of any name from `dotfiles-agent/certs/` at build time
  (`build.sh`) and feeds both stores — OpenSSL (`git`/`curl`/chromium) and
  Node's own bundle via `NODE_EXTRA_CA_CERTS` (`npm`/`yarn`/pi/MCP, which
  `update-ca-certificates` never fixes). An empty folder is the normal case.
- `NET_ADMIN`/`tun` are not granted, so an in-container VPN client is not
  available; per-machine flags (`--dns`, `--add-host`, `-e HTTPS_PROXY=…`) go
  through `AGENT_DOCKER_ARGS` — see `dotfiles-agent/README.md`.
- Never suggest disabling verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`, npm
  `strict-ssl false`, `git http.sslVerify false`, `curl -k`): it turns off
  TLS checking for every connection in the container and hides a missing CA.

## What to suggest to the user

| The user wants to… | Suggest… |
| ------------------ | -------- |
| View a dev server / live reload from the host | `agent-fwd up HOST:GUEST` (ad-hoc) or restart with `agent-spawn -p HOST:GUEST`; remind them to bind `0.0.0.0` |
| Work in a different project | run `agent-spawn` / `agent-attach` from that folder — it gets its own container |
| Reset or clean up | `agent-stop`; containers are recreated on the next spawn/attach |
| Keep something after a rebuild | put it in the (mounted) workspace, or bake it into the Dockerfile + `build.sh` |
| Add a new skill | drop a `SKILL.md` under `agent-skills/<name>/`; it re-syncs into the container on the next launch (no rebuild needed). A skill added to the **Dockerfile** list instead needs a rebuild — the launch overlay cannot add it, and `check-remote-skills.sh` warns about that on every spawn/attach |
| Remove a skill | delete it from `agent-skills/` **and** from `~/.agents/skills/` in every running container — the launch sync only adds, it never prunes; a skill baked into the image also needs its Dockerfile entry dropped + a rebuild |
| Commit but git identity is missing | `git config --global user.name/email`; prefer setting it on the host (mounted read-only) so it persists |
| Automate a browser / scrape / test a web app | MCP web tools first (websearch/webfetch); fall back to `agent-browser` (see the agent-browser skill) or playwright/puppeteer |
| Know what version of a tool is installed | run `<tool> --version`; the toolchain above is the reference |
| Reach an internal/VPN-protected host, or `SELF_SIGNED_CERT_IN_CHAIN` on `yarn`/`npm` | routing already works; the gap is trust. Put the corporate CA in `dotfiles-agent/certs/` (any file names) and rebuild — never disable TLS verification (no `strict-ssl false`, no `curl -k`, no `NODE_TLS_REJECT_UNAUTHORIZED=0`) |

## References

- `dotfiles-agent/README.md` — scripts, aliases, full port-forwarding docs
- `AGENTS.md` — repo conventions (keep docs synced with functionality)
- `dotfiles-agent/Dockerfile` — authoritative list of what's installed
