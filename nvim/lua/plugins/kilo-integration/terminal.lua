-- Terminal finder, creation, and toggle management

local KILO_PATTERN = "kilo"
local TERM_PREFIX = "term://"

local function find_kilo_terminal(state)
  if state.kilo_chan and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    return state.kilo_buf, state.kilo_chan
  end

  local chans = vim.api.nvim_list_chans()
  for _, chan in ipairs(chans) do
    if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
      local buf_name = vim.api.nvim_buf_get_name(chan.buf)
      if string.find(buf_name, TERM_PREFIX) and string.find(buf_name, KILO_PATTERN) then
        state.kilo_buf = chan.buf
        state.kilo_chan = chan.id
        return chan.buf, chan.id
      end
    end
  end

  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    for _, chan in ipairs(chans) do
      if chan.buf == state.kilo_buf then
        state.kilo_chan = chan.id
        return state.kilo_buf, chan.id
      end
    end
  end

  return nil, nil
end

local function close_kilo_buffers()
  local bufs = vim.api.nvim_list_bufs()
  for _, buf in ipairs(bufs) do
    if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].buftype == "terminal" then
      local buf_name = vim.api.nvim_buf_get_name(buf)
      if string.find(buf_name, KILO_PATTERN) then
        vim.api.nvim_buf_delete(buf, { force = true })
      end
    end
  end
end

local function new_kilo_buffer(state)
  close_kilo_buffers()
  vim.cmd("terminal kilo .")
  state.kilo_buf = vim.api.nvim_get_current_buf()
  vim.bo[state.kilo_buf].bufhidden = "hide"
  local win = vim.api.nvim_get_current_win()
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
end

local function toggle_kilo(state)
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_win_close(state.kilo_win, true)
    state.kilo_win = nil
    return
  end

  vim.cmd("vsplit")
  state.kilo_win = vim.api.nvim_get_current_win()

  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    vim.api.nvim_win_set_buf(state.kilo_win, state.kilo_buf)
  else
    new_kilo_buffer(state)
  end

  vim.cmd("startinsert")
end

return {
  find = find_kilo_terminal,
  toggle = toggle_kilo,
}
