# Dotfiles

## Conventions

- **Keep docs in sync with functionality.** When you change a script, config,
  or workflow, update the documentation that describes it in the same change
  (this `AGENTS.md`, `dotfiles-agent/README.md`, `GLOBAL_AGENTS.md`, etc.).
  Treat stale docs as a bug — don't let code and docs drift apart.
- **Keep skills in sync too.** When you change something a skill describes
  (in `agent-skills/` or the remote skills shipped into the image), update
  that skill's `SKILL.md` in the same change — its frontmatter description
  and body are documentation the agent reads, and a stale skill is a bug.

## Setup

- `brew bundle` from `Brewfile` installs all CLI tools and fonts
- Neovim plugins auto-install on first launch; run `:Lazy sync` to update
- tmux plugins managed by TPM (prefix + I to install)

## Tmux

- Prefix is `Ctrl-a` (not Ctrl-b), mapped in `tmux/tmux.conf`
- Alacritty launches tmux on startup
  (`alacritty/alacritty.toml:21`) — tmux is always the outer
  shell
- Pane nav: `Ctrl-a h/j/k/l`; split: `Ctrl-a "` (horizontal), `Ctrl-a %` (vertical)
- `Ctrl-a a` sends prefix (needed in nested tmux sessions)
- Clipboard: `set-clipboard on` + `Ms` terminal override — OSC 52 escape-последовательности
  (копирование через `Ctrl+X` в pi) пробрасываются в системный буфер через Alacritty
- Status bar: hand-rolled hackerman theme in `tmux/tmux.conf`
  (neon pill styling, `heading.sh` for the git branch)

## Neovim (LazyVim)

- Plugins: `nvim/lua/plugins/*.lua` + extras in `lazyvim.json`
  (Angular, Go, TypeScript, Vue, JSON, Markdown, ESLint)
- LSP: `nvim/lua/plugins/nvim-lspconfig.lua` overrides —
  `angularls` only triggers if `angular.json`/`nx.json` in cwd
  tree
- Formatting: Lua→stylua, TS/JS→eslint_d, Vue→eslint_d+stylelint, Go→golines+golangci-lint
- Completion: `blink.cmp` with lsp, buffer, path, snippets sources (`nvim/lua/plugins/blink.lua`)
- Colorscheme: hackerman neon-on-black (`OwaisQuadri/hackerman.nvim` via
  `nvim/lua/plugins/colorscheme.lua`) — neon green accent with teal/aqua/mint/lime/purple
- Mason: `eslint_d`, `golines`, `golangci-lint`, `stylelint` auto-installed (`nvim/lua/plugins/mason.lua`)
- Inlay hints disabled globally
- Agent integrations: shared core in `nvim/lua/plugins/agent-integration/`
  provides terminal toggle, context send, keymaps — each agent is a thin
  wrapper (`kilo-integration/init.lua`, `pi-integration/init.lua`)
- Kilo: `<leader>k*` keymaps, command `kilo .`, simple pattern terminal detection
- Pi: `<leader>p*` keymaps, command `pi`, strict command-segment terminal
  detection, bracketed paste (`\x1b[200~`…`\x1b[201~`)
- Both: `<leader>{k,p}{f,d,m,l,a,w}` send
  file/folder/function/line/diagnostics/word, uppercase = focus
- `nvim/.neoconf.json` with env var
  `NVIM_LAZYVIM_NEOCONFJSON_PATH`

## OpenCode / Kilo

- Provider: custom LiteLLM proxy
- Requires env var for API key authentication
- `kilo/opencode.jsonc` and `kilo/kilo.jsonc` are gitignored;
  create locally

## Pi (pi coding agent)

- `PI_CODING_AGENT_DIR=~/.config/pi` (set in `~/.zshrc`)
- Config directory is this repo's `pi/` — fully git-backed
- `GLOBAL_AGENTS.md` — shared agent rules (agent-agnostic)
- `pi/AGENTS.md` → symlink to `GLOBAL_AGENTS.md`
- `kilo/AGENTS.md` → symlink to `GLOBAL_AGENTS.md`
- `pi/mcp.json` — MCP server definitions (kilo has its own copy in
  `kilo/kilo.jsonc`) — gitignored
- MCP uses pi 0.99's built-in support (`pi mcp list`, `/mcp`); the old
  `pi-mcp-adapter` extension and its `mcp-adapter.json` files are gone.
  Schema notes: disabled servers use `enabled: false` (not the adapter's
  `disabled`), and a project `<repo>/.pi/mcp.json` entry *replaces* the
  global entry of the same name — no merge — so it must carry its own
  `command`/`url` and cannot be a bare enable/disable stub
- `pi/settings.json`, `pi/web-search.json`, `pi/themes/`, `pi/extensions/`
  tracked
