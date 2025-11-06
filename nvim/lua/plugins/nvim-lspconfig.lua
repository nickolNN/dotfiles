return {
  "neovim/nvim-lspconfig",
  event = "LazyFile",
  opts = {
    servers = {
      json = {
        filetypes = { "json" },
      },
      cssls = {},
      angularls = {
        root_dir = function(_, on_dir)
          if vim.fs.find({ "angular.json", "nx.json" }, { upward = true })[1] then
            on_dir()
          end
        end,
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
