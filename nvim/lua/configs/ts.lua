local util = require "lspconfig/util"

vim.lsp.config("ts_ls", {
  on_attach = function(client, bufnr)
    -- Enable inlay hints (new in TS 5.0+)
    -- if client.supports_method "textDocument/inlayHint" then
    --   vim.lsp.inlay_hint.enable(bufnr, 1)
    -- end
  end,
  settings = {
    typescript = {
      preferences = {
        importModuleSpecifier = "shortest", -- New import style
        jsxAttributeCompletionStyle = "auto", -- Smarter JSX
      },
      inlayHints = {
        includeInlayParameterNameHints = "all",
        includeInlayFunctionParameterTypeHints = true,
      },
      tsserver = {
        experimental = {
          enableProjectDiagnostics = true, -- Better monorepo support
        },
      },
    },
    javascript = {
      preferences = {
        importModuleSpecifier = "shortest",
      },
    },
  },
  root_dir = util.root_pattern("package.json", "tsconfig.json", "jsconfig.json", ".git"),
})
