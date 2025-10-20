return {
  "neovim/nvim-lspconfig",
  event = "LazyFile",
  opts = {
    servers = {
      html = { enabled = true, format = { enable = false } },
      cssls = { enabled = true },
      angularls = { enabled = true },
      eslint = { enabled = true },
      json = {
        filetypes = { "json" },
      },
      ts_ls = {
        enabled = true,
        -- disable formatting by ts_ls in favor of eslint for example
        on_init = function(client)
          client.server_capabilities.documentFormattingProvider = false
          client.server_capabilities.documentRangeFormattingProvider = false
        end,
        filetypes = { "typescript", "typescriptreact", "typescript.tsx", "angularhtml", "angular" },
        settings = {
          typescript = {
            format = {
              convertTabsToSpaces = true,
            },
            preferences = {
              importModuleSpecifier = "shortest", -- New import style
              jsxAttributeCompletionStyle = "auto", -- Smarter JSX
            },
            inlayHints = {
              -- includeInlayParameterNameHints = "all",
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
