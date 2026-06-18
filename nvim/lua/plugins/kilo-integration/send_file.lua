-- Sending current file or file+line context to Kilo chat

local buffer = require("plugins.kilo-integration.buffer_utils")

return function(terminal)
  local function _focus_terminal()
    terminal:focusActiveTerminal()
  end

  local function send_current_file_containing_folder()
    local chan = buffer.ensure_context(terminal)
    if not chan then
      return
    end

    local current_folder = (buffer.get_relative_path():match("(.*)/") or ".")
    local text_to_send = "@" .. current_folder .. "/"
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("Folder added to Kilo context", vim.log.levels.INFO)
  end

  local function send_current_file_to_kilo()
    local chan = buffer.ensure_context(terminal)
    if not chan then
      return
    end

    local text_to_send = "@" .. buffer.get_relative_path() .. " "
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("File added to Kilo context", vim.log.levels.INFO)
  end

  local function send_current_file_with_line()
    local chan = buffer.ensure_context(terminal)
    if not chan then
      return
    end

    local line_number = vim.api.nvim_win_get_cursor(0)[1]
    local text_to_send = "@" .. buffer.get_relative_path() .. " line " .. line_number .. "\n"
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("File + line context added to Kilo", vim.log.levels.INFO)
  end

  return {
    send_current_file = send_current_file_to_kilo,
    send_current_file_with_line = send_current_file_with_line,
    send_current_file_containing_folder = send_current_file_containing_folder,
  }
end
