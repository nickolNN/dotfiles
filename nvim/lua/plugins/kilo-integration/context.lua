local LEADER_TOGGLE = "<leader>kk"

local _relative_path_cache = nil
local _relative_path_valid = false

vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function()
    _relative_path_valid = false
  end,
})

local function get_relative_path()
  if _relative_path_cache ~= nil and _relative_path_valid then
    return _relative_path_cache
  end
  local full_path = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd()
  local prefix = cwd .. "/"
  if string.sub(full_path, 1, #prefix) == prefix then
    _relative_path_cache = string.sub(full_path, #prefix + 1)
    _relative_path_valid = true
  else
    _relative_path_cache = full_path
    _relative_path_valid = true
  end
  return _relative_path_cache
end

local _kilo_terminal_warned = false

local function ensure_kilo_terminal(terminal)
  local _, chan = terminal.find()
  if not chan then
    if not _kilo_terminal_warned then
      _kilo_terminal_warned = true
      vim.notify("Kilo terminal is not running. Open it first with " .. LEADER_TOGGLE, vim.log.levels.WARN)
    end
    return nil
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

return {
  get_relative_path = get_relative_path,
  ensure_kilo_terminal = ensure_kilo_terminal,
  get_cursor_line = get_cursor_line,
  make_file_reference = make_file_reference,
}
