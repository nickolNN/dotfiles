-- Terminal finder, creation, and toggle management

local KILO_PATTERN = "kilo"
local TERM_PREFIX = "term://"

-- Low-level: buffer window detection
local function is_kilo_terminal(bufferName)
  return bufferName:find(TERM_PREFIX, 1, true) and bufferName:find(KILO_PATTERN, 1, true)
end

local function find_channel_by_pattern(pattern)
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
      local buffer_name = vim.api.nvim_buf_get_name(chan.buf)
      if buffer_name:find(pattern, 1, true) then
        return chan.buf, chan.id
      end
    end
  end
  return nil, nil
end

local function find_channel_by_buffer(target_buf)
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.buf == target_buf then
      return target_buf, chan.id
    end
  end
  return nil, nil
end

local function get_session(state)
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    local buf = vim.api.nvim_win_get_buf(state.kilo_win)
    if buf and vim.api.nvim_buf_is_valid(buf) and is_kilo_terminal(vim.api.nvim_buf_get_name(buf)) then
      return state.kilo_win, buf, state.kilo_chan
    end
  end

  -- Reject stale cached window: must be valid AND actually displaying the
  -- cached buffer. After Neovim session restore the Lua state is nil but
  -- the physical split may still exist with a different/buffer mismatch.
  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
      if vim.api.nvim_win_get_buf(state.kilo_win) == state.kilo_buf then
        return state.kilo_win, state.kilo_buf, state.kilo_chan
      end
    end
  end

  local buf_to_chan = {}
  for _, chan in ipairs(vim.api.nvim_list_chans()) do
    if chan.buf then
      buf_to_chan[chan.buf] = chan.id
    end
  end

  local wins = vim.api.nvim_list_wins()
  local best_win, best_buf, best_chan = nil, nil, nil
  for _, win in ipairs(wins) do
    if vim.api.nvim_win_is_valid(win) then
      local buf = vim.api.nvim_win_get_buf(win)
      if buf and vim.api.nvim_buf_is_valid(buf) then
        local buffer_name = vim.api.nvim_buf_get_name(buf)
        if is_kilo_terminal(buffer_name) then
          best_win, best_buf = win, buf
          best_chan = buf_to_chan[buf]
        end
      end
    end
  end

  return best_win, best_buf, best_chan
end

-- Session helpers
local function _show_in_window(win, buf)
  vim.api.nvim_win_set_buf(win, buf)
end

local function _close_active_window(state)
  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    vim.api.nvim_buf_delete(state.kilo_buf, { force = true })
  end
  state.kilo_win = nil
  state.kilo_buf = nil
  state.kilo_chan = nil
end

local function _setup_new_buffer(state)
  vim.cmd("vsplit | terminal kilo .")
  state.kilo_win = vim.api.nvim_get_current_win()
  state.kilo_buf = vim.api.nvim_get_current_buf()
  vim.bo[state.kilo_buf].bufhidden = "hide"
  vim.wo[state.kilo_win].number = false
  vim.wo[state.kilo_win].relativenumber = false
end

local function _ensure_session(state)
  local win, buf, chan = get_session(state)
  if win then
    state.kilo_win = win
    state.kilo_buf = buf
    state.kilo_chan = chan
    _show_in_window(win, buf)
    return
  end

  _setup_new_buffer(state)
end

local function _focus_active_terminal(state)
  local target_win = state.kilo_win
  local is_valid = target_win and vim.api.nvim_win_is_valid(target_win)

  if not is_valid then
    target_win, state.kilo_buf, state.kilo_chan = get_session(state)
    if not target_win then
      return false
    end
  end

  vim.api.nvim_set_current_win(target_win)
  vim.cmd("startinsert")
  return true
end

return function(initialState)
  local Module = {}
  local state = initialState or {}

  Module.toggle = function()
    local win, buf, chan = get_session(state)
    if win then
      if win == vim.api.nvim_get_current_win() then
        return
      end
      state.kilo_win = win
      state.kilo_buf = buf
      state.kilo_chan = chan
      vim.api.nvim_set_current_win(win)
      return
    end

    if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
      _close_active_window(state)
      return
    end

    if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
      vim.cmd("vsplit")
      state.kilo_win = vim.api.nvim_get_current_win()
      vim.api.nvim_win_set_buf(state.kilo_win, state.kilo_buf)
    else
      _ensure_session(state)
    end

    vim.cmd("startinsert")
  end

  Module.find = function()
    return find_channel_by_pattern(KILO_PATTERN)
  end

  Module.focus_active_terminal = function()
    return _focus_active_terminal(state)
  end

  return Module
end
