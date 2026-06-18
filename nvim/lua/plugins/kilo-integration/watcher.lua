-- Disk change monitoring, file watching, and synchronization

local DEBOUNCE_MS = 300

-- Check if any window (other than Kilo's) has the given buffer open
local function find_window_with_buf(bufnr, kilo_win)
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

-- Returns true if the path should be skipped (not a text file we watch)
local function should_ignore(full_path)
  if string.find(full_path, "node_modules") then
    return true
  end
  if string.find(full_path, "%.git") then
    return true
  end
  return false
end

-- Move cursor to end of buffer in the window that has it open
-- Only activates if current window is kilo_win
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

-- Process a file event after debounce: handle new files and cursor navigation
local function handle_file_event(state, full_path)
  local kilo_win = state.kilo_win

  if vim.fn.bufexists(full_path) == 0 and vim.fn.filereadable(full_path) == 1 then
    -- New file: create buffer. Content loads from disk on BufRead (file already on disk from Kilo write).
    vim.fn.bufadd(full_path)
    vim.notify("Kilo created a new file: " .. vim.fn.fnamemodify(full_path, ":t"), vim.log.levels.INFO)

    if kilo_win and vim.api.nvim_win_is_valid(kilo_win) then
      local buf = vim.fn.bufnr(full_path)
      move_cursor_to_end(kilo_win, buf)
    end
    return
  end

  -- Existing file open in a window: force-reload content from disk
  local buf = vim.fn.bufnr(full_path)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end

  local target_win = find_window_with_buf(buf, kilo_win)
  if target_win then
    local saved_win = vim.api.nvim_get_current_win()
    pcall(vim.api.nvim_set_current_win, target_win)
    vim.cmd("keepjumps checktime!")
    pcall(vim.api.nvim_set_current_win, saved_win)
  end

  move_cursor_to_end(kilo_win, buf)
end

local function start_dir_watch(state)
  local last_changed = 0
  local debounce_timer = nil

  local uv = vim.loop or vim.uv
  local watch_dir = vim.fn.getcwd()
  state.watch_dir = watch_dir
  local handle = uv.new_fs_event()
  state.fs_handle = handle

  -- Schedule debounced processing of a file system event using closure-captured state
  local function schedule_debounced_event(filename)
    local full_path = watch_dir .. "/" .. filename
    local now = uv.now()

    -- Defer work to vim main thread for safe API access
    local deferred = vim.schedule_wrap(function()
      if should_ignore(full_path) then
        return
      end
      handle_file_event(state, full_path)
    end)

    if debounce_timer then
      return
    end
    if now - last_changed < DEBOUNCE_MS then
      debounce_timer = uv.new_timer()
      if debounce_timer then
        debounce_timer:start(
          DEBOUNCE_MS,
          0,
          vim.schedule_wrap(function()
            if debounce_timer then
              debounce_timer:stop()
              debounce_timer:close()
              debounce_timer = nil
            end
            last_changed = uv.now()
            deferred()
          end)
        )
      end
      return
    end
    last_changed = now
    deferred()
  end

  if handle then
    local callback = vim.schedule_wrap(function(err, filename, events)
      if err or not filename or not (events.change or events.rename) then
        return
      end
      schedule_debounced_event(filename)
    end)

    uv.fs_event_start(handle, watch_dir, {}, callback)
  end
end

local function setup_dir_cleanup(watch_group, state)
  vim.api.nvim_create_autocmd("DirChanged", {
    group = watch_group,
    callback = function()
      if state.fs_handle then
        local uv = vim.loop or vim.uv
        uv.fs_event_stop(state.fs_handle)
        state.fs_handle = nil
      end
    end,
  })
end

local function setup_autocmds(watch_group)
  vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorMoved", "CursorHold" }, {
    group = watch_group,
    pattern = "*",
    callback = function()
      if vim.fn.getcmdwintype() == "" then
        vim.cmd("checktime")
      end
    end,
  })
end

return {
  setup_autocmds = setup_autocmds,
  start_dir_watch = start_dir_watch,
  setup_dir_cleanup = setup_dir_cleanup,
}
