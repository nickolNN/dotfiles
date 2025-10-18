vim.lsp.config("gopls", {
  capabilities = vim.lsp.protocol.make_client_capabilities(),
  cmd = { "gopls" },
  filetypes = { "go", "gomod", "gowork", "gotmpl" },
  root_markers = { "go.work", "go.mod", ".git" },
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
})
