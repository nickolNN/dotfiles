### Bill of materials — KEEP (30 via vim.pack)
UI/chrome: lualine, bufferline, which-key, alpha-nvim, mini.icons,
nui, matrix-nvim, tokyonight (fallback), smear-cursor.
Finder: fzf-lua.
Editing: mini.ai, mini.pairs, nvim-treesitter,
nvim-treesitter-textobjects, nvim-ts-autotag, ts-comments, grug-far,
todo-comments, plenary.
LSP/cmp/format: nvim-lspconfig, mason, mason-lspconfig, blink.cmp,
conform, trouble, lazydev, SchemaStore.
Git/markdown/sessions: gitsigns, render-markdown, persistence.
Local (not via vim.pack): kilo-integration.

### DROP (9) + reason
LazyVim (target), lazy.nvim (→vim.pack), snacks.nvim (→native helpers),
noice (native cmdline/messages; hover→vim.lsp), flash (never used `s`),
nvim-lint (configured to do nothing), friendly-snippets (no snippet
use), catppuccin (unused 3rd theme), markdown-preview (redundant).

### Repos (gh = https://github.com/)
nvim-lualine/lualine.nvim · akinsho/bufferline.nvim ·
folke/which-key.nvim · goolord/alpha-nvim · nvim-mini/mini.icons ·
MunifTanjim/nui.nvim · iruzo/matrix-nvim · folke/tokyonight.nvim ·
sphamba/smear-cursor.nvim · ibhagwan/fzf-lua · nvim-mini/mini.ai ·
nvim-mini/mini.pairs · nvim-treesitter/nvim-treesitter ·
nvim-treesitter/nvim-treesitter-textobjects · windwp/nvim-ts-autotag ·
folke/ts-comments.nvim · MagicDuck/grug-far.nvim ·
folke/todo-comments.nvim · nvim-lua/plenary.nvim ·
neovim/nvim-lspconfig · mason-org/mason.nvim ·
mason-org/mason-lspconfig.nvim · saghen/blink.cmp ·
stevearc/conform.nvim · folke/trouble.nvim · folke/lazydev.nvim ·
b0o/SchemaStore.nvim · lewis6991/gitsigns.nvim ·
MeanderingProgrammer/render-markdown.nvim · folke/persistence.nvim

### LSP servers (10) + mason tools (21)
Servers: vtsls, gopls, vue_ls, angularls, jsonls, html, cssls,
marksman, lua_ls, eslint.
Mason tools: eslint_d, gofumpt, goimports, golangci-lint, golines,
gopls, lua-language-server, markdown-toc, markdownlint-cli2, marksman,
ngserver, shfmt, stylelint, stylua, tree-sitter,
vscode-css-language-server, vscode-eslint-language-server,
vscode-html-language-server, vscode-json-language-server, vtsls,
vue-language-server.
Overrides: inlay hints OFF; eslint format=false; json filetypes={json};
angularls filetypes={typescript,html,htmlangular} + root guard
(angular.json/nx.json upward from cwd).

### Conform formatters_by_ft
lua=stylua · typescript/typescriptreact/javascript/javascriptreact/
vue/html=eslint_d · go={goimports,golines,golangci-lint}.

### Native helpers (replace Snacks) — see T4
toggle, toggle_diagnostics, toggle_inlay_hints, terminal(+toggle),
bufdelete, notify_history, zoom, zen, lazygit.

### Keymap dispositions
Pile A (verbatim): j/k gj-gk, <C-hjkl>, <C-arrows>, <A-jk>, n/N saner,
undo breaks, <C-s>, </>, gco/gcO, diagnostic jumps, qf/loclist, tabs,
splits, buffer nav.
Pile B (via helpers/fzf): bd→bufdelete, ft/fT/<C-/>→terminal,
gg→lazygit, n→notify_history, wm/uZ→zoom, uz→zen, us/uw/uL/uc/ul/uA/ub
→toggles, ud→toggle_diagnostics, uh→toggle_inlay_hints, cf→lsp format.
DROP: scratch(<leader>.), changelog(<leader>L), profiler maps,
dim/animate/indent/scroll toggles.
fzf-lua: sf sg s(space) sw ss sd sr s. ; git gl gf gb ; st→TodoTrouble.
DROP bindings: sh sk sc.
gitsigns KEEP: signs, current_line_blame(500ms), ghs/ghr/ghS/ghu/ghR/
ghp/ghb/ghB/ghd/ghD. DROP: ]h/[h, ih.
kilo: all 13 (kk,kf/kF,kd/kD,km/kM,kl/kL,ka/kA,kw/kW).
