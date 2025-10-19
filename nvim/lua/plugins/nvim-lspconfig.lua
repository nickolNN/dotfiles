return {
  "neovim/nvim-lspconfig",
  event = "LazyFile",
  opts = {
    servers = {
      -- html = { enabled = true },
      css = { enabled = true },
      angularls = { enabled = true },
      eslint = { enabled = true },
      json = {
        filetypes = { "json" },
      },
      ts_ls = {
        enabled = true,
        filetypes = { "typescript", "html", "typescriptreact", "typescript.tsx", "htmlangular" },
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
        root_markers = { "package.json", "tsconfig.json", "jsconfig.json", ".git" },
      },
      vtsls = { enabled = false },
      gopls = {
        completeUnimported = true,
        usePlaceholders = true,
        staticcheck = true,
        analyses = {
          unusedparams = true,
          staticcheck = true,
          gofumpt = true,
        },
      },
    },
  },
}
