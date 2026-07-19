return {
  "stevearc/conform.nvim",
  opts = {
    formatters_by_ft = {
      lua = { "stylua" },
      typescript = { "eslint_d" },
      typescriptreact = { "eslint_d" },
      javascript = { "eslint_d" },
      javascriptreact = { "eslint_d" },
      vue = { "eslint_d" },
      go = { "golines", "golangci-lint" },
      html = { "eslint_d" },
    },
    on_attach = function(bufnr)
      local map = function(mode, lhs, rhs, opts)
        opts = opts or {}
        opts.builtin = false
        opts.silent = true
        vim.keymap.set(mode, lhs, rhs, opts)
      end
      -- Format on save
      map("n", "<leader>ff", "<cmd>ConformInfo<CR>", { desc = "Conform info" })
      -- Linting on save via conform
      vim.api.nvim_create_autocmd("BufWritePre", {
        group = vim.api.nvim_create_augroup("conform-format", { clear = true }),
        callback = function()
          if vim.bo[bufnr].modified then
            vim.cmd("ConformFormat")
          end
        end,
      })
    end,
  },
}
