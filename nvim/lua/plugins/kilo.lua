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
