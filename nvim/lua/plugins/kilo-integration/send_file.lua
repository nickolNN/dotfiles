-- Sending current file or file+line context to Kilo chat

local buffer = require("plugins.kilo-integration.buffer_utils")

return function(terminal)
  local function send_context(text, message)
    local chan = buffer.ensure_context(terminal)
    if not chan then
      return
    end
    vim.api.nvim_chan_send(chan, text)
    terminal.focus_active_terminal()
    vim.notify(message, vim.log.levels.INFO)
  end

  local function send_current_file_containing_folder()
    local current_folder = (buffer.get_relative_path():match("(.*)/") or ".")
    send_context("@" .. current_folder .. "/", "Folder added to Kilo context")
  end

  local function send_current_file_to_kilo()
    send_context("@" .. buffer.get_relative_path() .. " ", "File added to Kilo context")
  end

  local function send_current_file_with_line()
    local line_number = vim.api.nvim_win_get_cursor(0)[1]
    send_context(
      "@" .. buffer.get_relative_path() .. " line " .. line_number .. "\n",
      "File + line context added to Kilo"
    )
  end

  return {
    send_current_file = send_current_file_to_kilo,
    send_current_file_with_line = send_current_file_with_line,
    send_current_file_containing_folder = send_current_file_containing_folder,
  }
end
