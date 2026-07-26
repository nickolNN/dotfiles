# Neovim: LazyVim → kickstart + `vim.pack` migration

**Runtime:** Neovim 0.12.4 · **Target:** kickstart-style config, native
`vim.pack` plugin manager, no LazyVim, no Snacks.
**Source of truth:** this plan + the grilling session that produced 37 ADRs.

---

## 1. Goal

Replace the LazyVim distro at `~/.config/nvim` with a hand-built,
kickstart-style config that uses Neovim 0.12's built-in `vim.pack`
plugin manager. Keep exactly the functionality the user chose during
the grilling session (30 plugins + the local `kilo-integration`
module); drop the 9 plugins that failed the drop-by-default test;
re-implement the 6 utilities that Snacks used to provide as small
native helpers. Persist the domain artifacts (glossary + ADRs).

## 2. Approach (execution decisions — recommended, veto-able)

- **Staging via `NVIM_APPNAME`.** Build the entire new config under
  `NVIM_APPNAME=nvim-kickstart` (config `~/.config/nvim-kickstart`,
  data `~/.local/share/nvim-kickstart`). The live editor at
  `~/.config/nvim` is **never touched** until a verified swap in T14.
  Fully reversible. Cost: one-time re-download of plugins + mason
  tools in the staging data dir.
- **All `nvim` commands during the build MUST be prefixed** with
  `NVIM_APPNAME=nvim-kickstart`.
- **No code comments** (user rule) except where behavior is genuinely
  non-obvious. Lua formatted with `stylua` (config has `stylua.toml`).
- **Docs wrap at 80 chars** (user rule).
- **Sequential execution:** run tasks T1→T15 in order; each task's
  Validation gate must pass before the next starts.

### Verified environment facts
- Present: `git`, `lazygit`, `rg`, `gcc`/`cc`, `node`/`npm`, `go`.
- **MISSING: `fzf`** — required by fzf-lua. Installed in T0.
- `~/.config/nvim-kickstart` and `~/.local/share/nvim-kickstart` are
  both free (no collision).
- Current mason has 21 binaries at `~/.local/share/nvim/mason/bin`
  (not reused under staging; re-installed fresh — see T6).

## 3. How the orchestrator runs this

For each task Tn, call:

```
task(subagent_type="general",
     description="<task title>",
     prompt=PREAMBLE + "\n\n" + <Tn body below>)
```

`PREAMBLE` (Section 4) is prepended to **every** task. T1 additionally
writes `MIGRATION.md` (Appendix A) into the staging config so later
tasks can read full context from disk. Run tasks strictly in order;
verify each gate before proceeding. Stop and report if any gate fails.

## 4. PREAMBLE (prepend to every @general prompt)

```
You are migrating a Neovim config from the LazyVim distro to a
kickstart-style config using Neovim 0.12's built-in `vim.pack`.

ENVIRONMENT (use exactly):
- Neovim 0.12.4. Prefix EVERY nvim command with: NVIM_APPNAME=nvim-kickstart
- Staging config root:  ~/.config/nvim-kickstart
- Staging data root:    ~/.local/share/nvim-kickstart
- The LIVE config at ~/.config/nvim must NOT be modified until task T14.
- Full design context lives in ~/.config/nvim-kickstart/MIGRATION.md
  (created in T1). READ IT FIRST for the bill of materials, ADR ledger,
  helper specs, and keymap dispositions relevant to your task.

CONVENTIONS:
- No code comments unless a behavior is genuinely non-obvious.
- Format all Lua with stylua (run: stylua <file>; a stylua.toml exists).
- Plugins are added ONLY via vim.pack.add(...). No lazy.nvim specs.
- There is NO lazy-loading framework: load plugins eagerly and call
  require("plugin").setup(opts) yourself. Use FileType/autocmds only
  where a plugin genuinely needs deferral.
- Verify headlessly where possible, e.g.:
  NVIM_APPNAME=nvim-kickstart nvim --headless "+lua <check>" +qa 2>&1
  Capture stderr; ANY "E511"/"Error"/stack-trace output is a failure.

When done, report: files created/changed, the exact validation command
you ran and its output, and any deviation from this prompt.
```

---

## 5. Tasks

