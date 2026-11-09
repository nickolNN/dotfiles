# Dotfiles

## Conventions

- **Keep docs in sync with functionality.** When you change a script, config,
  or workflow, update the document that describes it in the same change — and
  treat a stale doc as a bug.
- **Keep skills in sync too.** A skill's `SKILL.md` (description and body) is
  documentation an agent reads: change the behaviour it describes in the same
  change.
- **Code comments: follow the nearest repo rule, and it wins.** The rule lives
  next to the code — `issue-resolver/AGENTS.md` allows **none**, so there no
  docstring and no `//`, and the non-obvious "why" goes to
  `docs/DESIGN-NOTES.md`. This file's "few" is the fallback for repos that have
  no rule of their own, never a licence to add one where a repo says zero; a
  skill that likes explanatory comments (`clean-code`) loses to it. No Russian in
  code — not in a comment, docstring, or TODO. Russian stays only where it is
  data: UI labels, user-facing strings, test titles.

## Where the truth lives

This file is the index. Each subject has one authoritative document — read it
there instead of trusting a summary here:

| Subject | Document |
| ------- | -------- |
| Agent rules that apply everywhere | `GLOBAL_AGENTS.md` (`pi/AGENTS.md` and `kilo/AGENTS.md` are symlinks to it) |
| The container I run in: toolchain, ports, durability, what to suggest to the user | the `container-environment` skill |
| Building and operating that container | `dotfiles-agent/README.md` |
| Corporate CA / VPN trust | `dotfiles-agent/certs/README.md` |
| The issue-resolver project | `issue-resolver/AGENTS.md`, then `docs/DESIGN-NOTES.md` |

The configs themselves are authoritative for their own details — `nvim/lua/`,
`tmux/tmux.conf`, `alacritty/alacritty.toml`, `.gitignore`, `Brewfile`. Do not
re-copy their contents into prose; it rots.

## Setup

- `brew bundle` from `Brewfile`; Neovim plugins auto-install (`:Lazy sync` to
  update); tmux plugins via TPM (prefix + `I`).
- tmux prefix is `Ctrl-a` (not `Ctrl-b`), and `Ctrl-a a` sends that prefix to a
  nested session. Alacritty launches tmux on startup, so tmux is always the
  outer shell.
- Neovim is LazyVim: plugins in `nvim/lua/plugins/*.lua` plus `lazyvim.json`
  extras, formatting by `eslint_d`/`stylelint`/`stylua`/`golines`, agent
  integrations (kilo, pi: terminal toggle, context send, `<leader>{k,p}*`
  keymaps) in `nvim/lua/plugins/agent-integration/`.
- `kilo/opencode.jsonc` and `kilo/kilo.jsonc` are gitignored; create locally.

## Pi

- `PI_CODING_AGENT_DIR=~/.config/pi` (set in `~/.zshrc`); the config directory
  is this repo's `pi/` and is fully git-backed.
- `pi/models.json` and `pi/mcp.json` are **gitignored and hold secrets** — never
  commit them. `pi/mcp.json` uses pi's built-in MCP support (disabled servers:
  `enabled: false`; a project `.pi/mcp.json` entry *replaces* the global one of
  the same name, with no merge).
- `pi/settings.json` enables `codemode` through `"defaultTools": ["+codemode"]`:
  without that key the tool exists only as an MCP side effect and disappears
  when MCP is off.
- `pi/sync-thinking-rules.sh` syncs `reasoning`/`thinkingLevelMap` into
  `models.json` from pi's baked provider catalogs (`--dry-run` by default,
  `--write` to apply). `provider1` is Aliyun token-plan.
- Long-term memory is `pi-memory`: `~/.config/pi/memory` on the host
  (`PI_MEMORY_DIR`), the shared `agent-memory` volume inside containers.
- Runtime data (sessions, memory, npm, auth, caches) lives in the same directory
  and is gitignored.

## dotfiles-agent

`dotfiles-agent/` builds the image and the `agent-*` aliases. Two things that
bite:

- Containers are per directory and disposable; durable state is in volumes, so
  recreating one is cheap. Changing ports or `AGENT_DOCKER_ARGS` *recreates* it,
  killing whatever runs inside — set them before spawning.
- `agent-skills/` is re-synced into the container on every launch, so a new
  skill needs no rebuild — but a skill added to the **Dockerfile** list does, and
  the launch overlay cannot add it.

Full detail: `dotfiles-agent/README.md`.

## Branches

- `main` — stable dotfiles
- `feature/lazyvim` — Neovim/LazyVim migration