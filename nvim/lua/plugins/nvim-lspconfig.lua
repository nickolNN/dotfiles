return {
  "neovim/nvim-lspconfig",
  event = "LazyFile",
  opts = {
    servers = {
      json = {
        filetypes = { "json" },
      },
      angularls = {
        filetypes = { "typescript", "html", "htmlangular" },
        root_markers = { "angular.json" },
      },
      -- vtsls = {
      --   on_init = function(client)
      --     client.server_capabilities.documentFormattingProvider = false
      --     client.server_capabilities.documentRangeFormattingProvider = false
      --   end,
      -- },
    },
  },
}