### T0 — Prerequisites (no @general needed; orchestrator runs directly)
- `brew install fzf` (fzf-lua dependency). Verify `command -v fzf`.
- Confirm `NVIM_APPNAME=nvim-kickstart nvim --headless +qa` exits 0.
- Gate: `fzf` on PATH; headless nvim exits 0.

### T1 — Scaffold staging config + write MIGRATION.md
**Depends:** T0
**@general body:**
```
GOAL: Create the empty staging config skeleton and the MIGRATION.md
reference doc that all later tasks read.

STEPS:
1. mkdir -p ~/.config/nvim-kickstart/lua/config
           ~/.config/nvim-kickstart/lua/plugins
2. Copy ~/.config/nvim/stylua.toml and ~/.config/nvim/.luarc.json into
   the staging root (read source, write to staging; do NOT modify source).
3. Write ~/.config/nvim-kickstart/init.lua:
     vim.g.mapleader = " "
     vim.g.maplocalleader = "\\"
     require("config.pack")
     require("config.options")
     require("config.autocmds")
     require("config.keymaps")
   (modules are created in later tasks; for now create each as a minimal
   `return {}`-style stub file so init.lua loads without error:
   lua/config/pack.lua, options.lua, autocmds.lua, keymaps.lua — each
   containing only an empty placeholder that will be overwritten later.)
4. Write ~/.config/nvim-kickstart/MIGRATION.md with EXACTLY the content
   of Appendix A of the plan (bill of materials, ADR ledger, helper
   specs, keymap tables, conventions).

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua print(vim.g.mapleader)" +qa 2>&1
  -> prints a space, no errors. MIGRATION.md exists and is non-empty.
```

### T2 — Plugin bootstrap: `pack.lua` + build hooks
**Depends:** T1
**@general body:**
```
GOAL: Install all 30 plugins via vim.pack and wire build hooks.

CONTEXT: See MIGRATION.md "Bill of materials" for the exact 30 repos.
vim.pack semantics (Neovim 0.12, :help vim.pack):
- vim.pack.add({ "https://github.com/author/plugin", ... }) installs to
  site/pack/core/opt and runs :packadd. During init.lua sourcing the
  plugin's plugin/ files are NOT auto-sourced; you must require()+setup
  yourself (done in later tasks).
- Build steps move to a PackChanged autocmd keyed on ev.data.spec.name
  and ev.data.kind ("install"/"update").

STEPS:
1. Overwrite lua/config/pack.lua:
   - local gh = function(x) return "https://github.com/" .. x end
   - Register a PackChanged autocmd BEFORE vim.pack.add that runs
     `vim.cmd("TSUpdate")` for name=="nvim-treesitter" and
     `vim.cmd("MasonUpdate")` for name=="mason.nvim" on install/update.
   - vim.pack.add({ ...all 30 gh(...) repos from MIGRATION.md... }).
2. Do NOT setup() any plugin here (later tasks do that).

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua vim.print(#vim.pack.get())" +qa 2>&1
  -> prints 30 (allow a few installs to finish; re-run if <30).
  Then: ls ~/.local/share/nvim-kickstart/site/pack/core/opt | wc -l -> 30.
NOTE: Also check where the lockfile lands:
  ls ~/.config/nvim-kickstart/nvim-pack-lock.json ~/.config/nvim/nvim-pack-lock.json
  Report which path exists (vim.pack may hardcode ~/.config/nvim/). This
  matters for the T14 swap.
```

### T3 — Defaults: `options.lua` + `autocmds.lua`
**Depends:** T1
**@general body:**
```
GOAL: Port the defaults layer (pure vim.opt / vim.api — no plugin deps).

CONTEXT: Source defaults are in the LazyVim install at
~/.local/share/nvim/lazy/LazyVim/lua/lazyvim/config/options.lua and
autocmds.lua. Read them. Also read the user's current overrides at
~/.config/nvim/lua/config/options.lua and ~/.config/nvim/lua/config/lazy.lua.

STEPS:
1. Overwrite lua/config/options.lua: port LazyVim's options BUT:
   - DROP `formatexpr` (calls LazyVim.format.formatexpr) and
     `statuscolumn` (calls LazyVim.statuscolumn) — leave both unset.
   - KEEP grepprg="rg --vimgrep" (rg is installed).
   - ADD native rounded LSP hover border:
       vim.lsp.config("*", { hover = { border = "rounded" } })
     (replaces the rounded hover that noice used to provide — noice is
     dropped).
   - Merge the user's custom options: colorcolumn="100";
     sessionoptions="buffers,curdir,folds,help,tabpages,winsize,winpos,terminal,localoptions";
     guicursor append "t:block-blinkon0-blinkoff0-TermCursor".
   - Set vim.g.root_spec = { "cwd" } (user's override).
   - Set vim.g.autoformat = true (used by the conform task).
2. Overwrite lua/config/autocmds.lua: copy LazyVim's 8 autocmds VERBATIM
   (checktime, highlight_yank, resize_splits, last_loc, close_with_q,
   man_unlisted, wrap_spell, json_conceal, auto_create_dir). Rename the
   augroup prefix from "lazyvim_" to "nvim_" (cosmetic; no LazyVim dep).

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua vim.print(vim.o.colorcolumn, vim.o.grepprg)" +qa 2>&1
  -> "100" and "rg --vimgrep", no errors.
```

