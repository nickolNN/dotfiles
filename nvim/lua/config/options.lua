-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
local o = vim.o
o.cursorlineopt = "both" -- to enable cursorline!
vim.g.lazyvim_eslint_auto_format = true

local hover = vim.lsp.buf.hover

---@diagnostic disable-next-line: duplicate-set-field
vim.lsp.buf.hover = function()
  return hover({
    max_width = 100,
    -- max_height = 14,
    border = "rounded",
  })
end
