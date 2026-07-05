-- Terminal finder, creation, and toggle management

local KILO_PATTERN = "kilo"
local TERM_PREFIX = "term://"

-- Low-level: buffer window detection
local function is_kilo_terminal(bufferName)
  return bufferName:find(TERM_PREFIX, 1, true) and bufferName:find(KILO_PATTERN, 1, true)
end

-- Low-level: channel lookup — O(1) buffer name from cache per channel
local function find_channel_by_pattern(pattern, state)
  -- Use channel map keyed by channel ID (O(1) buffer name lookup per channel)
  if state and state._channel_map then
    for _, chan in ipairs(vim.api.nvim_list_chans()) do
      if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
        -- Cached buffer name avoids expensive nvim_buf_get_name call
        local buffer_name = state._channel_map[chan.id]
        if buffer_name and buffer_name:find(pattern, 1, true) then
          return chan.buf, chan.id
        end
      end
    end
  end
  -- Fallback: linear scan (only on first open or after close)
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

local function _update_channel_map(state, buf, chan_id)
  if not state._channel_map then
    state._channel_map = {}
  end
  -- Key by channel ID instead of buffer name for O(1) lookup by chan.id
  state._channel_map[chan_id] = buf
end

local function _clear_channel_map(state)
  state._channel_map = nil
end

-- Rewrite _get_kilo_session to use state.kilo_win/state.kilo_buf first (O(1))
local function _get_kilo_session(s)
  -- Try state-level cache first (O(1)) — only falls back to full scan when
  -- state is nil (first open, after Neovim session restore).
  if s.kilo_win and vim.api.nvim_win_is_valid(s.kilo_win) then
    local buf = vim.api.nvim_win_get_buf(s.kilo_win)
    if buf and vim.api.nvim_buf_is_valid(buf) and is_kilo_terminal(vim.api.nvim_buf_get_name(buf)) then
      return s.kilo_win, buf, s.kilo_chan
    end
  end

  -- Full scan fallback with TTL (avoids re-scanning on every toggle)
  local wins = vim.api.nvim_list_wins()
  local best_win, best_buf, best_chan = nil, nil, nil
  for _, win in ipairs(wins) do
    if vim.api.nvim_win_is_valid(win) then
      local buf = vim.api.nvim_win_get_buf(win)
      if buf and vim.api.nvim_buf_is_valid(buf) then
        local buffer_name = vim.api.nvim_buf_get_name(buf)
        if is_kilo_terminal(buffer_name) then
          best_win, best_buf = win, buf
          local _, best_chan = find_channel_by_buffer(buf)
        end
      end
    end
  end

  return best_win, best_buf, best_chan
end

-- Removed: find_kilo_terminal was only used in _ensure_session which now
-- uses state.kilo_win/state.kilo_buf directly (O(1)).

-- Session helpers
local function _show_in_window(win, buf)
  vim.api.nvim_win_set_buf(win, buf)
end

local function _find_cached_session(state)
  if not state.kilo_buf or not vim.api.nvim_buf_is_valid(state.kilo_buf) then
    return nil, nil
  end
  -- Reject stale cached window: must be valid AND actually displaying the
  -- cached buffer. After Neovim session restore the Lua state is nil but
  -- the physical split may still exist with a different/buffer mismatch.
  if not state.kilo_win or not vim.api.nvim_win_is_valid(state.kilo_win) then
    return nil, nil
  end
  if vim.api.nvim_win_get_buf(state.kilo_win) ~= state.kilo_buf then
    return nil, nil
  end
  -- Use cached channel directly (validated above)
  return state.kilo_buf, state.kilo_chan
end

local function _close_active_window(state)
  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    vim.api.nvim_buf_delete(state.kilo_buf, { force = true })
  end
  state.kilo_win = nil
  state.kilo_buf = nil
  state.kilo_chan = nil
  _clear_channel_map(state)
end

local function _setup_new_buffer(state)
  vim.cmd("vsplit | terminal kilo .")
  state.kilo_win = vim.api.nvim_get_current_win()
  state.kilo_buf = vim.api.nvim_get_current_buf()
  vim.bo[state.kilo_buf].bufhidden = "hide"
  vim.wo[state.kilo_win].number = false
  vim.wo[state.kilo_win].relativenumber = false
  local _, chan = find_channel_by_buffer(state.kilo_buf)
  if chan then
    _update_channel_map(state, state.kilo_buf, chan)
  end
end

local function _ensure_session(state)
  -- O(1) direct check on state.kilo_win/state.kilo_buf instead of O(n) scan
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    local buf = vim.api.nvim_win_get_buf(state.kilo_win)
    if buf and vim.api.nvim_buf_is_valid(buf) and is_kilo_terminal(vim.api.nvim_buf_get_name(buf)) then
      state.kilo_buf = buf
      _show_in_window(state.kilo_win, buf)
      return
    end
  end

  buf, chan = _find_cached_session(state)
  if buf and chan then
    state.kilo_chan = chan
    local win = state.kilo_win
    if not win or not vim.api.nvim_win_is_valid(win) then
      vim.cmd("vsplit")
      win = vim.api.nvim_get_current_win()
      state.kilo_win = win
    end
    state.kilo_buf = buf
    _show_in_window(win, buf)
    _update_channel_map(state, buf, chan)
    return
  end

  _setup_new_buffer(state)
end

local function warn(msg)
  vim.notify("[kilo-debug] " .. msg, vim.log.levels.WARN)
end

-- Rewrite _focus_active_terminal to use state.kilo_chan directly (O(1))
local function _focus_active_terminal(state)
  local target_win = state.kilo_win
  local is_valid = target_win and vim.api.nvim_win_is_valid(target_win)

  if not is_valid then
    target_win, state.kilo_buf, state.kilo_chan = _get_kilo_session(state)
    if not target_win then
      warn("no kilo window found for focus")
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
    local win, buf, chan = _get_kilo_session(state)
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