### T4 — Native helpers module `util.lua`
**Depends:** T1
**@general body:**
```
GOAL: Write the 6 native helpers that replace dropped Snacks features.

CONTEXT: See MIGRATION.md "Native helpers" for specs. No plugin may be
used — pure vim.api / vim.fn / vim.o.

STEPS: Create lua/config/util.lua returning a table M with:
- M.toggle(option)         -> returns a fn that flips vim.o[option] and
                              vim.notify-s the result. (Used for <leader>u*.)
- M.toggle_diagnostics()   -> flips vim.diagnostic.enable() globally.
- M.toggle_inlay_hints()    -> flips vim.lsp.inlay_hint.enable for buf 0.
- M.terminal(opts)         -> open a :terminal in a split (opts.cwd,
                              opts.position default "float"/"right");
                              M.terminal.toggle() reuses/hides the buf.
                              Buffer-local <C-/> hides it.
- M.bufdelete(buf)         -> if only one listed buffer, :enew first;
                              then nvim_buf_delete(buf,{force=true}) so
                              the window is NOT closed.
- M.notify_history()       -> vim.cmd("messages") (native history).
- M.zoom()                 -> vim.cmd("silent! only").
- M.zen()                  -> toggle laststatus/showtabline/number/
                              signcolumn/cursorline off-on.
- M.lazygit()              -> M.terminal({ cmd="lazygit", cwd=git root }).

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua local u=require('config.util'); vim.print(type(u.toggle),type(u.terminal),type(u.bufdelete))" +qa 2>&1
  -> three "function", no errors.
```

