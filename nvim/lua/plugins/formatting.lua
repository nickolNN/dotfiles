return {
  "stevearc/conform.nvim",
  opts = {
    formatters_by_ft = {
      lua = { "stylua" },
      typescript = { "eslint" },
      html = { "angular", "eslint" },
    },
  },
}
