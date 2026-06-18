local TERMINAL_NOT_RUNNING_MSG = "Kilo terminal is not running. Open it first with <leader>kk"
local NOT_A_FILE_MSG = "Current buffer is not a file"

local function get_relative_path()
  local full_path = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd() .. "/"
  local relative = full_path:gsub("^" .. cwd, "")
  return relative:gsub("^%./", "")
end

local function validate_buffer()
  local path = get_relative_path()
  if path == "" or vim.bo.buftype == "terminal" then
    vim.notify(NOT_A_FILE_MSG, vim.log.levels.WARN)
    return false
  end
  return true
end

local function get_channel(terminal)
  local _, chan = terminal.find()
  if not chan then
    vim.notify(TERMINAL_NOT_RUNNING_MSG, vim.log.levels.WARN)
    return nil
  end
  return chan
end

local function ensure_context(terminal)
  if not validate_buffer() then
    return
  end
  local chan = get_channel(terminal)
  if not chan then
    return
  end
  return chan
end

local function fn_name_under_cursor()
  local line_count = vim.api.nvim_buf_line_count(0)
  if line_count < 1 then
    return "<unknown>"
  end

  local cursor_line = vim.api.nvim_win_get_cursor(0)[1]
  local lines = vim.api.nvim_buf_get_lines(0, 0, cursor_line, false)

  local patterns = {
    "^%s*(async%s+)?function%s+(%w+)",
    "^%s*local%s+(async%s+)?function%s+(%w+)",
    "^%s*(%w+)%s*=%s*(async%s+)?function",
    "^%s*const%s+(%w+)%s*=%s*(async%s+)?function",
    "^%s*var%s+(%w+)%s*=%s*(async%s+)?function",
    "^%s*function%s+(%w+)",
    "^%s*local(%s+)%w+%s*=%s*(%w+)%s*=%s*function",
    "^%s*const%s+(%w+)%s*=%s*function",
    "^%s*local%s+(%w+)%s*=%s*function",
    "^%s*method%s+(%w+)",
  }

  for offset = cursor_line - 1, 0, -1 do
    local line = lines[offset + 1]
    for _, pattern in ipairs(patterns) do
      local captures = line:match(pattern)
      if captures and #captures > 0 then
        -- pick the first capture group that has content, skipping reserved words
        for i = 1, #captures do
          local val = captures[i]
          if val and #val > 0 and val ~= "async" and val ~= "await" then
            return val
          end
        end
      end
    end
  end

  return vim.fn.expand("<cword>")
    or "<unknown>"
end

return {
  TERMINAL_NOT_RUNNING_MSG = TERMINAL_NOT_RUNNING_MSG,
  NOT_A_FILE_MSG = NOT_A_FILE_MSG,
  get_relative_path = get_relative_path,
  validate_buffer = validate_buffer,
  get_channel = get_channel,
  ensure_context = ensure_context,
  fn_name_under_cursor = fn_name_under_cursor,
}
