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
- `git-lfs`, for repositories that track large files
- the `pi` coding agent + its packages + skills (remote + repo `agent-skills/`)
- `tini` as PID 1 (`ENTRYPOINT ["/usr/bin/tini", "--"]`) so orphaned
  MCP / chrome / esbuild children are reaped instead of accumulating as
  zombie processes
- uid/gid aligned to the host user (`AGENT_UID`/`AGENT_GID` build args)

See the `Dockerfile` for the full list and the reasoning behind each layer.

## Scripts

| Script | Purpose |
| ------ | ------- |
| `build.sh` | build the image for the host arch (`--no-cache` supported) |
| `attach.sh` | interactive shell — or any command — in the folder's container |
| `spawn-pi-agent.sh` | `pi` in folder's room; `--room`/`PI_AGENT_ROOM` |
| `container-name.sh` | per-directory container naming (per-folder isolation) |
| `port-forward.sh` | ad-hoc host→container port forwarding (no restart) |
| `stop-all.sh` | stop/remove every `dotfiles-agent` container (incl. forwards) |
| `install-aliases.sh` | install `agent-*` zsh aliases (idempotent) |
| `host-notify/install.sh` | install macOS notification bridge (LaunchAgent) |
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

`agent-spawn` names the agent's room after the folder too (basename of `$PWD`)
— override with `--room NAME`. Rooms are selected through the `PI_AGENT_ROOM`
env var; see [Agent rooms](#agent-rooms-per-task).

`attach.sh` extras: `--build` (force rebuild), `--no-install` (skip the auto
`bun install`/`npm install` when `package.json` is present), and `-- CMD` to run
a specific command (`attach.sh -- pi` is equivalent to `spawn-pi-agent.sh`).

## Agent rooms (per-task)

Pi agents talk to each other through rooms kept in the shared `agent-rooms`
Docker volume (`~/.pi/agent/rooms`), so every container sees the same rooms
and history.

- **`PI_AGENT_ROOM` override.** When set, the
  `pi-agents-talk-to-each-other` extension auto-joins the agent to that room
  and ignores the global `defaultRoom` in `~/.pi/agent/rooms/config.json`.
  Unset/empty keeps the old behaviour (join the global `defaultRoom`).
- **Launch scripts.** `spawn-pi-agent.sh` (`--room NAME`) and
  `attach.sh -- pi` set `PI_AGENT_ROOM` to the folder basename, so an
  interactive agent sits in a room named after the project.
- **issue-resolver.** The backend starts each step's agents with
  `PI_AGENT_ROOM=issue-<issue_id>`, giving every issue its own room of
  worker agents.
- **Rebuild required.** The override is a patch to the extension's
  `index.ts` baked into the image by the `Dockerfile`; after changing that
  patch, rebuild (`build.sh` / `agent-attach --build`) — a container
  restart is not enough.

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
- recreation is cheap and safe: workspace + sessions + memory are volumes;
  skills are re-synced from the repo on every launch

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
- `issue-resolver/bin/up.sh` (in-container) starts the issue-resolver backend
  (`:8080`) + Vite (`:5173`) and prints the exact host command to publish the
  UI — `agent-fwd up 5173:5173`

### Gotchas

- **fixed ports only** — `-p 0:PORT` (random ephemeral host port) is
  unsupported: the stateless diff would see a different assigned port each run
  and recreate forever
- the in-container dev server must listen on `0.0.0.0` (not `127.0.0.1`) for
  host access to reach it

## Workspace isolation

By default the container mounts the host folder read-write, which means
`node_modules` (and its native binaries, caches, etc.) would be shared between
host and container — the container could modify or corrupt host dependencies.

To prevent this, `agent-spawn` and `agent-attach` **shadow `node_modules`** with
a tmpfs (in-memory). The host's `node_modules` is hidden from the container;
the tmpfs starts empty and vanishes when the container stops. It's mounted
owned by the agent user (host uid/gid, which the image is aligned to via
`AGENT_UID`/`AGENT_GID`), so installs can write to it — Docker's tmpfs default
is root-owned, which would make `bun install` fail with `EACCES`.

On first attach, if `package.json` exists and the container's `node_modules` is
empty, `bun install` (or `npm install`) runs automatically. Stopping the
container discards it — the next launch installs fresh.

Note: Docker needs the tmpfs target to exist and will create an **empty**
`node_modules` directory on the host if it's missing. It's always empty (the
tmpfs lives above it) and is gitignored in practice, so it's harmless.

### Extending the shadow list

Set `AGENT_SHADOW_DIRS` to a space-separated list of workspace-relative
directory names to also isolate from the host:

```bash
AGENT_SHADOW_DIRS=".next dist .turbo" agent-spawn
```

Each entry gets its own tmpfs and is fully private to the container.

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
- The alert is **focus-aware**: the bridge shows it immediately only when the
  room is *not* on screen (Alacritty not frontmost, or the room's tmux session
  has no attached client). If you're looking right at the room, it waits a
  grace period (`PI_NOTIFY_ALERT_DELAY_MS`, default `120000`) and alerts only
  if you still haven't answered — replying cancels the pending alert. The
  reply body is `deferred`/`shown`, which is how the extension knows whether
  to arm the retry.
- The alert **body carries more context** than the banner: the prompt
  title/kind, the tail of Pi's last message (what it's asking about), and the
  working directory plus how long it has waited — rendered as separate lines
  (banners stay a single flattened line).
