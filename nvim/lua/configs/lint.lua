require("lint").linters_by_ft = {
  -- javascript = { "eslint_d" },
  -- typescript = { "eslint_d" },
  -- html = { "eslint_d" },
  -- go = { "golangcilint" },
}
-- vim.api.nvim_create_autocmd({ "BufWritePost" }, {
--   callback = function()
--     -- try_lint without arguments runs the linters defined in `linters_by_ft`
--     -- for the current filetype
--     require("lint").try_lint()
--   end,
-- })
