-- Terminal finder, creation, and toggle management

local KILO_PATTERN = "kilo"
local TERM_PREFIX = "term://"

-- Session cache with TTL invalidation
local _session_cache = nil
local _session_cache_ts = 0
local SESSION_TTL = 200 -- ms
local function invalidate_session_cache()
  _session_cache = nil
  _session_cache_ts = vim.uv.now()
end

local function get_session_from_cache()
  local now = vim.uv.now()
  if _session_cache ~= nil and (now - _session_cache_ts) < SESSION_TTL then
    return _session_cache
  end
  return nil
end

local function set_session_cache(win, buf, chan)
  _session_cache = { win = win, buf = buf, chan = chan }
  _session_cache_ts = vim.uv.now()
end

-- Low-level: buffer window detection
local function is_kilo_terminal(bufferName)
  return bufferName:find(TERM_PREFIX, 1, true) and bufferName:find(KILO_PATTERN, 1, true)
end

-- Low-level: channel lookup
local function find_channel_by_pattern(pattern, state)
  -- Use channel map if available (O(1))
  if state and state._channel_map then
    local chan_id = state._channel_map[pattern]
    if chan_id then
      for _, chan in ipairs(vim.api.nvim_list_chans()) do
        if chan.id == chan_id then
          if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
            local buffer_name = vim.api.nvim_buf_get_name(chan.buf)
            if buffer_name:find(pattern, 1, true) then
              return chan.buf, chan.id
            end
          end
        end
      end
    end
  end
  -- Fallback: linear scan
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
  state._channel_map[buf] = chan_id
end

local function _clear_channel_map(state)
  state._channel_map = nil
end

-- Rewrite _get_kilo_session to use cache first (O(1) on cache hit)
local function _get_kilo_session()
  -- Try cache first (O(1))
  local cached = get_session_from_cache()
  if cached then
    local wins = vim.api.nvim_list_wins()
    -- Only re-scan if window count changed
    if #wins == cached._last_win_count then
      return cached.win, cached.buf, cached.chan
    end
  end

  -- Full scan fallback
  local wins = vim.api.nvim_list_wins()
  local best_win, best_buf, best_chan = nil, nil, nil
  for _, win in ipairs(wins) do
    if vim.api.nvim_win_is_valid(win) then
      local buf = vim.api.nvim_win_get_buf(win)
      if buf and vim.api.nvim_buf_is_valid(buf) then
        local buffer_name = vim.api.nvim_buf_get_name(buf)
        if is_kilo_terminal(buffer_name) then
          best_win, best_buf = win, buf
          best_chan = nil
          for _, chan in ipairs(vim.api.nvim_list_chans()) do
            if chan.buf == buf then
              best_chan = chan.id
              break
            end
          end
        end
      end
    end
  end

  if best_win then
    set_session_cache(best_win, best_buf, best_chan)
  end
  return best_win, best_buf, best_chan
end

-- Low-level: channel lookup
local function find_kilo_terminal()
  return find_channel_by_pattern(KILO_PATTERN)
end

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
  -- Use cached channel if still valid (avoids O(n*m) channel scan)
  if state.kilo_chan then
    return state.kilo_buf, state.kilo_chan
  end
  return find_channel_by_buffer(state.kilo_buf)
end

local function _close_active_window(state)
  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    vim.api.nvim_buf_delete(state.kilo_buf, { force = true })
  end
  state.kilo_win = nil
  state.kilo_buf = nil
  state.kilo_chan = nil
  _clear_channel_map(state)
  invalidate_session_cache()
end

local function _setup_new_buffer(state)
  vim.cmd("vsplit")
  state.kilo_win = vim.api.nvim_get_current_win()
  vim.cmd("terminal kilo .")
  state.kilo_buf = vim.api.nvim_get_current_buf()
  vim.bo[state.kilo_buf].bufhidden = "hide"
  vim.wo[state.kilo_win].number = false
  vim.wo[state.kilo_win].relativenumber = false
  _update_channel_map(state, state.kilo_buf, state.kilo_chan)
end

local function _ensure_session(state)
  local buf, chan = find_kilo_terminal()
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
  -- Use cached channel lookup when available
  if state.kilo_chan then
    local target_win = state.kilo_win
    local is_valid = target_win and vim.api.nvim_win_is_valid(target_win)
    if not is_valid then
      target_win, state.kilo_buf, state.kilo_chan = _get_kilo_session()
      if not target_win then
        warn("no kilo window found for focus")
        return false
      end
    end
    set_session_cache(target_win, state.kilo_buf, state.kilo_chan)
    vim.api.nvim_set_current_win(target_win)
    vim.cmd("startinsert")
    return true
  end

  local target_win = state.kilo_win
  local is_valid = target_win and vim.api.nvim_win_is_valid(target_win)

  if not is_valid then
    target_win, state.kilo_buf, state.kilo_chan = _get_kilo_session()
    if not target_win then
      warn("no kilo window found for focus")
      return false
    end
  end

  set_session_cache(target_win, state.kilo_buf, state.kilo_chan)
  vim.api.nvim_set_current_win(target_win)
  vim.cmd("startinsert")
  return true
end

return function(initialState)
  local Module = {}
  local state = initialState or {}

  Module.toggle = function()
    local win, buf, chan = _get_kilo_session()
    if win then
      if win == vim.api.nvim_get_current_win() then
        _close_active_window(state)
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
