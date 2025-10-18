require("nvchad.configs.lspconfig").defaults()
require "configs.ts"
require "configs.eslint"
require "configs.gopls"
require "configs.hover"

vim.lsp.enable { "html", "cssls", "angularls", "ts_ls", "gopls", "eslint" }
