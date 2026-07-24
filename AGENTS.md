## Setup

- `brew bundle` from `Brewfile` installs all CLI tools and fonts
- Neovim plugins auto-install on first launch; run `:Lazy sync` to update
- tmux plugins managed by TPM (prefix + I to install)

## Tmux

- Prefix is `Ctrl-a` (not Ctrl-b), mapped in `tmux/tmux.conf`
- Alacritty launches tmux on startup (`alacritty/alagritty.toml:21`) — tmux is always the outer shell
- Pane nav: `Ctrl-a h/j/k/l`; split: `Ctrl-a "` (horizontal), `Ctrl-a %` (vertical)
- `Ctrl-a a` sends prefix (needed in nested tmux sessions)
- Status bar: `fabioluciano/tmux-powerkit` — no metrics (`tmux/tmux.conf`)

## Neovim (LazyVim)

- Plugins: `nvim/lua/plugins/*.lua` + extras in `lazyvim.json` (Angular, Go, TypeScript, Vue, JSON, Markdown, ESLint)
- LSP: `nvim/lua/plugins/nvim-lspconfig.lua` overrides — `angularls` only triggers if `angular.json`/`nx.json` in cwd tree
- Formatting: Lua→stylua, TS/JS→eslint_d, Vue→eslint_d+stylelint, Go→golines+golangci-lint
- Completion: `blink.cmp` with lsp, buffer, path, snippets sources (`nvim/lua/plugins/blink.lua`)
- Colorscheme: Tokyonight with transparent sidebars/floats (`nvim/lua/plugins/colorscheme.lua`)
- Mason: `eslint_d`, `golines`, `golangci-lint`, `stylelint` auto-installed (`nvim/lua/plugins/mason.lua`)
- Inlay hints disabled globally
- Custom Kilo integration plugins live in `nvim/lua/plugins/kilo-integration/`
- `nvim/lua/plugins/example.lua` is dead code (template); `nvim/.neoconf.json` with env var `NVIM_LAZYVIM_NEOCONFJSON_PATH`

## OpenCode / Kilo

- Provider: custom LiteLLM proxy
- Requires env var for API key authentication
- `kilo/opencode.jsonc` is gitignored; create locally

## Excluded from git

- `yarn/*`, `zed/*`, `configstore/*`, `neofetch/*`, `gtk-2.0/*`, `htop/*`, `tmux/plugins`, `nvim/lazy-lock.json`, `.DS_Store`, `kilo/opencode.jsonc`, `.agents`

## Branches

- `main` — stable dotfiles
- `feature/lazyvim` — Neovim/LazyVim migration
