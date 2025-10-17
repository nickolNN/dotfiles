local util = require "lspconfig/util"

vim.lsp.config("ts_ls", {
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