- On the host, Pi records its own tmux session under `~/.pi-notify/` so focus
  detection works there too; containers record it from `spawn-pi-agent.sh`.
- Message bodies are flattened from markdown to plain text and trimmed at a
  word boundary, so a cut never strands `**`/`]`/`)` fragments.
- The extension is baked into the image from `pi/extensions/`, so **rebuild**
  (`build.sh` / `agent-attach --build`) to pick it up in an existing image.
- The first notification may require allowing the terminal / Script Editor in
  **System Settings → Notifications**.

## Skills

Skills reach the container from two sources, merged in
`/home/agent/.agents/skills`; the pi-lens package adds four more of its own.

- **Remote skills** are cloned into the image at build time and baked in.
- **Repo skills** in `agent-skills/` are also baked in by the Dockerfile, and —
  because the image is only rebuilt on demand — `agent-spawn` / `agent-attach`
  re-sync `agent-skills/` into the container on **every launch**.

So a new skill (a `SKILL.md` dropped under `agent-skills/<name>/`) shows up on
the next launch with **no rebuild**. To also bake it into the image for fresh
`docker run` / `docker compose` containers, run `build.sh` (or
`agent-attach --build`).

### Repo skills (`agent-skills/`)

| Skill | Purpose |
| ----- | ------- |
| `container-environment` | What this container is; what to suggest about the runtime |
| `coordinator` | Coordinator role in a hand-assembled room — dispatch, verify, integrate (не для шагов issue-resolver: там роль выдаёт движок) |
| `geo-bypass` | Geo-restricted / TLS-blocked network access recipes |
| `handoff` | Pi-adapted handoff doc (overrides the cloned remote copy) |
| `pr` | Generate an MR/PR description from a feature diff |
| `refine` | Grilling-интервью + план для шага `refine` в issue-resolver (на него ссылается `issue-resolver/prompts/step-refine.md`) |

### Remote skills (cloned at build time)

| Skill | Source | Purpose |
| ----- | ------ | ------- |
| `agent-browser` | vercel-labs/agent-browser | Browser automation CLI |
| `caveman` | juliusbrussee/caveman | Terse caveman voice |
| `clean-code` | sickn33/agentic-awesome-skills | Clean Code principles |
| `code-review` | mattpocock/skills | Standards + spec review, in parallel |
| `codebase-design` | mattpocock/skills | Deep-module design vocabulary |
| `domain-modeling` | mattpocock/skills | GLOSSARY.md + ADR workflow |
| `glyph` | yonatangross/orchestkit | ASCII-art answers |
| `handoff` | mattpocock/skills | Compact a session into a handoff doc |
| `improve-codebase-architecture` | mattpocock/skills | Scan for deepening opportunities |
| `ponytail` | dietrichgebert/ponytail | Lazy-senior minimal-change mode |
| `retro` | mattpocock/skills | Session retrospective |
| `tdd` | mattpocock/skills | Test-driven development |
| `teach` | mattpocock/skills | Teach a concept inside the workspace |
| `to-questionnaire` | mattpocock/skills | Turn a decision into a questionnaire |
| `wayfinder` | mattpocock/skills | Plan huge work as decision tickets |
| `web-design-guidelines` | vercel-labs/agent-skills | Web Interface Guidelines review |
| `writing-for-agents` | mattpocock/skills | Writing docs for agents (was `writing-great-skills`) |

### pi-lens built-in skills

Shipped inside the `pi-lens` npm package (not in `~/.agents/skills`):
`pi-lens-ast-grep`, `pi-lens-lsp-navigation`,
`pi-lens-write-ast-grep-rule`, `pi-lens-write-tree-sitter-rule`.

The image bakes 21 unique skill directories into
`/home/agent/.agents/skills` (17 remote + 5 repo, where the repo `handoff`
overrides the cloned one of the same name) plus the 4 pi-lens built-ins.
Remote skills whose source path vanished upstream (e.g. the
`writing-great-skills` → `writing-for-agents` rename) now fail the build
instead of being dropped silently.

