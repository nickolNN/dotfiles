-- Disk change monitoring, file watching, and synchronization

local DEBOUNCE_MS = 300

local function should_ignore(full_path)
  if string.find(full_path, "node_modules/") then return true end
  if string.find(full_path, "%.git/") then return true end
  return false
end

local function find_window_with_buf(bufnr, kilo_win)
  -- Use cached O(1) lookup
  if state._window_buf_map and state._window_buf_map[bufnr] then
    return state._window_buf_map[bufnr]
  end
  -- Fallback to linear scan (rare, only before cache is populated)
  if vim.api.nvim_get_current_win() == kilo_win then
    return nil
  end
  local wins = vim.api.nvim_list_wins()
  for _, win in ipairs(wins) do
    if win ~= kilo_win and vim.api.nvim_win_is_valid(win) then
      if vim.api.nvim_win_get_buf(win) == bufnr then
        return win
      end
    end
  end
  return nil
end

local function move_cursor_to_end(kilo_win, buf)
  local active_win = vim.api.nvim_get_current_win()
  if active_win ~= kilo_win then
    return
  end
  local target_win = find_window_with_buf(buf, kilo_win)
  if target_win then
    vim.api.nvim_set_current_win(target_win)
    vim.cmd("normal! gg")
    local lnum = vim.api.nvim_buf_line_count(buf)
    vim.api.nvim_win_set_cursor(target_win, { lnum, 0 })
    vim.cmd("normal! zz")
  end
end

local function handle_file_event(state, full_path)
  local kilo_win = state.kilo_win
  local buf = vim.fn.bufnr(full_path)

  -- Skip if buffer already loaded
  if buf and vim.api.nvim_buf_is_valid(buf) then
    -- Still sync cursor position
    local target_win = find_window_with_buf(buf, kilo_win)
    if target_win then
      local saved_win = vim.api.nvim_get_current_win()
      pcall(vim.api.nvim_set_current_win, target_win)
      vim.cmd("keepjumps checktime")
      pcall(vim.api.nvim_set_current_win, saved_win)
    end
    move_cursor_to_end(kilo_win, buf)
    return
  end

  -- Only bufadd + notify for truly new files
  if vim.fn.bufexists(full_path) == 0 and vim.fn.filereadable(full_path) == 1 then
    vim.fn.bufadd(full_path)
    vim.notify("Kilo created a new file: " .. vim.fn.fnamemodify(full_path, ":t"), vim.log.levels.INFO)

    if kilo_win and vim.api.nvim_win_is_valid(kilo_win) then
      move_cursor_to_end(kilo_win, buf)
    end
    return
  end

  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end

  local target_win = find_window_with_buf(buf, kilo_win)
  if target_win then
    local saved_win = vim.api.nvim_get_current_win()
    pcall(vim.api.nvim_set_current_win, target_win)
    vim.cmd("keepjumps checktime")
    pcall(vim.api.nvim_set_current_win, saved_win)
  end

  move_cursor_to_end(kilo_win, buf)
end

local _uv_wrap_fn
local function get_uv_wrap()
  if not _uv_wrap_fn then
    if vim.uv_wrap and type(vim.uv_wrap) == "function" then
      _uv_wrap_fn = vim.uv_wrap
    end
  end
  return _uv_wrap_fn
end

local function schedule_file_event(state, filename)
  local full_path = state.watch_dir .. "/" .. filename
  if should_ignore(full_path) then return end

  if state._file_event_timer then
    state._file_event_timer:stop()
  end

  local wrapped_callback = get_uv_wrap() and get_uv_wrap()(function()
    handle_file_event(state, full_path)
  end) or function()
    handle_file_event(state, full_path)
  end
  state._file_event_timer:start(DEBOUNCE_MS, 0, wrapped_callback)
end

local function start_dir_watch(state)
  local uv = vim.uv
  if not state._watch_dir then
    state._watch_dir = vim.fn.getcwd()
  end
  local watch_dir = state._watch_dir
  state.watch_dir = watch_dir
  state.fs_handle = uv.new_fs_event()

  local callback = get_uv_wrap() and get_uv_wrap()(function(err, filename, events)
    if err or not filename or not (events.change or events.rename) then
      if err then
        vim.notify("Filesystem watch error: " .. tostring(err), vim.log.levels.ERROR)
      end
      return
    end
    schedule_file_event(state, filename)
  end) or function(err, filename, events)
    if err or not filename or not (events.change or events.rename) then
      if err then
        vim.notify("Filesystem watch error: " .. tostring(err), vim.log.levels.ERROR)
      end
      return
    end
    schedule_file_event(state, filename)
  end

  -- Update window->buffer cache on focus/buffer change (O(1) for file watcher)
  vim.api.nvim_create_autocmd({ "BufEnter", "FocusGained" }, {
    group = watch_group,
    callback = function()
      state._window_buf_map = {}
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_is_valid(win) then
          local buf = vim.api.nvim_win_get_buf(win)
          if buf and vim.api.nvim_buf_is_valid(buf) then
            state._window_buf_map[buf] = win
          end
        end
      end
    end,
  })

  uv.fs_event_start(state.fs_handle, watch_dir, {}, callback)
end

local _checktime_pending = false

local function setup(state)
  local watch_group = vim.api.nvim_create_augroup("KiloSyncGroup", { clear = true })

  vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter" }, {
    group = watch_group,
    pattern = "*",
    callback = function()
      if not _checktime_pending then
        _checktime_pending = true
        vim.defer_fn(function()
          vim.cmd("checktime")
          _checktime_pending = false
        end, 50)
      end
    end,
  })

  state._file_event_timer = vim.uv.new_timer()
  start_dir_watch(state)
  return watch_group
end

local function teardown(state)
  if state.fs_handle then
    state.fs_handle:stop()
    state.fs_handle = nil
  end
  if state._file_event_timer then
    state._file_event_timer:stop()
    state._file_event_timer:close()
    state._file_event_timer = nil
  end
  state._watch_dir = nil
  state._window_buf_map = nil
  _checktime_pending = false
end

return {
  setup = setup,
  teardown = teardown,
}
