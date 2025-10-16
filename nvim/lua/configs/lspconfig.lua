require("nvchad.configs.lspconfig").defaults()
require "configs.ts"
require "configs.eslint"
require "configs.gopls"

local servers = { "html", "cssls", "angularls" }
vim.lsp.enable(servers)
-- read :h vim.lsp.config for changing options of lsp servers

local hover = vim.lsp.buf.hover
---@diagnostic disable-next-line: duplicate-set-field
vim.lsp.buf.hover = function()
  return hover {
    max_width = 100,
    -- max_height = 14,
    border = "rounded",
  }
end