### T5 — Keymaps: `keymaps.lua` (Pile A verbatim + Pile B via helpers)
**Depends:** T3, T4
**@general body:**
```
GOAL: Port the full keymap surface.

CONTEXT: Source keymaps:
~/.local/share/nvim/lazy/LazyVim/lua/lazyvim/config/keymaps.lua (read it)
+ the user's ~/.config/nvim/lua/config/keymaps.lua.
See MIGRATION.md "Keymap dispositions" for Pile A (copy verbatim) vs
Pile B (rewrite via config.util / fzf-lua). fzf-lua picker keymaps are
wired in T10 — here, leave <leader>s*/<leader>g* OUT (T10 owns them).

STEPS: Overwrite lua/config/keymaps.lua using vim.keymap.set (NOT
LazyVim.safe_keymap_set). Include:
- Pile A verbatim: better j/k (gj/gk), <C-hjkl> window nav, <C-arrow>
  resize, <A-jk> move-line (n/i/v), saner n/N, undo break-points
  (,/./;), <C-s> save, <>/ >gv indent, gco/gcO comment, <leader>fn enew,
  diagnostic jumps ]d/[d/]e/[e/]w/[w (vim.diagnostic.jump), quickfix/
  loclist toggles <leader>xq/xl + [q/]q, tabs <leader><tab>*, window
  splits <leader>- / <leader>| / <leader>wd, buffer prev/next
  <S-h>/<S-l>/[b/]b, <leader>bb / <leader>` (e#).
- Pile B via require("config.util"):
  * <leader>bd -> util.bufdelete(0)
  * <leader>ft -> util.terminal({cwd=vim.fn.getcwd()})
  * <leader>fT -> util.terminal({cwd = root})  (root = vim.fs.root or cwd)
  * <C-/> and <C-_> -> util.terminal.toggle()
  * <leader>gg -> util.lazygit()
  * <leader>n  -> util.notify_history()
  * <leader>wm and <leader>uZ -> util.zoom()
  * <leader>uz -> util.zen()
  * <leader>qq -> :qa
  * Toggles (util.toggle): <leader>us spell, uw wrap, uL relativenumber,
    uc conceallevel, ul number, uA showtabline, ub background;
    <leader>ud -> util.toggle_diagnostics(); <leader>uh ->
    util.toggle_inlay_hints(). (DROP dim/animate/indent/scroll — no
    native equivalent.)
  * <leader>cf -> vim.lsp.buf.format (native; conform on-save is T7).
- DROP: <leader>. scratch, <leader>L changelog, Snacks.profiler maps.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua vim.print(vim.fn.maparg('<C-s','n') ~= '')" +qa 2>&1
  -> v:true, no errors. (Spot-check a few: <leader>bd, <C-/>.)
```

### T6 — LSP: native vim.lsp.config + mason + mason-lspconfig
**Depends:** T2
**@general body:**
```
GOAL: Wire LSP using Neovim's native API + mason for binaries.

CONTEXT: See MIGRATION.md "LSP" section. Servers to enable (10):
vtsls, gopls, vue_ls, angularls, jsonls, html, cssls, marksman, lua_ls,
eslint. Mason tools (21) listed in MIGRATION.md. User overrides to port
(from ~/.config/nvim/lua/plugins/nvim-lspconfig.lua): inlay_hints
DISABLED globally; eslint format=false; json filetypes={json};
angularls filetypes={typescript,html,htmlangular} with a root_dir guard
that only activates when angular.json/nx.json is found upward from cwd.

STEPS: Create lua/plugins/lsp.lua (required from init.lua after pack):
1. mason.nvim setup with ensure_installed = <21 tools>.
2. mason-lspconfig setup with ensure_installed = <10 servers> and
   automatic_enable = false (we enable explicitly below).
3. vim.lsp.config("*", { capabilities = { workspace = { fileOperations =
   { didRename=true, willRename=true } } } }).
4. vim.lsp.config per server: lua_ls (checkThirdParty=false, hint
   enable=true), eslint (format disabled), angularls (filetypes +
   root_dir guard using vim.fs.root(buf, {"angular.json","nx.json"})),
   jsonls (filetypes json). Others: minimal.
5. vim.lsp.enable({ the 10 servers }).
6. vim.diagnostic.config({ virtual_text={spacing=4,prefix="●"},
   severity_sort=true, underline=true, signs=true }).
7. LspAttach autocmd setting buffer-local keymaps: gd definition, gr
   references, gI implementation, gy type_definition, gD declaration, K
   hover, gK signature_help, <leader>ca code_action (n+x), <leader>cr
   rename. (Inlay hints stay OFF per user.)
8. Add `require("plugins.lsp")` to init.lua.

VALIDATION:
  Open a lua file headlessly and confirm a client attaches:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+edit ~/.config/nvim-kickstart/init.lua" \
    "+lua vim.defer_fn(function() vim.print(vim.lsp.get_clients()) ; vim.cmd('qa') end, 3000)" 2>&1
  -> at least one client (lua_ls) listed. Mason: confirm
  ~/.local/share/nvim-kickstart/mason/bin grows toward 21 entries
  (may take time; report count).
```

### T7 — Completion (blink) + formatting (conform) + trouble
**Depends:** T2, T6
**@general body:**
```
GOAL: Completion, format-on-save, diagnostics UI.

CONTEXT: Port the user's existing configs verbatim (they are already
standalone): ~/.config/nvim/lua/plugins/blink.lua and
~/.config/nvim/lua/plugins/formatting.lua (read them).

STEPS:
1. lua/plugins/completion.lua: blink.cmp setup with sources default
   {lsp,buffer,path,snippets}, ghost_text disabled, menu+docs border
   "rounded". (friendly-snippets is dropped — do not add a snippet
   collection; LSP snippets still work.)
2. lua/plugins/formatting.lua: conform.nvim with formatters_by_ft:
   lua=stylua; typescript/typescriptreact/javascript/javascriptreact/
   vue/html=eslint_d; go={goimports,golines,golangci-lint}. Add a
   BufWritePre autocmd that formats when vim.g.autoformat is true
   (require("conform").format({bufnr=0})). Also <leader>cF format
   injected (optional).
