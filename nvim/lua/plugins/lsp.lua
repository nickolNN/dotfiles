require("mason").setup({
  ensure_installed = {
    "eslint_d",
    "gofumpt",
    "goimports",
    "golangci-lint",
    "golines",
    "gopls",
    "lua-language-server",
    "markdown-toc",
    "markdownlint-cli2",
    "marksman",
    "angular-language-server",
    "shfmt",
    "stylelint",
    "stylua",
    "tree-sitter-cli",
    "css-lsp",
    "eslint-lsp",
    "html-lsp",
    "json-lsp",
    "vtsls",
    "vue-language-server",
  },
})

require("mason-lspconfig").setup({
  ensure_installed = {
    "vtsls",
    "gopls",
    "vue_ls",
    "angularls",
    "jsonls",
    "html",
    "cssls",
    "marksman",
    "lua_ls",
    "eslint",
  },
  automatic_enable = false,
})

vim.lsp.config("*", {
  capabilities = {
    workspace = {
      fileOperations = {
        didRename = true,
        willRename = true,
      },
    },
  },
})

vim.lsp.config("lua_ls", {
  settings = {
    Lua = {
      workspace = {
        checkThirdParty = false,
      },
      hint = {
        enable = true,
      },
    },
  },
})

vim.lsp.config("eslint", {
  settings = {
    format = {
      enable = false,
    },
  },
})

vim.lsp.config("angularls", {
  filetypes = { "typescript", "html", "htmlangular" },
  root_dir = function(buf)
    return vim.fs.root(buf, { "angular.json", "nx.json" })
  end,
})

local ok, schemastore = pcall(require, "schemastore")
local jsonls_settings = {
  json = {
    validate = {
      enable = true,
    },
  },
}
if ok then
  jsonls_settings.json.schemas = schemastore.json.schemas()
end

vim.lsp.config("jsonls", {
  filetypes = { "json" },
  settings = jsonls_settings,
})

vim.lsp.config("vtsls", {})
vim.lsp.config("gopls", {})
vim.lsp.config("vue_ls", {})
vim.lsp.config("html", {})
vim.lsp.config("cssls", {})
vim.lsp.config("marksman", {})

vim.lsp.enable({
  "vtsls",
  "gopls",
  "vue_ls",
  "angularls",
  "jsonls",
  "html",
  "cssls",
  "marksman",
  "lua_ls",
  "eslint",
})

vim.diagnostic.config({
  virtual_text = {
    spacing = 4,
    prefix = "●",
  },
  severity_sort = true,
  underline = true,
  signs = true,
})

vim.api.nvim_create_augroup("nvim_lsp", {})
vim.api.nvim_create_autocmd("LspAttach", {
  group = "nvim_lsp",
  callback = function(ev)
    local function set_keymap(lhs, rhs, desc)
      vim.keymap.set("n", lhs, rhs, { buffer = ev.buf, silent = true, desc = desc })
    end
    set_keymap("gd", vim.lsp.buf.definition, "Go to definition")
    set_keymap("gr", vim.lsp.buf.references, "Go to references")
    set_keymap("gI", vim.lsp.buf.implementation, "Go to implementation")
    set_keymap("gy", vim.lsp.buf.type_definition, "Go to type definition")
    set_keymap("gD", vim.lsp.buf.declaration, "Go to declaration")
    set_keymap("K", vim.lsp.buf.hover, "Show hover")
    set_keymap("gK", vim.lsp.buf.signature_help, "Show signature help")
    set_keymap("<leader>ca", vim.lsp.buf.code_action, "Code action")
    vim.keymap.set("x", "<leader>ca", vim.lsp.buf.code_action, { buffer = ev.buf, silent = true, desc = "Code action" })
    set_keymap("<leader>cr", vim.lsp.buf.rename, "Rename symbol")
  end,
})
require("lazydev").setup({})