- `pi/models.json` gitignored — holds literal API keys, never commit
- `pi/sync-thinking-rules.sh` — syncs `reasoning` / `thinkingLevelMap` in
  `models.json` from pi's model catalog (`models-store.json`, refreshed by
  `pi update --models`); matches custom-provider models by normalized
  id/name plus an `ALIASES` map and touches no other field; run `--dry-run`
  first
- Long-term memory is `pi-memory` (listed in `pi/settings.json`): the host
  store is `~/.config/pi/memory`, set via `PI_MEMORY_DIR` in `~/.zshrc`;
  container agents write to the shared `agent-memory` Docker volume
  instead (`dotfiles-agent/README.md` → "Long-term memory")
- Runtime data (sessions, memory, npm, auth, caches) gitignored via the
  root `.gitignore` — lives in the same dir but never committed
- Old `~/.pi/agent/` is superseded; `PI_CODING_AGENT_DIR`
  redirects Pi to `~/.config/pi`

## dotfiles-agent (Docker dev environment)

Full docs: `dotfiles-agent/README.md`. Quick reference:

- `dotfiles-agent/` builds the `dotfiles-agent` image (node 24, Go, neovim,
  bun, LSPs, browsers, nginx, pi + skills); uid/gid-aligned to the host user.
  `nginx` exists so a repo's micro-frontend proxy (`nginx-local/conf.d/*.conf` +
  `docker-compose.yaml`) can run **natively** — docker-in-docker is unavailable,
  so the agent translates compose volumes/hosts and serves with `nginx -c`
- Aliases (via `dotfiles-agent/install-aliases.sh`): `agent-spawn`,
  `agent-attach`, `agent-fwd`, `agent-stop`
- Containers are per-directory (`container-name.sh`); durable state is in
  volumes, so recreating a container is cheap and safe
- Local inference: `dotfiles-agent/sync-models.sh` runs on every spawn/attach —
  copies the host's `pi/models.json` in and rewrites host-loopback `baseUrl`s to
  the container gateway (host router must bind `0.0.0.0`, or run a relay on a
  spare port via `AGENT_LOCAL_INFERENCE_HOST`)
- Agent rooms are per-task: `spawn-pi-agent.sh` (`--room NAME`) and
  `attach.sh -- pi` set `PI_AGENT_ROOM` to the folder basename (the
  `pi-agents-talk-to-each-other` extension then ignores the global
  `defaultRoom`); issue-resolver runs step agents in `issue-<issue_id>`
- `agent-skills/` is re-synced into the container on every launch, so a new
  skill shows up without a rebuild (rebuild only to bake it into the image)
- Ports come in two flavors:
  - Declared: `agent-spawn -p HOST:GUEST` / `agent-attach -p HOST:GUEST`
    (repeatable; bare `PORT` ≡ `PORT:PORT`). Stateless — the live mapping is
    diffed against `docker inspect` and the container recreated only on
    mismatch; omitting `-p` leaves ports untouched.
  - Ad-hoc: `agent-fwd up|down|list HOST:GUEST` — a `--network container:`
    sidecar publishes a port into a *running* container without a restart.
- Gotcha: fixed ports only (no `-p 0:PORT`); the in-container dev server must
  listen on `0.0.0.0`.
- Corporate HTTPS: VPN routing already reaches containers (Docker Desktop
  NATs through macOS, which holds the VPN routes/DNS) — what fails is trust.
  Drop CA certificates into `dotfiles-agent/certs/` (**any file names**,
  `*.pem`/`*.crt`) and `build.sh` feeds both stores: OpenSSL for
  `git`/`curl`/chromium, and `NODE_EXTRA_CA_CERTS` for Node — whose built-in
  Mozilla bundle `update-ca-certificates` never touches, which is why
  `yarn install` fails on an internal registry while `curl` succeeds. Empty
  folder = normal, the build step is conditional; private keys are refused.
- Per-machine `docker run` flags (no rebuild): `AGENT_DOCKER_ARGS="--dns …"`
  / `"-e HTTPS_PROXY=http://host.docker.internal:PORT"` / `--add-host` —
  stored as a container label and diffed, so changing it *recreates* the
  container (killing running agents); set it before spawning

## Excluded from git

- `yarn/*`, `zed/*`, `configstore/*`, `neofetch/*`,
  `gtk-2.0/*`, `htop/*`, `tmux/plugins`, `nvim/lazy-lock.json`,
  `.DS_Store`, `kilo/opencode.jsonc`, `kilo/kilo.jsonc`,
  `pi/sessions/`, `pi/memory/`, `pi/npm/node_modules/`, `pi/auth.json`,
  `pi/models.json`, `pi/mcp.json`, `pi/mcp-auth.json`, `pi/mcp.log*`,
  `pi/models-store.json`, `pi/trust.json`, `pi/*.sh`,
  `dotfiles-agent/certs/*` (except `.gitkeep`, which must stay tracked so the
  folder exists for the image build), `.agents`

## Branches

- `main` — stable dotfiles
- `feature/lazyvim` — Neovim/LazyVim migration
