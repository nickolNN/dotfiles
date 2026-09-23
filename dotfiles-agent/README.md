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
| `attach.sh` | interactive shell (or any cmd) in the folder's container |
| `spawn-pi-agent.sh` | launch the `pi` agent in a room named after the folder |
| `container-name.sh` | per-directory container naming (no clobbering) |
| `port-forward.sh` | ad-hoc host→container port forwarding (no restart) |
| `stop-all.sh` | stop/remove every `dotfiles-agent` container |
| `install-aliases.sh` | install `agent-*` zsh aliases (idempotent) |
| `host-notify/install.sh` | install the notification bridge (LaunchAgent) |
| `docker-compose.yml` | declarative alternative to the shell scripts |

## Build prerequisites

`build.sh` requires per-machine files that are gitignored (they hold secrets)
and fails fast if they're missing:

- `pi/models.json` — models + API keys; the image is unusable without it
- `pi/mcp.json` — MCP server definitions the image rewrites at build time
- `dotfiles-agent/certs/yadro-ca.pem` — **optional** internal-registry CA
  bundle (gitignored; the dir ships a committed `.gitkeep` so the image
  builds on machines that never touch the internal registry):
  - present → baked into the system store + `NODE_EXTRA_CA_CERTS` +
    `~/.certs/yadro-ca.pem`, and `npm ci` against `@kc` works with zero
    agent intervention (without it there: `SELF_SIGNED_CERT_IN_CHAIN`);
  - absent → `build.sh` prints a WARNING and the image builds unchanged
    with stock CAs — a dangling `NODE_EXTRA_CA_CERTS` path is a measured
    no-op for node.
  - Export on a YADRO host:

    ```sh
    security find-certificate -c "T-SPB-CA" \
      -p /Library/Keychains/System.keychain \
      > dotfiles-agent/certs/yadro-ca.pem
    ```

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
- recreation is cheap and safe: workspace, sessions, memory,
  node_modules and caches are all volumes; skills and pi extensions are
  re-synced from the repo on every launch

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

- requires the target container to be **running**
  (`agent-spawn` / `agent-attach` first)
- forwards are disposable sidecars named `<container>-fwd-<hostport>`; they're
  cleaned up by `agent-stop` too

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
Worse, the host copy may contain **macOS-built native modules** (node-gyp
binaries) that cannot load on Linux, and virtiofs small-file IO is ~10×
(slower write) / ~22× (slower read) versus the VM's local ext4.

To prevent this, `agent-spawn` and `agent-attach` **shadow `node_modules`
with a persistent named volume** — `agent-node-modules-<container>` (keyed
by the same per-folder name `container-name.sh` derives). The host copy stays
hidden forever; the container's Linux-side install survives stop/start and
**recreate**, so `npm ci` runs once per lockfile change instead of once per
launch (it used to be a tmpfs: empty on every recreate, costing hours of
re-downloads). Details:

- `volume-nocopy` is set, so Docker does **not** seed the fresh volume from
  the mount-point content (which would copy the macOS tree into Linux).
  A nocopy volume comes up root-owned; the scripts chown it to the agent
  uid/gid via a stat-first `docker exec -u root` (no-op once correct).
- **Staleness guard:** on every launch the scripts warn loudly when
  `node_modules/.package-lock.json` is missing, or when
  `package-lock.json`'s sha256 differs from the marker stored on the volume
  (`node_modules/.dotfiles-agent-lock-hash`) **and** the lock is newer than
  the installed tree. A persisted-but-stale `node_modules` is worse than an
  empty one — the guard exists so warnings prompt `npm ci`, not silent
  wrong-dependency runs.
- On first attach, if `package.json` exists and the volume is empty,
  `bun install` (or `npm install`) still runs automatically.

Note: Docker needs the mount target to exist and will create an **empty**
`node_modules` directory on the host if it's missing. It's always empty (the
volume lives above it) and is gitignored in practice, so it's harmless.

### Extending the shadow list

Set `AGENT_SHADOW_DIRS` to a space-separated list of workspace-relative
directory names to also isolate from the host:

```bash
AGENT_SHADOW_DIRS=".next dist .turbo" agent-spawn
```

Each extra entry gets its own tmpfs (throwaway by design) and is fully
private to the container.

## Caches, certs, and memory limits

Durable, volume-backed caches (image `ENV` in `Dockerfile`):

- **npm cache** → `/home/agent/.cache/npm` (image `ENV npm_config_cache`).
  Was 204 MB on the overlay; re-downloaded the world after every recreate.
