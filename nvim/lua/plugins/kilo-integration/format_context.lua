local LEADER_TOGGLE = "<leader>kk"

local _relative_path_cache = nil
local _last_buf_path = nil

local function get_relative_path()
  local full_path = vim.fn.expand("%:p")
  if _relative_path_cache ~= nil and _last_buf_path == full_path then
    return _relative_path_cache
  end
  local cwd = vim.fn.getcwd()
  local prefix = cwd .. "/"
  if string.sub(full_path, 1, #prefix) == prefix then
    _relative_path_cache = string.sub(full_path, #prefix + 1)
  else
    _relative_path_cache = full_path
  end
  _last_buf_path = full_path
  return _relative_path_cache
end

local _kilo_terminal_warned = false

local function ensure_kilo_terminal(terminal, state)
  if state and state.kilo_chan then
    return state.kilo_chan
  end
  local _, chan = terminal.find()
  if not chan then
    if not _kilo_terminal_warned then
      _kilo_terminal_warned = true
      vim.notify("Kilo terminal is not running. Open it first with " .. LEADER_TOGGLE, vim.log.levels.WARN)
    end
    return nil
  end
  if state then
    state.kilo_chan = chan
  end
  return chan
end

local function get_cursor_line(win_id)
  win_id = win_id or 0
  local cursor = vim.api.nvim_win_get_cursor(win_id)
  return cursor[1]
end

local function make_file_reference(path, suffix)
  return "@" .. path .. (suffix or " ")
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
    chan = ensure_kilo_terminal(terminal, state)
  end
  if not chan then
    return
  end
  vim.api.nvim_chan_send(chan, text)
  if opts.focused then
    terminal:focus_active_terminal()
  end
  if not opts.skip_notify then
    vim.notify(message, vim.log.levels.INFO)
  end
end

return {
  get_relative_path = get_relative_path,
  get_cursor_line = get_cursor_line,
  make_file_reference = make_file_reference,
  send = send,
  send_file = function(terminal, state, message, opts)
    opts = opts or {}
    local relative_path = get_relative_path()
    send(terminal, state, make_file_reference(relative_path, " "), message, opts, relative_path)
  end,
}
