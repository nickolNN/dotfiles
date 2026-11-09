## Read code with the lenses, not with grep

The pi-lens tools are in this session and they answer code questions that `bash`
answers badly:

- **A name you know** — `symbol_search` (ranked, honours `file:`/`ext:`/`-file:`
  filters), then `read_symbol` for that one body. Not `grep -rn "name" | head`.
- **No name yet** — `project_report` ranks the hubs of a repository and names its
  entry points; `module_report` outlines one file so you read a symbol instead of
  800 lines around it. `read_enclosing` when a diagnostic or a search hit gives
  you a line number and you want the function around it.
- **"Where is this called from?"** — `lsp_navigation` with the definition or
  references operation. `grep` finds the string; the language server finds the
  binding, and it will not miss the call that goes through a re-export.
- **After touching several files** — `lens_diagnostics` with `source: "lsp"`,
  `scope: "paths"` and the batch of files you edited, before running the build.
  It reports the same type errors in seconds, per file, without waiting for a
  full compile. An empty result from a language with no LSP server proves
  nothing: fall back to the build.
- **`ast_grep_search`** for a shape rather than a name (a call with two
  arguments, a `switch` on an enum); `ast_grep_replace` for a mechanical rename
  across files.

Text search stays right for text: config values, log lines, prose. For code
intelligence it is the slowest option and the one that misses.

The `pi-lens-lsp-navigation` and `pi-lens-ast-grep` skills carry the full
parameter tables — read the relevant one when a call returns nothing or a batch
is slow.