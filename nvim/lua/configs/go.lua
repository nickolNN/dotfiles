local go = require "go"

go.setup {
  goimport = "gopls",
  gofmt = "gofmt",
  lsp_keymaps = false,
  tag_options = false,
  diagnostic = { -- set diagnostic to false to disable vim.diagnostic.config setup,
    -- true: default nvim setup
    hdlr = true, -- hook lsp diag handler and send diag to quickfix
    underline = true,
    virtual_text = { spacing = 2, prefix = "" }, -- virtual text setup
    signs = { "", "", "", "" }, -- set to true to use default signs, an array of 4 to specify custom signs
    update_in_insert = false,
  },
}

-- Format-on-save
vim.api.nvim_create_autocmd("BufWritePre", {
  pattern = "*.go",
  callback = function()
    require("go.format").goimports()
  end,
})
