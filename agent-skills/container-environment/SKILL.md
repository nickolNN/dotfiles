---
name: container-environment
description: Describes the Docker container environment the agent is running
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
- CLI: `git`, `gh`, `jq`, `ripgrep`/`rg`, `fd`, `fzf`, `htop`, `unzip`
- browser automation: `agent-browser` (system Chromium), playwright +
  puppeteer with chromium/firefox/webkit
- the pi coding agent itself + `pi-lens`, `pi-mcp-adapter`, `pi-goal`,
  `pi-agents-talk-to-each-other`, `web-search-mcp`
- skills: agent-browser, caveman, clean-code, domain-modeling,
  frontend-design, geo-bypass, grill-with-docs, handoff, ponytail,
  writing-great-skills, this one

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
- No corporate VPN is set up by default, and `NET_ADMIN`/`tun` are not
  granted. If e2e needs an internal network, that currently has to happen on
  the host or be planned separately — don't assume VPN access exists here.

## What to suggest to the user

| The user wants to… | Suggest… |
| ------------------ | -------- |
| View a dev server / live reload from the host | `agent-fwd up HOST:GUEST` (ad-hoc) or restart with `agent-spawn -p HOST:GUEST`; remind them to bind `0.0.0.0` |
| Work in a different project | run `agent-spawn` / `agent-attach` from that folder — it gets its own container |
| Reset or clean up | `agent-stop`; containers are recreated on the next spawn/attach |
| Keep something after a rebuild | put it in the (mounted) workspace, or bake it into the Dockerfile + `build.sh` |
| Add a new skill | drop a `SKILL.md` under `agent-skills/<name>/`; it re-syncs into the container on the next launch (no rebuild needed) |
| Commit but git identity is missing | `git config --global user.name/email`; prefer setting it on the host (mounted read-only) so it persists |
| Automate a browser / scrape / test a web app | use `agent-browser` (see the agent-browser skill) or playwright/puppeteer |
| Get past TLS / geo-blocked resources | the geo-bypass skill (npm `--strict-ssl`, proxy, archive, VPN) |
| Know what version of a tool is installed | run `<tool> --version`; the toolchain above is the reference |

## References

- `dotfiles-agent/README.md` — scripts, aliases, full port-forwarding docs
- `AGENTS.md` — repo conventions (keep docs synced with functionality)
- `dotfiles-agent/Dockerfile` — authoritative list of what's installed
