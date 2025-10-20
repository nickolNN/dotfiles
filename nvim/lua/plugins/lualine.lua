return {
  "nvim-lualine/lualine.nvim",
  event = "VeryLazy",
  opts = function(_, opts)
    table.insert(opts.sections.lualine_x, {
      function()
        return {
          {
            require("minuet.lualine"),
            -- the follwing is the default configuration
            -- the name displayed in the lualine. Set to "provider", "model" or "both"
            -- display_name = 'both',
            -- separator between provider and model name for option "both"
            -- provider_model_separator = ':',
            -- whether show display_name when no completion requests are active
            -- display_on_idle = false,
          },
          "encoding",
          "fileformat",
          "filetype",
        }
      end,
    })
  end,
}