3. lua/plugins/trouble.lua: trouble.nvim setup; keymaps <leader>xx
   diagnostics toggle, <leader>xX buffer diagnostics, <leader>cs
   symbols, <leader>xQ qflist, <leader>xL loclist.
4. require all three from init.lua.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua vim.print(package.loaded['conform']~=nil or true); require('conform'); require('trouble'); vim.print('ok')" +qa 2>&1
  -> "ok", no errors.
```

### T8 — Treesitter + textobjects + autotag + ts-comments
**Depends:** T2
**@general body:**
```
GOAL: Syntax, indent, structural textobjects, tag autoclose.

CONTEXT: See MIGRATION.md ADR-011..013,015. Folds are DISABLED (user
does not fold). Highlighting may use native vim.treesitter.start.

STEPS: lua/plugins/treesitter.lua:
1. nvim-treesitter setup: ensure_installed = {bash,c,diff,html,
   javascript,jsdoc,json,lua,luadoc,luap,markdown,markdown_inline,
   printf,python,query,regex,toml,tsx,typescript,vim,vimdoc,xml,yaml,
   go,vue} (add go+vue for the user's langs). indent.enable=true,
   highlight.enable=true, folds DISABLED (do not set foldmethod=expr).
2. nvim-treesitter-textobjects: move keys ]f/[f (function), ]c/[c
   (class), ]a/[a (parameter) — set_jumps=true.
3. nvim-ts-autotag setup {} (auto-close + rename for html/jsx/vue).
4. ts-comments.nvim setup {} (TSX/Vue-aware commentstring).
5. require from init.lua.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+edit ~/.config/nvim-kickstart/init.lua" \
    "+lua vim.defer_fn(function() vim.print(vim.treesitter.highlighter.active ~= nil); vim.cmd('qa') end, 2000)" 2>&1
  Parsers: confirm `go`,`lua`,`typescript` present via
  :lua vim.print(require('nvim-treesitter').get_installed()) (report).
```

### T9 — UI chrome: lualine, bufferline, which-key, alpha, icons, themes, cursor
**Depends:** T2, T4
**@general body:**
```
GOAL: Build the "full chrome" UI (no noice — it is dropped).

STEPS:
1. lua/plugins/ui.lua:
   - lualine: PLAIN sections only — lualine_a mode; b branch; c
     diagnostics + filetype + path (use plain %:~:. path, NOT
     LazyVim.lualine.*); x diff (source from vim.b.gitsigns_status_dict);
     y progress+location. DROP root_dir/pretty_path/dap/lazy/profiler/
     clock/noice sections. options.theme="auto", globalstatus=true.
   - bufferline: diagnostics="nvim_lsp", always_show_bufferline=false,
     close_command = function(n) require("config.util").bufdelete(n) end,
     right_mouse_command same. Keys: <S-h>/<S-l> cycle, [b/]b, <leader>bp
     pin, <leader>br/bl close right/left.
   - which-key: preset="helix"; spec groups for <leader> b(buffer)
     c(code) f(file/find) g(git) k(kilo) q(quit) s(search) u(ui)
     x(diagnostics) <tab>(tabs).
   - mini.icons setup {} (mocks nvim-web-devicons).
   - alpha-nvim: a dashboard with buttons f(find file -> fzf files),
     g(grep -> fzf live_grep), r(recent -> fzf oldfiles), c(config),
     s(restore session -> persistence load), l(Lazy->:Pack? use
     vim.pack.update), q(quit). (fzf commands wired in T10; reference
     them by their fzf-lua lua calls.)
2. lua/plugins/colorscheme.lua: matrix-nvim; set colorscheme="matrix";
   tokyonight installed as fallback only (do not activate). Wrap
   vim.cmd.colorscheme("matrix") in pcall with "tokyonight" fallback.
3. lua/plugins/smear-cursor.lua: port the user's exact opts from
   ~/.config/nvim/lua/plugins/smear-cursor.lua (read it): time_interval
   7, cursor_color "none", stiffness 0.65, trailing_stiffness 0.5,
   stiffness_insert_mode 0.6, trailing_stiffness_insert_mode 0.55,
   damping 0.9, damping_insert_mode 0.9, distance_stop_animating 0.25.
4. require all from init.lua.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua vim.print(vim.g.colors_name)" +qa 2>&1
  -> "matrix", no errors. lualine/bufferline load without E511.
```

### T10 — fzf-lua pickers + git pickers + todo
**Depends:** T2, T9
**@general body:**
```
GOAL: Wire the finder (replaces Snacks.picker).

CONTEXT: See MIGRATION.md ADR-032/033/034. fzf binary is installed (T0).

STEPS: lua/plugins/fzf.lua:
1. require("fzf-lua").setup({ profile = "fzf-native" }) (or "default"
   if fzf-native unavailable; report which).
2. Keymaps (n): <leader>sf files, <leader>sg live_grep, <leader><space>
   buffers, <leader>sw grep_string, <leader>ss lsp_document_symbols,
   <leader>sd diagnostics, <leader>sr resume, <leader>s. oldfiles.
3. Git pickers: <leader>gl git_commits, <leader>gf git_bcommits (current
   file history), <leader>gb git_blame (line). (gitsigns owns hunk
   blame/diff — see T11.)
4. DROP bindings: help(sh), keymaps(sk), commands(sc).
5. todo-comments.nvim setup {}; <leader>st -> :TodoTrouble (NOT
   TodoTelescope — no telescope). ]t/[t jump next/prev todo.
6. require from init.lua.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua require('fzf-lua'); vim.print(vim.fn.maparg('<leader>sf','n')~='')" +qa 2>&1
  -> v:true, no errors.
```

### T11 — Git: gitsigns (feature-scoped) + lazygit
**Depends:** T2, T4
**@general body:**
```
GOAL: Git gutter + scoped features per ADR-030/031.

CONTEXT: Port the user's gitsigns opts from
~/.config/nvim/lua/plugins/gitsigns.lua (current_line_blame=true, delay
500). KEEP features: gutter signs, current-line-blame, stage/reset
hunk, preview hunk inline, blame line/buffer popup, diff-this. DROP:
]h/[h hunk navigation and the ih select-hunk textobject (do NOT bind).

STEPS: lua/plugins/gitsigns.lua: gitsigns.setup with current_line_blame
+ delay 500, and an on_attach that maps ONLY: <leader>ghs stage_hunk,
<leader>ghr reset_hunk, <leader>ghS stage_buffer, <leader>ghu
undo_stage_hunk, <leader>ghR reset_buffer, <leader>ghp
preview_hunk_inline, <leader>ghb blame_line(full), <leader>ghB blame,
<leader>ghd diffthis, <leader>ghD diffthis("~"). require from init.lua.
(lazygit <leader>gg already wired in T5 via util.lazygit.)

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+edit ~/.config/nvim-kickstart/init.lua" \
    "+lua vim.defer_fn(function() vim.print(package.loaded.gitsigns~=nil); vim.cmd('qa') end,1500)" 2>&1
  -> v:true, no errors.
```

### T12 — Editing extras: mini.pairs, mini.ai, grug-far, markdown, sessions
**Depends:** T2, T8
**@general body:**
```
GOAL: Remaining editing/markdown/session plugins.

STEPS:
1. lua/plugins/editing.lua:
   - mini.pairs setup {} (autopairs insert+command, not terminal).
   - mini.ai setup with treesitter textobjects: custom_textobjects f
     (@function.outer/inner), c (@class.outer/inner), o (@block/@conditional/
     @loop) via require("mini.ai").gen_spec.treesitter. (Depends on
     nvim-treesitter-textobjects queries from T8.)
   - grug-far.nvim setup { headerMaxWidth=80 }; <leader>sr opens it
     (transient, prefilled filesFilter from current ext).
2. lua/plugins/markdown.lua: render-markdown.nvim setup {} (ft markdown).
   (markdown-preview is dropped — do not add.)
3. lua/plugins/sessions.lua: persistence.nvim setup {}; keymaps
   <leader>qs load, <leader>qS select, <leader>ql load last, <leader>qd
   stop. (sessionoptions already set in T3.)
4. require all from init.lua.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua require('mini.pairs'); require('mini.ai'); require('grug-far'); require('persistence'); vim.print('ok')" +qa 2>&1
  -> "ok", no errors.
```

### T13 — Port `kilo-integration` (local module)
**Depends:** T1
**@general body:**
```
GOAL: Port the user's custom kilo-integration from a lazy.nvim spec to a
plain Lua module. Keep ALL 13 keymaps (both focus and non-focus cases).

CONTEXT: Source: ~/.config/nvim/lua/plugins/kilo-integration/ (read every
file: init.lua, keymaps.lua, terminal.lua, format_context.lua,
send_file.lua, send_under_cursor/{init.lua,fn_name.lua}). It is pure
vim.api/vim.treesitter with ZERO LazyVim coupling — only the lazy-spec
wrapper (keys={...}, dir=..., lazy=true) must go.

STEPS:
1. Copy the whole kilo-integration folder to
   ~/.config/nvim-kickstart/lua/plugins/kilo-integration/ (preserve
   structure). Do NOT modify the source folder.
2. Replace the lazy-spec init.lua with a plain module: a file
   lua/plugins/kilo.lua that require()s the terminal/send_file/
   send_under_cursor/keymaps pieces and registers ALL keymaps eagerly
   (the same 13: kk toggle; kf/kF file; kd/kD folder; km/kM function;
   kl/kL file+line; ka/kA diagnostics; kw/kW word). Adjust internal
   require paths from "plugins.kilo-integration.X" to match the new
   location.
3. require("plugins.kilo") from init.lua.

VALIDATION:
  NVIM_APPNAME=nvim-kickstart nvim --headless \
    "+lua vim.print(vim.fn.maparg('<leader>kk','n')~='', vim.fn.maparg('<leader>kM','n')~='')" +qa 2>&1
  -> v:true v:true, no errors.
```

### T14 — Full validation + go-live swap + cleanup
**Depends:** T3–T13
**@general body:**
```
GOAL: Validate the staging config end-to-end, then swap it live.

STEPS:
1. Full headless validation (capture ALL stderr; any error = STOP and
   report, do NOT swap):
   - NVIM_APPNAME=nvim-kickstart nvim --headless "+lua vim.print(#vim.pack.get())" +qa  -> 30
   - :checkhealth non-interactively:
     NVIM_APPNAME=nvim-kickstart nvim --headless "+checkhealth" \
       "+w! /tmp/nvim-kickstart-health.txt" +qa ; then read the file,
       report ERROR/WARNING counts.
   - Open a TS file and a Go file headlessly; confirm an LSP client
     attaches to each (vim.lsp.get_clients()).
   - Confirm no "E511"/"Error detected" in `:messages` after startup:
     NVIM_APPNAME=nvim-kickstart nvim --headless "+messages" +qa.
2. Only if ALL gates pass, perform the swap (these are shell moves;
   confirm each succeeds before the next):
   a. mv ~/.config/nvim            ~/.config/nvim.lazyvim.bak
   b. mv ~/.local/share/nvim       ~/.local/share/nvim.lazyvim.bak
   c. mv ~/.config/nvim-kickstart  ~/.config/nvim
   d. mv ~/.local/share/nvim-kickstart ~/.local/share/nvim
3. Re-validate under the DEFAULT appname (no NVIM_APPNAME):
   nvim --headless "+lua vim.print(#vim.pack.get(), vim.g.colors_name)" +qa
   -> 30  "matrix".
4. Locate the vim.pack lockfile (see T2 note) and ensure a copy exists
   at ~/.config/nvim/nvim-pack-lock.json. Report its final path.
5. Do NOT delete the .bak dirs or the orphaned
   ~/.local/share/nvim.lazyvim.bak/lazy — leave for the user to remove
   after a soak period. Report their paths + sizes.

VALIDATION: default `nvim` starts with 30 plugins, colorscheme matrix,
no startup errors. Report the health summary.
```

### T15 — Persist domain artifacts (glossary + ADRs)
**Depends:** T14
**@general body:**
```
GOAL: Write the domain-modeling artifacts into the new config repo.

STEPS:
1. mkdir -p ~/.config/nvim/docs/adr
2. Write ~/.config/nvim/docs/glossary.md from Appendix B (terms: Plugin,
   Feature, Keymap, Default, Coupling, Verdict {KEEP/PORT/REPLACE/DROP}).
   Wrap lines at 80 chars.
3. Write ~/.config/nvim/docs/adr/README.md containing the full ADR
   ledger (ADR-001..037) from Appendix B, one short entry each (status +
   one-line rationale). Wrap at 80 chars.
4. If ~/.config/nvim is a git repo, do NOT commit (user commits). Just
   report `git status` of the new docs.

VALIDATION: both files exist, non-empty, lines <=80 chars
(awk 'length>80' reports nothing).
```

---

## 6. Global validation (post-T14, user-facing)

- `nvim` opens with matrix theme, lualine + bufferline + alpha dashboard.
- `<leader>sf` / `<leader>sg` / `<leader><space>` (fzf-lua) work.
- Open a `.ts` and `.go` file: LSP attaches, completion (blink) fires,
  save triggers conform formatting.
- `<leader>kk` toggles the Kilo panel; `<leader>km` sends function context.
- `<leader>gg` opens lazygit; gitsigns blame shows inline.
- `:checkhealth` has no ERROR lines.

## 7. Rollback

At any point before T14 completes: nothing live changed — just delete
`~/.config/nvim-kickstart` and `~/.local/share/nvim-kickstart`.
After T14 swap: restore with
`mv ~/.config/nvim.lazyvim.bak ~/.config/nvim` and
`mv ~/.local/share/nvim.lazyvim.bak ~/.local/share/nvim`.

## 8. Out of scope / open questions

- **DAP debugging:** not installed before, not added (no ADR requested).
- **Telescope / neo-tree / oil / AI plugins:** explicitly absent.
- **lazydev.nvim:** kept for now (ADR-008); revisit after the config
  stabilizes — drop candidate.
- **vim.pack lockfile path:** may be hardcoded to `~/.config/nvim/`
  regardless of NVIM_APPNAME (T2 verifies). If staging writes the LIVE
  dir's lockfile, that is acceptable but noted; T14 ensures the final
  lockfile lands in `~/.config/nvim/`.
- **Commit policy:** no git commits are made by any task unless the user
  explicitly asks.

---

## Appendix A — MIGRATION.md content (T1 writes this verbatim)

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

## Appendix B — Glossary + ADR ledger (T15 writes these)

### Glossary
- Plugin: a third-party repo installed via vim.pack.
- Feature: one discrete capability a plugin provides.
- Keymap: a binding invoking a feature.
- Default: a non-interactive effect (autocmd/option).
- Coupling: hidden dependency on LazyVim.*/Snacks.* runtime.
- Verdict: KEEP | PORT | REPLACE | DROP.

### ADR ledger
001 lspconfig KEEP (definitions only; keymaps native via LspAttach)
002 mason KEEP (all tools; reproducibility)
003 blink.cmp KEEP
004 conform KEEP (Go chain + format-on-save)
005 nvim-lint DROP (configured to do nothing)
006 friendly-snippets DROP (no snippet usage)
007 trouble KEEP (full chrome; needs nui)
008 lazydev KEEP-for-now (revisit post-migration)
009 SchemaStore KEEP-small
010 LSP servers KEEP-ALL (10)
011 nvim-treesitter KEEP (mgmt+indent; highlight native; folds OFF; :TSUpdate hook)
012 ts-comments KEEP-small
013 nvim-ts-autotag KEEP
014 mini.ai KEEP (af/if/ac/ic)
015 nvim-treesitter-textobjects KEEP (coupled to mini.ai; ]f/[f)
016 mini.pairs KEEP
017 flash.nvim DROP (never used s)
018 grug-far KEEP (multi-file refactors)
019 todo-comments KEEP (]t/[t)
020 plenary KEEP (needed by todo-comments + grug-far)
021 lualine KEEP+PORT (plain sections)
022 mini.icons KEEP
023 smear-cursor KEEP
024 catppuccin DROP
025 bufferline KEEP (close_command → util.bufdelete)
026 noice DROP (native; hover border → vim.lsp)
027 which-key KEEP
028 alpha-nvim KEEP (replaces Snacks.dashboard)
029 themes matrix(active)+tokyonight(fallback)
030 gitsigns KEEP (signs,blame,stage/reset,preview,blame-popup,diff; DROP ]h/[h, ih)
031 lazygit KEEP via native :terminal (<leader>gg)
032 fzf-lua KEEP (fzf-native; sf sg space sw ss sd sr s.; DROP sh sk sc)
033 git pickers KEEP (gl gf gb)
034 todo picker <leader>st → :TodoTrouble
035 persistence KEEP (custom sessionoptions)
036 render-markdown KEEP; markdown-preview DROP
037 mason-lspconfig KEEP (ensure_installed → 10 servers)