## Known issues & maintenance

### Zombie processes

The container accumulates `<defunct>` pid-table entries. Orphaned
`chrome-devtools-mcp` trees (`npm exec` → `sh` → server), `esbuild` and
`chrome-headless` children are not reaped by anything, so a long-lived
container was observed with **1900+ zombies**. They hold no CPU/RAM, but they
consume PID-table slots and clutter `ps`.

The image ships **tini** as the entrypoint (`ENTRYPOINT ["/usr/bin/tini", "--"]`)
so newly created containers reap orphans. The launch scripts override that
entrypoint (`--entrypoint sleep`), so `spawn-pi-agent.sh` and `attach.sh`
now pass **`--init`** as well, which gives the container the same docker-init
(tini) reaper at PID 1; `docker-compose.yml` only overrides `command`, so it
already gets the image entrypoint. An already-running container cannot
be fixed in place: recreate it (`agent-stop`, then `agent-spawn`/`agent-attach`).

### Duplicate MCP servers (per-agent spawn)

Every `pi` agent spawns its own `chrome-devtools-mcp` / `web-search-mcp`
process tree, so N agents means N copies of each — there is no sharing between
agents. This is a Pi / MCP lifecycle limitation, not a container misconfig.

### Cache cleanup

Caches under `/home/agent/.cache` and `~/.npm` grow large; the Dockerfile now
prunes them in the build layer. To reclaim space in a running container:

```bash
npm cache clean --force
rm -rf ~/.cache/yarn/v6 ~/.cache/go-build/* ~/.cache/qmd/models/*
```

Notes:

- Deleting the qmd GGUF models only affects **semantic/deep** memory search;
  keyword (BM25) search keeps working because the image sets
  `PI_MEMORY_QMD_UPDATE=off`. The model is re-downloaded on demand.
- `~/.npm/_npx` is a separate npx execution cache (not touched by
  `npm cache clean`). Leave it while `chrome-devtools-mcp` servers are
  running; they resolve modules from it lazily.
- `~/.pi/agent/sessions` is a **shared** volume (`agent-sessions`), so pruning
  old sessions deletes history for every room/container using the volume.

## Long-term memory

Pi remembers across sessions with
[`pi-memory`](https://pi.dev/packages/pi-memory) — plain-markdown
`MEMORY.md`, daily logs, and a scratchpad. The store path comes from
`PI_MEMORY_DIR`, which the image sets to `~/.pi/agent/memory`, so
`docker exec` shells and the agent agree on it.

Durable storage follows the sessions pattern: **one shared Docker volume**
(`agent-memory`) mounted at that path in every container, so all rooms
share a single brain — the same way every room shares `agent-sessions`.

Implementation notes:

- the image pre-creates `~/.pi/agent/memory` (`mkdir -p`, owned by
  `agent`). A named volume mounted at a path the image does *not* have
  comes up `root:root`, and the agent user then cannot write to it.
- the mount point is the memory subdir, never `~/.pi/agent` itself: a
  volume there would shadow the baked `settings.json`, `models.json`,
  `mcp.json`, and `npm/` (the installed packages).
- `pi-memory` is installed at build time from the `BASE_PKGS` seed, using
  the same `pi update --extensions` run as the other extensions.

Caveats:

- `pi-memory` has **no per-project scoping** — everything it learns is
  global, so "use pnpm in this repo" is visible from every other repo.
  Per-repo facts belong in that repo's `AGENTS.md`.
- `memory_search` uses [qmd](https://github.com/tobi/qmd), installed in
  the image via `npm`. BM25 keyword search is fast (~30ms) and works
  offline without any models. The image sets `PI_MEMORY_QMD_UPDATE=off`
  to disable background embedding — GGUF models peak host CPU with no
  GPU passthrough from Docker Desktop on macOS. The agent defaults to
  keyword search; semantic/deep requires `qmd embed` manually and
  re-enabling with `PI_MEMORY_QMD_UPDATE=background`.
- the host keeps its own store at `~/.config/pi/memory` (`PI_MEMORY_DIR`
  in `~/.zshrc`) — the volume is container-only. For one brain across
  host *and* containers, swap the volume mount for a bind of that dir:
  `-v "$HOME/.config/pi/memory:/home/agent/.pi/agent/memory"`.
- markdown memory is bind-safe; SQLite-backed extensions (e.g.
  `pi-hermes-memory`) are not — keep those on a named volume.
- concurrent rooms write the same files and the extension takes no lock.
  Writes are small appends, so at worst an update is lost, never
  corrupted.

Rebuild (`build.sh` / `agent-attach --build`), then **recreate** existing
containers (`agent-stop`) — a container created before this change keeps
its old mount set and would keep memory inside the throwaway layer.

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
