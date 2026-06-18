-- Disk change monitoring, file watching, and synchronization

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

  vim.api.nvim_create_autocmd("FileChangedShellPost", {
    group = watch_group,
    pattern = "*",
    callback = function()
      vim.notify("File was updated by Kilo agent on disk", vim.log.levels.INFO)
    end,
  })
end

local function start_dir_watch(state)
  local uv = vim.loop or vim.uv
  local watch_dir = vim.fn.getcwd()
  local handle = uv.new_fs_event()
  state.fs_handle = handle

  if handle then
    uv.fs_event_start(
      handle,
      watch_dir,
      {},
      vim.schedule_wrap(function(err, filename, events)
        if err then
          return
        end

        if filename and (events.change or events.rename) then
          local full_path = watch_dir .. "/" .. filename
          if not string.find(full_path, "node_modules") and not string.find(full_path, "%.git") then
            if vim.fn.bufexists(full_path) == 0 and vim.fn.filereadable(full_path) == 1 then
              vim.fn.bufadd(full_path)
              vim.notify("Kilo created a new file: " .. filename, vim.log.levels.INFO)
            end
          end
        end
      end)
    )
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

return {
  setup_autocmds = setup_autocmds,
  start_dir_watch = start_dir_watch,
  setup_dir_cleanup = setup_dir_cleanup,
}
