return {
  "stevearc/conform.nvim",
  opts = {
    formatters_by_ft = {
      lua = { "stylua" },
      typescript = { "eslint_d" },
      typescriptreact = { "eslint_d" },
      javascript = { "eslint_d" },
      javascriptreact = { "eslint_d" },
      vue = { "eslint_d", "stylelint" },
      go = { "gofmt", "goimports", "golines" },
      html = { "eslint_d" },
    },
  },
}
