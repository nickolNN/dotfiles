-- ==========================================================================
--                         KILO CODE & NVIM INTEGRATION CONFIG
-- ==========================================================================

-- Global variables to track window and buffer state
local kilo_buf = nil
local kilo_win = nil

-- ==========================================================================
-- 1. KILO CODE WINDOW AND TERMINAL MANAGEMENT
-- ==========================================================================

local function toggle_kilo()
  -- If Kilo window is already open — close it
  if kilo_win and vim.api.nvim_win_is_valid(kilo_win) then
    vim.api.nvim_win_close(kilo_win, true)
    kilo_win = nil
    return
  end

  -- Create a vertical split on the right with 45 chars width
  vim.cmd("vsplit")
  -- vim.cmd("vertical resize 100")
  kilo_win = vim.api.nvim_get_current_win()

  -- If Kilo buffer already exists and is valid, display it
  if kilo_buf and vim.api.nvim_buf_is_valid(kilo_buf) then
    vim.api.nvim_win_set_buf(kilo_win, kilo_buf)
  else
    -- Launch your 'kilo' utility in Neovim terminal mode
    vim.cmd("terminal kilo .")
    kilo_buf = vim.api.nvim_get_current_buf()

    -- Buffer settings: hide on window close, disable line numbers
    vim.bo[kilo_buf].bufhidden = "hide"
    vim.wo[kilo_win].number = false
    vim.wo[kilo_win].relativenumber = false
  end

  -- Automatically enter insert mode (Terminal Mode) for input
  vim.cmd("startinsert")
end

-- ==========================================================================
-- 2. SEND PATH OF CURRENT FILE TO KILO CHAT (relative to pwd, without ./)
-- ==========================================================================

local function get_relative_path()
  local current_file = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd() .. "/"
  return current_file:gsub("^" .. cwd, ""):gsub("^%./", "")
end

local function send_current_file_to_kilo()
  local current_file = get_relative_path()

  -- If it's an empty buffer or the Kilo terminal itself — exit
  if current_file == "" or vim.bo.buftype == "terminal" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return
  end

  -- DYNAMIC SEARCH: Find the buffer where the kilo terminal process is running
  local target_buf = nil
  local target_chan = nil

  local chans = vim.api.nvim_list_chans()
  for _, chan in ipairs(chans) do
    if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
      if
        string.find(vim.api.nvim_buf_get_name(chan.buf), "term://")
        and string.find(vim.api.nvim_buf_get_name(chan.buf), "kilo")
      then
        target_buf = chan.buf
        target_chan = chan.id
        break
      end
    end
  end

  -- If dynamic search didn't find anything, check the old variable
  if not target_chan and kilo_buf and vim.api.nvim_buf_is_valid(kilo_buf) then
    target_buf = kilo_buf
    for _, chan in ipairs(chans) do
      if chan.buf == kilo_buf then
        target_chan = chan.id
        break
      end
    end
  end

  -- If kilo terminal is not found at all
  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  -- Save the found buffer in the global variable for future use
  kilo_buf = target_buf

  -- Format context string according to Kilo Code @-mention syntax
  local text_to_send = "@" .. current_file .. " "

  -- Send the path to the terminal
  vim.api.nvim_chan_send(target_chan, text_to_send)
  vim.notify("File added to Kilo context", vim.log.levels.INFO)

  -- Switch input focus to Kilo window if it's open
  if kilo_win and vim.api.nvim_win_is_valid(kilo_win) then
    vim.api.nvim_set_current_win(kilo_win)
    vim.cmd("startinsert")
  end
end

-- ==========================================================================
-- 2. SEND CURRENT FILE WITH LINE CONTEXT TO KILO CHAT
-- ==========================================================================

local function send_current_file_with_line_to_kilo()
  local current_file = get_relative_path()

  if current_file == "" or vim.bo.buftype == "terminal" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return
  end

  local target_buf = nil
  local target_chan = nil

  local chans = vim.api.nvim_list_chans()
  for _, chan in ipairs(chans) do
    if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
      if
        string.find(vim.api.nvim_buf_get_name(chan.buf), "term://")
        and string.find(vim.api.nvim_buf_get_name(chan.buf), "kilo")
      then
        target_buf = chan.buf
        target_chan = chan.id
        break
      end
    end
  end

  if not target_chan and kilo_buf and vim.api.nvim_buf_is_valid(kilo_buf) then
    target_buf = kilo_buf
    for _, chan in ipairs(chans) do
      if chan.buf == kilo_buf then
        target_chan = chan.id
        break
      end
    end
  end

  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  kilo_buf = target_buf

  local line_number = vim.api.nvim_win_get_cursor(0)[1]
  local text_to_send = "@" .. current_file .. " line " .. line_number .. " "

  -- Send the text with cursor positioned before the trailing space
  vim.api.nvim_chan_send(target_chan, text_to_send)
  local str_len = #text_to_send - 1
  local escape_code = string.format("\027[%dD", str_len)
  vim.api.nvim_chan_send(target_chan, escape_code)
  vim.notify("File + line context added to Kilo", vim.log.levels.INFO)

  if kilo_win and vim.api.nvim_win_is_valid(kilo_win) then
    vim.api.nvim_set_current_win(kilo_win)
    vim.cmd("startinsert")
  end
end

-- ==========================================================================
-- 3. DISK CHANGE MONITORING AND SYNCHRONIZATION (AI -> NVIM)
-- ==========================================================================

-- Allow Neovim to automatically reload changed files
vim.o.autoread = true

-- Autocmd to force Neovim buffers to refresh when AI works
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

-- On-screen notification if AI rewrote the current file
vim.api.nvim_create_autocmd("FileChangedShellPost", {
  group = watch_group,
  pattern = "*",
  callback = function()
    vim.notify("File was updated by Kilo agent on disk", vim.log.levels.INFO)
  end,
})

-- Track new file creation by AI agent via libuv
local uv = vim.loop or vim.uv
local handle = nil

local function start_dir_watch()
  local watch_dir = vim.fn.getcwd()
  handle = uv.new_fs_event()

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
          -- Ignore system folders and dependencies
          if not string.find(full_path, "node_modules") and not string.find(full_path, "%.git") then
            -- If the file exists on disk but is not yet open in Neovim — add it to buffers hiddenly
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

-- Initialize folder watching
start_dir_watch()

-- ==========================================================================
-- 4. KEYMAPPINGS ASSIGNMENT
-- ==========================================================================

local map = vim.keymap.set
local opts = { noremap = true, silent = true }

-- <leader>kk — Show / hide Kilo Code chat panel
map("n", "<leader>kk", toggle_kilo, vim.tbl_extend("force", opts, { desc = "Toggle Kilo TUI Panel" }))

-- <leader>kf — Copy current file path and paste into Kilo as @-mention
map("n", "<leader>kf", send_current_file_to_kilo, vim.tbl_extend("force", opts, { desc = "Send current file to Kilo" }))

-- <leader>kl — Send current file with cursor line number to Kilo
map(
  "n",
  "<leader>kl",
  send_current_file_with_line_to_kilo,
  vim.tbl_extend("force", opts, { desc = "Send current file + line to Kilo" })
)

-- ==========================================================================
-- Module return value (required by lazy.nvim spec loader)
-- ==========================================================================
return {}
