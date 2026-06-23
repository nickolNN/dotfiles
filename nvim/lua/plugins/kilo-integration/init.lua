-- Kilo Code & Neovim Integration — entry point (lazy.nvim will load this)

local state = {
  kilo_buf = nil,
  kilo_win = nil,
  kilo_chan = nil,
  fs_handle = nil,
}

-- Wire modules together (module-path requires)
local terminal = require("plugins.kilo-integration.terminal")(state)

-- Merge handler tables into one
local key_handlers = vim.tbl_extend("force",
  require("plugins.kilo-integration.send_file")(terminal),
  require("plugins.kilo-integration.send_under_cursor")(terminal)
)

-- Setup watcher (autocmds, dir cleanup, fs event)
local watcher = require("plugins.kilo-integration.watcher")
state.watch_group = watcher.setup(state)

-- Apply keymaps
require("plugins.kilo-integration.keymaps")(terminal, key_handlers)

return {}
