-- Terminal finder, creation, and toggle management

local KILO_PATTERN = "kilo"
local TERM_PREFIX = "term://"

local function isKiloTerminal(bufferName)
  return bufferName:find(TERM_PREFIX, 1, true) and bufferName:find(KILO_PATTERN, 1, true)
end

local function activeChannelFor(buffer)
  local channels = vim.api.nvim_list_chans()
  for _, chan in ipairs(channels) do
    if chan.buf == buffer then
      return chan.id
    end
  end
  return nil
end

local function findSession(state)
  if state.kilo_chan and state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    local info = vim.api.nvim_get_chan_info(state.kilo_chan)
    if info and info.id then
      return state.kilo_buf, state.kilo_chan
    end
  end

  local channels = vim.api.nvim_list_chans()
  for _, chan in ipairs(channels) do
    if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
      local bufferName = vim.api.nvim_buf_get_name(chan.buf)
      if isKiloTerminal(bufferName) then
        state.kilo_buf = chan.buf
        state.kilo_chan = chan.id
        return chan.buf, chan.id
      end
    end
  end

  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    local channel = activeChannelFor(state.kilo_buf)
    if channel then
      state.kilo_chan = channel
      return state.kilo_buf, channel
    end
  end

  return nil, nil
end

local function closeAllKiloBuffers()
  local buffers = vim.api.nvim_list_bufs()
  for _, buffer in ipairs(buffers) do
    if vim.api.nvim_buf_is_valid(buffer) and vim.bo[buffer].buftype == "terminal" then
      local bufferName = vim.api.nvim_buf_get_name(buffer)
      if isKiloTerminal(bufferName) then
        vim.api.nvim_buf_delete(buffer, { force = true })
      end
    end
  end
end

local function closeActiveWindow(state)
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_win_close(state.kilo_win, true)
  end
  state.kilo_win = nil
  -- Keep kilo_buf/kilo_chan so findSession reuses the existing terminal
  -- buffer instead of closing and recreating it on each toggle.
  state.kilo_buf = nil
  state.kilo_chan = nil
end

local function setupNewBuffer(state)
  vim.cmd("terminal kilo .")
  state.kilo_buf = vim.api.nvim_get_current_buf()
  vim.bo[state.kilo_buf].bufhidden = "hide"
  local window = vim.api.nvim_get_current_win()
  vim.wo[window].number = false
  vim.wo[window].relativenumber = false
end

local function ensureSession(state)
  local buf, chan = findSession(state)
  if buf and chan then
    vim.api.nvim_win_set_buf(state.kilo_win, buf)
    state.kilo_buf = buf
    state.kilo_chan = chan
    return
  end
  closeAllKiloBuffers()
  setupNewBuffer(state)
end

local function focusActiveTerminal(state)
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_set_current_win(state.kilo_win)
    vim.cmd("startinsert")
    return true
  end
  return false
end

return function(initialState)
  local Module = {}

  local state = {}
  if initialState then
    state.kilo_buf = initialState.kilo_buf
    state.kilo_chan = initialState.kilo_chan
    state.kilo_win = initialState.kilo_win
  end

  Module.toggle = function()
    if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
      closeActiveWindow(state)
      return
    end

    vim.cmd("vsplit")
    state.kilo_win = vim.api.nvim_get_current_win()

    if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
      vim.api.nvim_win_set_buf(state.kilo_win, state.kilo_buf)
    else
      ensureSession(state)
    end

    vim.cmd("startinsert")
  end

  Module.find = function()
    return findSession(state)
  end

  Module.focusActiveTerminal = function()
    return focusActiveTerminal(state)
  end

  return Module
end
