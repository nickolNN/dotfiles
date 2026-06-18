-- ==========================================================================
--                        KILO CODE & NVIM INTEGRATION CONFIG
-- ==========================================================================

-- Guard: lazy.nvim will load this file as a plugin spec.
-- Return early to avoid userdata fields in the module table.
if vim.g.kilo_integration_loaded then
  return
end

-- Magic constants
local KILO_PATTERN = "kilo"
local TERM_PREFIX = "term://"

-- Module state (encapsulated in closure to avoid userdata in returned module)
local M = {}
local state = {
  kilo_buf = nil,
  kilo_win = nil,
  kilo_chan = nil,
  fs_handle = nil,
  watch_group = nil,
}

-- ==========================================================================
-- 1. KILO CODE WINDOW AND TERMINAL MANAGEMENT
-- ==========================================================================

-- Terminal finder: search for the kilo terminal buffer and channel
-- Returns the buffer and channel id for the kilo terminal process
-- Uses caching to avoid repeated searches
local function find_kilo_terminal()
  -- Return cached result if available
  if state.kilo_chan and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    return state.kilo_buf, state.kilo_chan
  end

  -- Search for the terminal buffer
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

  -- Fall back to checking old state variable
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

-- Helper: close all terminal buffers related to kilo
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

local function new_kilo_buffer()
  close_kilo_buffers()
  vim.cmd("terminal kilo .")
  state.kilo_buf = vim.api.nvim_get_current_buf()
  vim.bo[state.kilo_buf].bufhidden = "hide"
  local win = vim.api.nvim_get_current_win()
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
end

local function toggle_kilo()
  -- If Kilo window is already open — close it
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_win_close(state.kilo_win, true)
    state.kilo_win = nil
    return
  end

  vim.cmd("vsplit")
  state.kilo_win = vim.api.nvim_get_current_win()

  -- If Kilo buffer already exists and is valid, display it
  if state.kilo_buf and vim.api.nvim_buf_is_valid(state.kilo_buf) then
    vim.api.nvim_win_set_buf(state.kilo_win, state.kilo_buf)
  else
    new_kilo_buffer()
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

  local target_buf, target_chan = find_kilo_terminal()

  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  -- Format context string according to Kilo Code @-mention syntax
  local text_to_send = "@" .. current_file .. " "

  -- Send the path to the terminal
  vim.api.nvim_chan_send(target_chan, text_to_send)
  vim.notify("File added to Kilo context", vim.log.levels.INFO)

  -- Switch input focus to Kilo window if it's open
  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_set_current_win(state.kilo_win)
    vim.cmd("startinsert")
  end
end

-- ==========================================================================
-- SEND CURRENT FILE WITH LINE CONTEXT TO KILO CHAT
-- ==========================================================================

local function send_current_file_with_line_to_kilo()
  local current_file = get_relative_path()

  if current_file == "" or vim.bo.buftype == "terminal" then
    vim.notify("Current buffer is not a file", vim.log.levels.WARN)
    return
  end

  local target_buf, target_chan = find_kilo_terminal()

  if not target_chan then
    vim.notify("Kilo terminal is not running. Open it first with <leader>kk", vim.log.levels.WARN)
    return
  end

  local line_number = vim.api.nvim_win_get_cursor(0)[1]
  local text_to_send = "@" .. current_file .. " line " .. line_number .. " "

  -- Send the text with cursor positioned before the trailing space
  vim.api.nvim_chan_send(target_chan, text_to_send)
  local str_len = #text_to_send - 1
  local escape_code = string.format("\027[%dD", str_len)
  vim.api.nvim_chan_send(target_chan, escape_code)
  vim.notify("File + line context added to Kilo", vim.log.levels.INFO)

  if state.kilo_win and vim.api.nvim_win_is_valid(state.kilo_win) then
    vim.api.nvim_set_current_win(state.kilo_win)
    vim.cmd("startinsert")
  end
end

-- ==========================================================================
-- DISK CHANGE MONITORING AND SYNCHRONIZATION (AI -> NVIM)
-- ==========================================================================

-- Autocmd to force Neovim buffers to refresh when AI works
state.watch_group = vim.api.nvim_create_augroup("KiloSyncGroup", { clear = true })
vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorMoved", "CursorHold" }, {
  group = state.watch_group,
  pattern = "*",
  callback = function()
    if vim.fn.getcmdwintype() == "" then
      vim.cmd("checktime")
    end
  end,
})

-- On-screen notification if AI rewrote the current file
vim.api.nvim_create_autocmd("FileChangedShellPost", {
  group = state.watch_group,
  pattern = "*",
  callback = function()
    vim.notify("File was updated by Kilo agent on disk", vim.log.levels.INFO)
  end,
})

-- Track new file creation by AI agent via libuv
local uv = vim.loop or vim.uv

local function start_dir_watch()
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
-- KEYMAPPINGS ASSIGNMENT
-- ==========================================================================

local map = vim.keymap.set
local opts = { noremap = true, silent = true }

-- <leader>kk — Show / hide Kilo Code chat panel
map("n", "<leader>kk", toggle_kilo,
  vim.tbl_extend("force", opts, { desc = "Toggle Kilo TUI Panel" }))

-- <leader>kf — Copy current file path and paste into Kilo as @-mention
map("n", "<leader>kf", send_current_file_to_kilo,
  vim.tbl_extend("force", opts, { desc = "Send current file to Kilo" }))

-- <leader>kl — Send current file with cursor line number to Kilo
map(
  "n",
  "<leader>kl",
  send_current_file_with_line_to_kilo,
  vim.tbl_extend("force", opts, { desc = "Send current file + line to Kilo" })
)

-- ==========================================================================
-- CLEANUP
-- ==========================================================================

-- Clean up file watcher handle when leaving directory
vim.api.nvim_create_autocmd("DirChanged", {
  group = state.watch_group,
  callback = function()
    if state.fs_handle then
      uv.fs_event_stop(state.fs_handle)
      state.fs_handle = nil
    end
  end,
})

-- ==========================================================================
-- MODULE PATTERN (required by lazy.nvim spec loader)
-- ==========================================================================

-- Return M to follow lazy.nvim plugin spec pattern
-- Only load once to avoid returning userdata in the module table
if vim.g.kilo_integration_loaded then
  return
end
vim.g.kilo_integration_loaded = true
return M
