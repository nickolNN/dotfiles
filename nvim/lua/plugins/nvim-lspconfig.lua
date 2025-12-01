return {
  "neovim/nvim-lspconfig",
  event = "LazyFile",
  opts = {
    inlay_hints = {
      enabled = false,
    },
    servers = {
      json = {
        filetypes = { "json" },
      },
      html = {},
      cssls = {},
      angularls = {
        filetypes = { "typescript", "html", "htmlangular" },
        -- avoid angulals enabling on non-angular projects
        root_dir = function(_, on_dir)
          if
            vim.fs.find({ "angular.json", "nx.json" }, { upward = true, type = "file", stop = vim.fn.getcwd() })[1]
          then
            on_dir()
          end
        end,
      },
    },
  },
}
