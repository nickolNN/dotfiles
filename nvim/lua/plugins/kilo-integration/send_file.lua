-- Sending current file or file+line context to Kilo chat

local function get_relative_path()
  local current_file = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd() .. "/"
  return current_file:gsub("^" .. cwd, ""):gsub("^%./", "")
end

local function send_current_file_containing_folder_to_kilo(state, terminal)
  local current_folder = (get_relative_path():match("(.*)/") or ".")

  if current_folder == "" or vim.bo.buftype == "terminal" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return
  end

  local target_buf, target_chan = terminal.find(state)

  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  local text_to_send = "@" .. current_folder .. "/ "
  vim.api.nvim_chan_send(target_chan, text_to_send)
  vim.notify("Folder added to Kilo context", vim.log.levels.INFO)

  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_set_current_win(state.kilo_win)
    vim.cmd("startinsert")
  end
end

local function send_current_file_to_kilo(state, terminal)
  local current_file = get_relative_path()

  if current_file == "" or vim.bo.buftype == "terminal" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return
  end

  local target_buf, target_chan = terminal.find(state)

  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  local text_to_send = "@" .. current_file .. " "
  vim.api.nvim_chan_send(target_chan, text_to_send)
  vim.notify("File added to Kilo context", vim.log.levels.INFO)

  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_set_current_win(state.kilo_win)
    vim.cmd("startinsert")
  end
end

local function send_current_file_with_line_to_kilo(state, terminal)
  local current_file = get_relative_path()

  if current_file == "" or vim.bo.buftype == "terminal" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return
  end

  local target_buf, target_chan = terminal.find(state)

  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  local line_number = vim.api.nvim_win_get_cursor(0)[1]
  local text_to_send = "@" .. current_file .. " line " .. line_number .. " "

  vim.api.nvim_chan_send(target_chan, text_to_send)
  local str_len = #text_to_send - 1
  local escape_code = string.format("\027[%dD", str_len)
  vim.api.nvim_chan_send(target_chan, escape_code)
  vim.notify("File + line context added to Kilo", vim.log.levels.INFO)

  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_set_current_win(state.kilo_win)
    vim.cmd("startinsert")
  end
end

return {
  send_current_file = send_current_file_to_kilo,
  send_current_file_with_line = send_current_file_with_line_to_kilo,
  send_current_file_containing_folder = send_current_file_containing_folder_to_kilo,
}
