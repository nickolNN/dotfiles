-- Sending current file or file+line context to Kilo chat

local TERMINAL_NOT_RUNNING_MSG = "Kilo terminal is not running. Open it first with <leader>kk"
local NOT_A_FILE_MSG = "Current buffer is not a file"

local function get_relative_path()
  local full_path = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd() .. "/"
  local relative = full_path:gsub("^" .. cwd, "")
  return relative:gsub("^%./", "")
end

local function _validate_buffer()
  local path = get_relative_path()
  if path == "" or vim.bo.buftype == "terminal" then
    vim.notify(NOT_A_FILE_MSG, vim.log.levels.WARN)
    return false
  end
  return true
end

return function(terminal)
  local function _get_channel()
    local _, chan = terminal.find()
    if not chan then
      vim.notify(TERMINAL_NOT_RUNNING_MSG, vim.log.levels.WARN)
      return nil
    end
    return chan
  end

  local function _focus_terminal()
    terminal:focusActiveTerminal()
  end

  local function send_current_file_containing_folder()
    if not _validate_buffer() then
      return
    end
    local chan = _get_channel()
    if not chan then
      return
    end

    local current_folder = (get_relative_path():match("(.*)/") or ".")
    local text_to_send = "@" .. current_folder .. "/"
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("Folder added to Kilo context", vim.log.levels.INFO)
  end

  local function send_current_file_to_kilo()
    if not _validate_buffer() then
      return
    end
    local chan = _get_channel()
    if not chan then
      return
    end

    local text_to_send = "@" .. get_relative_path() .. " "
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("File added to Kilo context", vim.log.levels.INFO)
  end

  local function send_current_file_with_line()
    if not _validate_buffer() then
      return
    end
    local chan = _get_channel()
    if not chan then
      return
    end

    local line_number = vim.api.nvim_win_get_cursor(0)[1]
    local text_to_send = "@" .. get_relative_path() .. " line " .. line_number .. "\n"
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
