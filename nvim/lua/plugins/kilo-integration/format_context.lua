local buffer = require("plugins.kilo-integration.context")

-- Shared utilities for building and sending file/context references to Kilo

local function warn(msg)
  vim.notify("[kilo-debug] " .. msg, vim.log.levels.WARN)
end

local function send(terminal, state, text, message, opts, path)
  opts = opts or {}
  if not path or path == "" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return nil
  end
  local chan
  if state and state.kilo_chan then
    chan = state.kilo_chan
  else
    chan = buffer.ensure_kilo_terminal(terminal, state)
  end
  if not chan then return end
  vim.api.nvim_chan_send(chan, text)
  if not opts.skip_focus then
    if not terminal:focus_active_terminal() then
      warn("focus_active_terminal returned false, skipping")
    end
  end
  if not opts.skip_notify then
    vim.notify(message, vim.log.levels.INFO)
  end
end

return {
  make_file_reference = buffer.make_file_reference,

  send = send,

  send_file = function(terminal, state, message, opts)
    opts = opts or {}
    local relative_path = buffer.get_relative_path()
    send(terminal, state, buffer.make_file_reference(relative_path, " "), message, opts, relative_path)
  end
}

