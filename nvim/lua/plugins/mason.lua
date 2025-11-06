return {
  "mason-org/mason.nvim",
  opts = function(_, opts)
    table.insert(opts.ensure_installed, "eslint_d")
    table.insert(opts.ensure_installed, "golines")
    table.insert(opts.ensure_installed, "stylelint")
  end,
}
