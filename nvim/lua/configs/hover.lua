local hover = vim.lsp.buf.hover

---@diagnostic disable-next-line: duplicate-set-field
vim.lsp.buf.hover = function()
  return hover {
    max_width = 100,
    -- max_height = 14,
    border = "rounded",
  }
end
