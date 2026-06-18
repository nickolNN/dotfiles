-- Kilo Code & Neovim Integration — entry point (lazy.nvim will load this)

if vim.g.kilo_integration_loaded then
  return
end

local state = {
  kilo_buf = nil,
  kilo_win = nil,
  kilo_chan = nil,
  fs_handle = nil,
}

-- Wire modules together (module-path requires)
local terminal = require("plugins.kilo-integration.terminal")(state)

local function merge_handlers(handlers, source)
  for k, v in pairs(source) do
    handlers[k] = v
  end
end

local key_handlers = {}
merge_handlers(key_handlers, require("plugins.kilo-integration.send_file")(terminal))
merge_handlers(key_handlers, require("plugins.kilo-integration.send_under_cursor")(terminal))
local watcher = require("plugins.kilo-integration.watcher")

-- Initialize
state.watch_group = vim.api.nvim_create_augroup("KiloSyncGroup", { clear = true })
watcher.setup_autocmds(state.watch_group)
watcher.start_dir_watch(state)
watcher.setup_dir_cleanup(state.watch_group, state)

-- Apply keymaps
require("plugins.kilo-integration.keymaps")(terminal, key_handlers)

-- Guard
vim.g.kilo_integration_loaded = true
return {}
