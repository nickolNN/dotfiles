-- Kilo Code & Neovim Integration — entry point (lazy.nvim will load this)

local state = {
  kilo_buf = nil,
  kilo_win = nil,
  kilo_chan = nil,
  _window_buf_map = {},
}

-- Wire modules together (module-path requires)
local terminal = require("plugins.kilo-integration.terminal")(state)

-- Merge handler tables into one
local key_handlers = vim.tbl_extend(
  "force",
  require("plugins.kilo-integration.send_file")(terminal, state),
  require("plugins.kilo-integration.send_under_cursor")(terminal, state)
)

-- Apply keymaps
require("plugins.kilo-integration.keymaps")(terminal, key_handlers)

return {}