- **jest cache** → image `ENV TMPDIR=/home/agent/.cache/tmp`; jest's
  default `cacheDirectory` derives from `os.tmpdir()`, so the repo's
  `/tmp/jest_*` caches land on the volume (verified: a single spec run
  left `/home/agent/.cache/tmp/jest_dy` at 70 MB on ext4).
- **qmd GGUF models** were baked at `/home/agent/.cache/qmd` in the image;
  the volume now keeps downloads across recreates (volume seeds from the
  baked content on first use).
- **eslint cache: not persisted, on purpose.** Enabling it requires
  `cache: true` / `--cache-location` in the repo's own eslint config, and
  the scripts must not touch the working tree. The image still exports
  `ESLINT_CACHE=/home/agent/.cache/eslint/.eslintcache` as an opt-in
  target (`--cache --cache-location "$ESLINT_CACHE"` — eslint reads no
  env var itself). The durable answer stays `eslint_d` (see "Fast
  tooling"): its daemon state lives in `~/.cache` on the volume, and a
  warm re-lint costs 47–86 ms vs ~3 s cold (measured on spec files).
- **jest `cacheDirectory` env opt-in.** Image exports
  `JEST_CACHE_DIRECTORY=/home/agent/.cache/jest`. jest reads no env natively;
  a project can adopt it with one line in its jest config
  (`cacheDirectory: process.env.JEST_CACHE_DIRECTORY` — undefined elsewhere,
  CI unaffected). Not applied to `kc_bitwarden`'s `jest.config.js`: the
  working tree is in flight, and the `TMPDIR` default already lands jest's
  cache on the volume (measured 70 MB surviving recreates), so the env
  buys nothing today.

`agent-cache` is **global (one volume, all rooms), not per-project**: the npm
cache is content-addressed (`cacache`) and safe for concurrent containers,
it dedupes identical registry packages across repos, and the host disk is the
constrained resource (85 % full). `~/.cache` was already populated in the
image (≈ 700 MB incl. qmd models), so a fresh volume seeds from that.

Two more things the image bakes so a fresh container needs **zero agent
intervention**:

- **Internal CA** — the YADRO chain root (`CN=T-SPB-CA`) is installed into
  the system store **and** exported as `NODE_EXTRA_CA_CERTS`; a copy also
  lives at `~/.certs/yadro-ca.pem` because project docs reference that path.
  `strict-ssl` stays on.
- **`/etc/gitconfig` with `safe.directory = *`** — virtiofs intermittently
  stats the workspace as `root:root` while the agent user is uid 502, and
  git's ownership check therefore fails at random. The host `~/.gitconfig`
  is a read-only bind and `~/.config` is overlay, so the system config is
  the only durable writable location. Do **not** set `GIT_CONFIG_GLOBAL` to
  a container-local file — it overrides the bind-mounted host identity
  config and breaks husky commits (`Author identity unknown`).

**Memory ceiling:** containers are created with `--memory=10g` (override:
`AGENT_MEMORY_LIMIT`, empty = uncapped). The Docker Desktop VM has
`MemoryMiB=12288, SwapMiB=0` — 8 concurrent agents each running jest
(1.5 GB/worker heap, `maxWorkers: 8`) plus node provably exceed the VM and
the whole VM gets SIGKILL'd (exit 137 storms; observed live 2026-09-21).
The per-container limit contains runaways but cannot prevent VM-level
oversubscription — the real fixes are giving the VM swap (Docker
Desktop → Resources → Swap ≥ 8 GB; `SwapMiB` in
`settings-store.json`) and keeping concurrent agents per project
low. Both are global/user decisions, so the scripts do not change
them.

## Fast tooling: use these, they are already installed

A week of container session transcripts shows agents paying full price for
tools that are pre-installed and warm:

- **`eslint_d` (daemon) — pinned to the project engine, paths only.**
  `npx eslint` was used 104× vs `eslint_d` 1×, and eslint was the #1 time
  sink (5.70 h, 88 s average per call). Measured here: same files cost
  3.0–3.3 s via `node_modules/.bin/eslint` vs **47–86 ms warm** via
  `eslint_d`, with byte-identical output — once pinned. v15's resolver
  (`lib/resolver.js`) `require.resolve`s eslint from
  `[ESLINT_D_ROOT?, daemon cwd]` and only falls back to its bundled v10;
  the daemon's cwd is not your shell's, so **set
  `ESLINT_D_ROOT="$(git rev-parse --show-toplevel)"`** (and
  `ESLINT_D_MISS=fail` to hard-fail instead of silently using the bundled
  engine). Verify with `eslint_d status` → it printed
  `local eslint v9.39.4` after pinning. **Do not use `--stdin`:**
  measured twice, it exits 0 printing nothing while local eslint reports
  real errors. Pass real file paths only, and diff against
  `node_modules/.bin/eslint` when a file has violations.
- **`typescript-language-server` + pi-lens instead of raw `tsc`.**
  `tsc --noEmit` was shell-out 445× (2.64 h) — every call is a cold
  full-program compile. `lsp_diagnostics` / `lens_diagnostics` (pi-lens)
  and `module_report` / `read_symbol` give incremental type errors per
  file; reserve a full `tsc` run for final verification.
- **`rg` and `fd` over `grep -r` / `find`** (`find` was used 516×, `fd`
  once). Both ignore `node_modules` and are an order of magnitude faster
  on the virtiofs workspace.

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
- The persistent alert offers an **Attach** button that reopens the room's
  tmux session when the agent was launched inside tmux; it's silently omitted
  when tmux (or alacritty) isn't present.
- Message bodies are flattened from markdown to plain text and trimmed at a
  word boundary, so a cut never strands `**`/`]`/`)` fragments.
- The extension is baked into the image from `pi/extensions/` **and**
  re-synced from the repo on every launch (see "Pi extensions" below), so a
  patched extension reaches containers without a rebuild.
- The first notification may require allowing the terminal / Script Editor in
  **System Settings → Notifications**.

## Skills

Skills reach the container from two sources, merged in
`/home/agent/.agents/skills`:

- **Remote skills** (agent-browser, caveman, glyph, ponytail, …) are
  cloned into the image at build time and baked in.
- **Repo skills** in `agent-skills/` are also baked in by the
  Dockerfile, and — because the image is only rebuilt on demand —
  `agent-spawn` / `agent-attach` re-sync `agent-skills/` into the
  container on **every launch**.

So a new skill (a `SKILL.md` dropped under `agent-skills/<name>/`) shows up on
the next launch with **no rebuild**. To also bake it into the image for fresh
`docker run` / `docker compose` containers, run `build.sh` (or
`agent-attach --build`).

## Pi extensions provisioning

Mechanism (measured, not assumed): `~/.pi/agent/{settings.json,models.json,
mcp.json,extensions/}` are populated **only at image build time** — the
Dockerfile does `COPY pi/ /tmp/pi-config/` and merges it into
`~/.pi/agent/` (excluding the host-arch `npm/`, and deleting
`extensions/permissions.ts`, which is host-only). Nothing re-synced them at
launch, so a patched extension (e.g. under `pi/extensions/<name>/`) never
reached a reused container — and even the baked copy drifted (a stale
`notify-desktop.ts` with `question.ts` missing was observed).

`agent-spawn` / `agent-attach` now `docker cp` the **entire**
`pi/extensions/` directory into the container on each launch (merge
pattern like skills; `permissions.ts` is re-dropped after the cp). Pi
auto-discovers `*.ts` **and** `<name>/index.ts` subdirectory packages
(`docs/extensions.md:117-118`), so a vendored package placed at
`pi/extensions/<name>/` lands and loads without an image rebuild.
For patched **installed** packages (the pi-memory 0.4.2 class of bug):
drop files at `pi/npm-patches/<pkg>/` and the scripts merge them onto
`~/.pi/agent/npm/node_modules/<pkg>/` every launch — delivery path
only, no patches are vendored yet. Merge semantics mean removing a
patched file needs cleanup inside the container. The canary
`pi/extensions/r1-loadmarker.ts` appends a receipt on import, proving
delivery **and** load (`ls ~/.pi/agent/extensions/.r1-load-receipt`).
`pi update --extensions` still installs registry packages from
`settings.json` at build time; the launch-time sync overlays repo files.

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
  the image via `npm`. BM25 keyword search works offline; the vector
  ("semantic"/"deep") modes download their GGUF models into `~/.cache/qmd`,
  which is now the persistent `agent-cache` volume — downloaded once, not
  once per recreate.
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

- **Recreation is the first-class "change" operation.** Docker fixes
  port mappings, capabilities, and the network namespace at create
  time. Because all durable state is in volumes, recreating a
  container to change ports is cheap — the scripts already self-heal
  stale mounts this way, so the port diff reuses that pattern.
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
