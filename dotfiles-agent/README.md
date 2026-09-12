# dotfiles-agent

A Docker dev environment that bakes a full coding-agent toolchain into a single
reusable `dotfiles-agent` image, then spawns **one container per project
folder**. All durable state lives in Docker volumes, so containers are
disposable and safe to recreate on the fly.

## What's in the image

- node 24 (bookworm), Go, neovim (official release), bun
- LSPs / formatters / linters (`eslint_d`, `stylelint`,
  `typescript-language-server`, `bash-language-server`, `gopls`,
  `golangci-lint`, `delve`, `lazygit`, …)
- browser automation: playwright + puppeteer + system Chromium
- the `pi` coding agent + its packages + skills (remote + repo `agent-skills/`)
- uid/gid aligned to the host user (`AGENT_UID`/`AGENT_GID` build args)

See the `Dockerfile` for the full list and the reasoning behind each layer.

## Scripts

| Script | Purpose |
| ------ | ------- |
| `build.sh` | build the image for the host arch (`--no-cache` supported) |
| `attach.sh` | interactive shell — or any command — in the folder's container |
| `spawn-pi-agent.sh` | launch the `pi` agent in a room named after the folder |
| `container-name.sh` | per-directory container naming (never clobbers another folder) |
| `port-forward.sh` | ad-hoc host→container port forwarding (no restart) |
| `stop-all.sh` | stop/remove every `dotfiles-agent` container (incl. forwards) |
| `install-aliases.sh` | install `agent-*` zsh aliases (idempotent) |
| `host-notify/install.sh` | install the macOS desktop-notification bridge (LaunchAgent) |
| `docker-compose.yml` | declarative alternative to the shell scripts |

## Build prerequisites

`build.sh` requires per-machine files that are gitignored (they hold secrets)
and fails fast if they're missing:

- `pi/models.json` — models + API keys; the image is unusable without it
- `pi/mcp.json` — MCP server definitions the image rewrites at build time

## Quick start

```bash
./install-aliases.sh   # once: adds agent-spawn/attach/fwd/stop to ~/.zshrc
agent-spawn            # pi agent in a room named after $PWD
agent-attach           # bash shell in the same container
agent-stop             # teardown every dotfiles-agent container
```

Each script derives the container name from the folder path, so the same folder
always maps to the same container, and different folders never share (or kill)
one another's containers.

`attach.sh` extras: `--build` (force rebuild), `--no-install` (skip the auto
`bun install`/`npm install` when `package.json` is present), and `-- CMD` to run
a specific command (`attach.sh -- pi` is equivalent to `spawn-pi-agent.sh`).

## Port forwarding

A container's `-p` mapping is fixed at `docker run` time. There are two
complementary workflows for exposing a dev server (e.g. a live-reload frontend)
to the host.

### 1. Declared ports — `-p HOST:GUEST`

Pass `-p` to `agent-spawn` / `agent-attach`:

```bash
agent-attach -p 3000:3000               # host 3000 → container 3000
agent-spawn  -p 8080:4173 -p 3000:3000  # multi / asymmetric (host:container)
agent-attach -p 9090:3000               # changed map → container recreated
```

Rules:

- bare `PORT` means `PORT:PORT` (so `-p 3000` ≡ `-p 3000:3000`)
- **stateless**: when `-p` is passed, the script diffs the requested map against
  the container's live `docker inspect` mapping and recreates **only on
  mismatch**. Re-running with no `-p` leaves existing ports untouched, so a bare
  `agent-attach` never clobbers a container that already has ports.
- recreation is cheap and safe: workspace + sessions are volumes; skills are re-synced from the repo on every launch

### 2. Ad-hoc forwards — `agent-fwd`

For a port you didn't declare up front (a `vite` dev server you just launched),
publish it into a *running* container via a shared-network-namespace sidecar —
no restart:

