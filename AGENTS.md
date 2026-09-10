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
  (`alacritty/alagritty.toml:21`) — tmux is always the outer
  shell
- Pane nav: `Ctrl-a h/j/k/l`; split: `Ctrl-a "` (horizontal), `Ctrl-a %` (vertical)
- `Ctrl-a a` sends prefix (needed in nested tmux sessions)
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
- `pi/settings.json`, `pi/web-search.json`, `pi/themes/`, `pi/extensions/`
  tracked
- `pi/models.json` gitignored — holds literal API keys, never commit
- Runtime data (sessions, npm, auth, caches) gitignored via
  `pi/.gitignore` — lives in the same dir but never committed
- Old `~/.pi/agent/` is superseded; `PI_CODING_AGENT_DIR`
  redirects Pi to `~/.config/pi`

## dotfiles-agent (Docker dev environment)

Full docs: `dotfiles-agent/README.md`. Quick reference:

- `dotfiles-agent/` builds the `dotfiles-agent` image (node 24, Go, neovim,
  bun, LSPs, browsers, pi + skills); uid/gid-aligned to the host user
- Aliases (via `dotfiles-agent/install-aliases.sh`): `agent-spawn`,
  `agent-attach`, `agent-fwd`, `agent-stop`
- Containers are per-directory (`container-name.sh`); durable state is in
  volumes, so recreating a container is cheap and safe
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

## Excluded from git

- `yarn/*`, `zed/*`, `configstore/*`, `neofetch/*`,
  `gtk-2.0/*`, `htop/*`, `tmux/plugins`, `nvim/lazy-lock.json`,
  `.DS_Store`, `kilo/opencode.jsonc`, `kilo/kilo.jsonc`,
  `pi/sessions/`, `pi/npm/node_modules/`, `pi/auth.json`,
  `pi/mcp-cache.json`, `pi/mcp-onboarding.json`,
  `pi/models-store.json`, `pi/trust.json`, `.agents`

## Branches

- `main` — stable dotfiles
- `feature/lazyvim` — Neovim/LazyVim migration
