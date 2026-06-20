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
    return false
  end
  return true
end

local function validate_buffer_with_notify(msg)
  local result = validate_buffer()
  if not result then
    vim.notify(msg, vim.log.levels.WARN)
  end
  return result
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
  if not validate_buffer_with_notify(NOT_A_FILE_MSG) then
    return
  end
  local chan = get_channel(terminal)
  if not chan then
    return
  end
  return chan
end

return {
  get_relative_path = get_relative_path,
  validate_buffer = validate_buffer,
  validate_buffer_with_notify = validate_buffer_with_notify,
  ensure_context = ensure_context,
}
