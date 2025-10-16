local lspconfig = require "lspconfig"
local util = require "lspconfig.util"

lspconfig.gopls.setup {
  -- on_attach = function(client, bufnr)
  --   -- Optional: Set up keybindings for LSP actions here For example:
  -- end,
  capabilities = vim.lsp.protocol.make_client_capabilities(),
  cmd = { "gopls" },
  filetypes = { "go", "gomod", "gowork", "gotmpl" },
  root_dir = util.root_pattern("go.work", "go.mod", ".git"),
  settings = {
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
}
