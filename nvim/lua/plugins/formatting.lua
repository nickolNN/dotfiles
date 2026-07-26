require("conform").setup({
  formatters_by_ft = {
    lua = { "stylua" },
    typescript = { "eslint_d" },
    typescriptreact = { "eslint_d" },
    javascript = { "eslint_d" },
    javascriptreact = { "eslint_d" },
    vue = { "eslint_d" },
    go = { "goimports", "golines", "golangci-lint" },
    html = { "eslint_d" },
  },
})

vim.api.nvim_create_autocmd("BufWritePre", {
  group = vim.api.nvim_create_augroup("nvim_format", { clear = true }),
  callback = function()
    if vim.g.autoformat then
      require("conform").format({ bufnr = 0 })
    end
  end,
})