```bash
agent-fwd up 3000        # host 3000 → container 3000
agent-fwd up 8080:3000   # host 8080 → container 3000
agent-fwd list
agent-fwd down 3000      # remove one (by host port)
agent-fwd down           # remove all forwards for this folder
```

Notes:

- requires the target container to be **running** (`agent-spawn` / `agent-attach`
  first)
- forwards are disposable sidecars named `<container>-fwd-<hostport>`; they're
  cleaned up by `agent-stop` too

### Gotchas

- **fixed ports only** — `-p 0:PORT` (random ephemeral host port) is
  unsupported: the stateless diff would see a different assigned port each run
  and recreate forever
- the in-container dev server must listen on `0.0.0.0` (not `127.0.0.1`) for
  host access to reach it

## Desktop notifications

Pi (host session or inside a `dotfiles-agent` container) pushes **completion**
and **waiting-for-input** events to macOS Notification Center:

- `host-notify/server.mjs` is a loopback HTTP bridge that turns a
  `POST /notify` into an `osascript display notification`. Binds
  `127.0.0.1:49151` by default (`PI_NOTIFY_PORT` / `PI_NOTIFY_BIND` override).
- `pi/extensions/notify-desktop.ts` fires on `agent_settled` ("Pi finished")
  and `ui_prompt_start` ("Pi needs you"). On the host it posts to `127.0.0.1`;
  inside a container it posts to `host.docker.internal` (Docker Desktop
  forwards that to the host loopback).

Install the host bridge once:

```bash
./host-notify/install.sh   # LaunchAgent; starts at login, auto-restarts
```

Health check: `curl http://127.0.0.1:49151/health`.

Notes:

- "Pi needs you" is a **persistent alert** (stays until you click OK);
  "Pi finished" is a banner that auto-dismisses.
- Each notification is labelled with its source: the room name (folder
  basename) for containers, `host` for a host session; override with
  `PI_NOTIFY_LABEL`.
- The extension is baked into the image from `pi/extensions/`, so **rebuild**
  (`build.sh` / `agent-attach --build`) to pick it up in an existing image.
- The first notification may require allowing the terminal / Script Editor in
  **System Settings → Notifications**.

## Skills

Skills reach the container from two sources, merged in
`/home/agent/.agents/skills`:

- **Remote skills** (agent-browser, caveman, frontend-design, ponytail, …) are
  cloned into the image at build time and baked in.
- **Repo skills** in `agent-skills/` are also baked in by the Dockerfile, and —
  because the image is only rebuilt on demand — `agent-spawn` / `agent-attach`
  re-sync `agent-skills/` into the container on **every launch**.

So a new skill (a `SKILL.md` dropped under `agent-skills/<name>/`) shows up on
the next launch with **no rebuild**. To also bake it into the image for fresh
`docker run` / `docker compose` containers, run `build.sh` (or
`agent-attach --build`).

## Design notes

- **Recreation is the first-class "change" operation.** Docker fixes port
  mappings, capabilities, and the network namespace at create time. Because all
  durable state is in volumes, recreating a container to change ports is cheap —
  the scripts already self-heal stale mounts this way, so the port diff reuses
  that pattern.
- **The sidecar is for throwaway forwards.** `--network container:X -p …`
  publishes a host port into a running container's existing netns without
  touching it, which is exactly right for "peek at the dev server now".
- **Per-directory naming prevents cross-folder clobbering**
  (`container-name.sh`), and `port-forward.sh` matches sidecars by exact name
  glob rather than Docker's loose `name=` regex filter (so folders like `app`
  vs `myapp` can't cross-match).
- **pi-lens auto-format is disabled in the image.** `~/.pi-lens/config.json`
  ships `format.enabled: false`, so pi-lens never reformats files on its own —
  formatting is the project's job (e.g. `eslint_d` as configured in the repo).
  A repo opts back in with `"format": { "enabled": true }` in its own
  `.pi-lens.json`.
