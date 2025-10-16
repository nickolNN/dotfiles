vim.lsp.config("eslint", {
  on_attach = function(client, bufnr)
    vim.api.nvim_create_autocmd("BufWritePre", {
      pattern = { "*.ts", "*.tsx" },
      callback = function()
        vim.lsp.buf.format { async = false }
        vim.cmd "EslintFixAll" -- Auto-fix on save
      end,
    })
  end,
})
