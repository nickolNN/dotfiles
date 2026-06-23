-- Disk change monitoring, file watching, and synchronization

local DEBOUNCE_MS = 300

local function should_ignore(full_path)
  if string.match(full_path, "[/\\]node_modules[/\\]") then return true end
  if string.match(full_path, "[/\\]\\.git[/\\]") or string.match(full_path, "[/\\]\\.git$") then return true end
  return false
end

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
  local canonical_path = vim.fs.realpath(full_path) or full_path

  if vim.fn.bufexists(canonical_path) == 0 and vim.fn.filereadable(canonical_path) == 1 then
    vim.fn.bufadd(canonical_path)
    vim.notify("Kilo created a new file: " .. vim.fn.fnamemodify(full_path, ":t"), vim.log.levels.INFO)

    if kilo_win and vim.api.nvim_win_is_valid(kilo_win) then
      local buf = vim.fn.bufnr(canonical_path)
      move_cursor_to_end(kilo_win, buf)
    end
    return
  end

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

local function schedule_file_event(state, filename)
  local full_path = state.watch_dir .. "/" .. filename
  if should_ignore(full_path) then return end

  if not state._file_event_timer then
    state._file_event_timer = vim.uv.new_timer()
  end
  state._file_event_timer:stop()

  state._file_event_timer:start(DEBOUNCE_MS, 0, vim.schedule_wrap(function()
    state._file_event_timer:stop()
    handle_file_event(state, full_path)
  end))
end

local function start_dir_watch(state)
  local uv = vim.uv
  local watch_dir = vim.fn.getcwd()
  state.watch_dir = watch_dir
  state.fs_handle = uv.new_fs_event()

  local callback = vim.schedule_wrap(function(err, filename, events)
    if err or not filename or not (events.change or events.rename) then
      return
    end
    schedule_file_event(state, filename)
  end)

  uv.fs_event_start(state.fs_handle, watch_dir, {}, callback)
end

local function setup(state)
  local watch_group = vim.api.nvim_create_augroup("KiloSyncGroup", { clear = true })

  vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorMoved", "CursorHold" }, {
    group = watch_group,
    pattern = "*",
    callback = function()
      if vim.fn.getcmdwintype() == "" then
        vim.cmd("checktime")
      end
    end,
  })

  vim.api.nvim_create_autocmd("DirChanged", {
    group = watch_group,
    callback = function()
      if state.fs_handle then
        local uv = vim.uv
        uv.fs_event_stop(state.fs_handle)
        state.fs_handle = nil
      end
      if state._file_event_timer then
        state._file_event_timer:stop()
        state._file_event_timer:close()
        state._file_event_timer = nil
      end
    end,
  })

  start_dir_watch(state)
  return watch_group
end

return {
  setup = setup,
}
