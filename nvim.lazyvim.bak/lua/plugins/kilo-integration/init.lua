-- Kilo Code & Neovim Integration — lazy-loaded on first <leader>k* keypress.
-- dir points at this folder so lazy.nvim treats it as a local (non-git) plugin.
return {
  "kilo-integration",
  dir = vim.fn.stdpath("config") .. "/lua/plugins/kilo-integration",
  lazy = true,
  keys = {
    { "<leader>kk", mode = "n", desc = "Toggle Kilo TUI Panel" },
    { "<leader>kf", mode = "n", desc = "Send current file to Kilo" },
    { "<leader>kF", mode = "n", desc = "Send current file and focus Kilo" },
    { "<leader>kd", mode = "n", desc = "Send current file folder to Kilo" },
    { "<leader>kD", mode = "n", desc = "Send current file folder to Kilo (focus)" },
    { "<leader>km", mode = "n", desc = "Send function under cursor to Kilo" },
    { "<leader>kM", mode = "n", desc = "Send function under cursor to Kilo (focus)" },
    { "<leader>kl", mode = "n", desc = "Send current file + line to Kilo" },
    { "<leader>kL", mode = "n", desc = "Send current file + line to Kilo (focus)" },
    { "<leader>ka", mode = "n", desc = "Send all diagnostics to Kilo" },
    { "<leader>kA", mode = "n", desc = "Send all diagnostics to Kilo (focus)" },
    { "<leader>kw", mode = "n", desc = "Send word under cursor to Kilo" },
    { "<leader>kW", mode = "n", desc = "Send word under cursor to Kilo (focus)" },
  },
  config = function()
    local state = {
      kilo_buf = nil,
      kilo_win = nil,
      kilo_chan = nil,
    }

    local terminal = require("plugins.kilo-integration.terminal")(state)

    local key_handlers = vim.tbl_extend(
      "force",
      require("plugins.kilo-integration.send_file")(terminal, state),
      require("plugins.kilo-integration.send_under_cursor")(terminal, state)
    )

    require("plugins.kilo-integration.keymaps")(terminal, key_handlers)
  end,
}
