-- Shared utilities for building and sending file/context references to Kilo

local buffer = require("plugins.kilo-integration.context")

local function make_file_reference(path, suffix)
  return "@" .. path .. (suffix or " ")
end

local send_to_kilo = {}

function send_to_kilo.send(terminal, text, message, opts)
  opts = opts or {}
  if not buffer.buffer_is_valid() then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return nil
  end
  local chan = buffer.ensure_kilo_terminal(terminal)
  if not chan then return end
  vim.api.nvim_chan_send(chan, text)
  if not opts.skip_focus then
    terminal:focus_active_terminal()
  end
  if not opts.skip_notify then
    vim.notify(message, vim.log.levels.INFO)
  end
end

function send_to_kilo.send_file(terminal, message)
  send_to_kilo.send(terminal, make_file_reference(buffer.get_relative_path(), " "), message)
end

function send_to_kilo.send_file_with_suffix(terminal, suffix, message)
  send_to_kilo.send(terminal, make_file_reference(buffer.get_relative_path(), suffix), message)
end

return send_to_kilo
