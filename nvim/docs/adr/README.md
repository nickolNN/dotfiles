# ADR Ledger

Architectural decisions for the kickstart + vim.pack migration.

| ADR | Status | Rationale |
| --- | --- | --- |
| ADR-001 | KEEP | definitions only; keymaps native via LspAttach |
| ADR-002 | KEEP | all tools; reproducibility |
| ADR-003 | KEEP | blink.cmp retained as-is |
| ADR-004 | KEEP | Go chain + format-on-save |
| ADR-005 | DROP | configured to do nothing |
| ADR-006 | DROP | no snippet usage |
| ADR-007 | KEEP | full chrome; needs nui |
| ADR-008 | KEEP-for-now | revisit post-migration |
| ADR-009 | KEEP-small | SchemaStore minimal |
| ADR-010 | KEEP-ALL | 10 LSP servers |
| ADR-011 | KEEP | mgmt+indent; highlight native; folds OFF; :TSUpdate hook |
| ADR-012 | KEEP-small | ts-comments minimal |
| ADR-013 | KEEP | nvim-ts-autotag retained |
| ADR-014 | KEEP | mini.ai (af/if/ac/ic) |
| ADR-015 | KEEP | coupled to mini.ai; ]f/[f |
| ADR-016 | KEEP | mini.pairs retained |
| ADR-017 | DROP | never used s |
| ADR-018 | KEEP | grug-far multi-file refactors |
| ADR-019 | KEEP | todo-comments ]t/[t |
| ADR-020 | KEEP | needed by todo-comments + grug-far |
| ADR-021 | KEEP+PORT | plain sections |
| ADR-022 | KEEP | mini.icons retained |
| ADR-023 | KEEP | smear-cursor retained |
| ADR-024 | DROP | catppuccin removed |
| ADR-025 | KEEP | close_command → util.bufdelete |
| ADR-026 | DROP | native; hover border → vim.lsp |
| ADR-027 | KEEP | which-key retained |
| ADR-028 | KEEP | replaces Snacks.dashboard |
| ADR-029 | KEEP | matrix(active)+tokyonight(fallback) |
| ADR-030 | KEEP | signs,blame,stage/reset,preview; DROP ]h/[h, ih |
| ADR-031 | KEEP | via native :terminal (`<leader>gg`) |
| ADR-032 | KEEP | fzf-native; sf sg space sw ss sd sr s.; DROP sh sk sc |
| ADR-033 | KEEP | git pickers gl gf gb |
| ADR-034 | KEEP | todo picker `<leader>st` → :TodoTrouble |
| ADR-035 | KEEP | custom sessionoptions |
| ADR-036 | KEEP | render-markdown; markdown-preview DROP |
| ADR-037 | KEEP | ensure_installed → 10 servers |
