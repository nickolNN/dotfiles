# Dotfiles

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
- Status bar: `fabioluciano/tmux-powerkit` — no metrics (`tmux/tmux.conf`)

## Neovim (LazyVim)

- Plugins: `nvim/lua/plugins/*.lua` + extras in `lazyvim.json`
  (Angular, Go, TypeScript, Vue, JSON, Markdown, ESLint)
- LSP: `nvim/lua/plugins/nvim-lspconfig.lua` overrides —
  `angularls` only triggers if `angular.json`/`nx.json` in cwd
  tree
- Formatting: Lua→stylua, TS/JS→eslint_d, Vue→eslint_d+stylelint, Go→golines+golangci-lint
- Completion: `blink.cmp` with lsp, buffer, path, snippets sources (`nvim/lua/plugins/blink.lua`)
- Colorscheme: Matrix green-on-black (`iruzo/matrix-nvim` via `nvim/lua/plugins/colorscheme.lua`)
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
- `pi/mcp.json` — MCP server definitions (kilo has its own copy in `kilo/kilo.jsonc`)
- `pi/settings.json` and `pi/models.json` tracked (models use
  `$ENV_VAR` refs, not real keys)
- `pi/extensions/` tracked (e.g. `question-tool.ts`)
- Runtime data (sessions, npm, auth, caches) gitignored via
  `pi/.gitignore` — lives in the same dir but never committed
- Old `~/.pi/agent/` is superseded; `PI_CODING_AGENT_DIR`
  redirects Pi to `~/.config/pi`

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
