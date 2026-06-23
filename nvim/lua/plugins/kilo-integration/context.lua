local function get_relative_path()
  local full_path = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd()
  local prefix = cwd .. "/"
  if string.sub(full_path, 1, #prefix) == prefix then
    return string.sub(full_path, #prefix + 1)
  end
  return full_path
end

local function buffer_is_valid()
  local path = get_relative_path()
  return path ~= "" and vim.bo.buftype ~= "terminal"
end

local function ensure_kilo_terminal(terminal)
  local _, chan = terminal.find()
  if not chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return nil
  end
  return chan
end

local function get_cursor_line_number(win_id)
  win_id = win_id or 0
  local cursor = vim.api.nvim_win_get_cursor(win_id)
  return cursor[1]
end

return {
  get_relative_path = get_relative_path,
  buffer_is_valid = buffer_is_valid,
  ensure_kilo_terminal = ensure_kilo_terminal,
  get_cursor_line = get_cursor_line_number,
}
