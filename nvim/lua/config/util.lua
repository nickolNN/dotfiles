local M = {}

local term_buf = nil
local term_win = nil
local term_started = false

local zen_enabled = false
local zen_saved = {}

local diagnostics_enabled = true

local function has_ui()
  return #vim.api.nvim_list_uis() > 0
end

local function notify(msg, level)
  vim.notify(msg, level or vim.log.levels.INFO)
end

function M.toggle(option)
  return function()
    vim.o[option] = not vim.o[option]
    notify(option .. " " .. (vim.o[option] and "on" or "off"))
  end
end

function M.toggle_diagnostics()
  diagnostics_enabled = not diagnostics_enabled
  vim.diagnostic.enable(diagnostics_enabled)
  notify("Diagnostics " .. (diagnostics_enabled and "enabled" or "disabled"))
end

function M.toggle_inlay_hints()
  local ok, enabled = pcall(function()
    local current = vim.lsp.inlay_hint.is_enabled({ bufnr = 0 })
    vim.lsp.inlay_hint.enable(not current, { bufnr = 0 })
    return not current
  end)
  if ok then
    notify("Inlay hints " .. (enabled and "enabled" or "disabled"))
  else
    notify("No LSP supports inlay hints", vim.log.levels.WARN)
  end
end

local function terminal_open(opts)
  opts = opts or {}
  if not has_ui() then
    notify("Terminal not available in headless mode", vim.log.levels.WARN)
    return
  end

  local cmd = opts.cmd or vim.o.shell
  local cwd = opts.cwd or vim.fn.getcwd()
  local position = opts.position or "float"

  if not term_buf or not vim.api.nvim_buf_is_valid(term_buf) then
    term_buf = vim.api.nvim_create_buf(false, true)
    term_started = false
  end

  local win
  if position == "right" then
    vim.cmd("botright vsplit")
    vim.api.nvim_win_set_buf(0, term_buf)
    win = vim.api.nvim_get_current_win()
  else
    local cols = vim.o.columns
    local rows = vim.o.lines
    local width = math.floor(cols * 0.8)
    local height = math.floor(rows * 0.8)
    win = vim.api.nvim_open_win(term_buf, true, {
      relative = "editor",
      width = width,
      height = height,
      col = math.floor((cols - width) / 2),
      row = math.floor((rows - height) / 2),
      style = "minimal",
      border = "rounded",
    })
  end

  if not term_started then
    vim.fn.termopen(cmd, { cwd = cwd })
    term_started = true
  end

  vim.keymap.set("t", "<C-_>", function()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_hide(win)
    end
  end, { buffer = term_buf, noremap = true })

  term_win = win
end

local function terminal_toggle()
  if not has_ui() then
    notify("Terminal not available in headless mode", vim.log.levels.WARN)
    return
  end

  if not term_buf or not vim.api.nvim_buf_is_valid(term_buf) then
    terminal_open({ position = "float" })
    return
  end

  if term_win and vim.api.nvim_win_is_valid(term_win) then
    vim.api.nvim_win_hide(term_win)
    term_win = nil
    return
  end

  local cols = vim.o.columns
  local rows = vim.o.lines
  local width = math.floor(cols * 0.8)
  local height = math.floor(rows * 0.8)
  term_win = vim.api.nvim_open_win(term_buf, true, {
    relative = "editor",
    width = width,
    height = height,
    col = math.floor((cols - width) / 2),
    row = math.floor((rows - height) / 2),
    style = "minimal",
    border = "rounded",
  })
  vim.cmd("startinsert")
end

M.terminal = terminal_open
debug.setmetatable(M.terminal, {
  __index = { toggle = terminal_toggle },
})

function M.bufdelete(buf)
  buf = buf or 0
  local bufs = vim.tbl_filter(function(b)
    return vim.api.nvim_buf_is_valid(b) and vim.bo[b].buflisted
  end, vim.api.nvim_list_bufs())
  if #bufs == 1 then
    vim.cmd("enew")
  end
  vim.api.nvim_buf_delete(buf, { force = true })
end

function M.notify_history()
  vim.cmd("messages")
end

function M.zoom()
  vim.cmd("silent! only")
end

function M.zen()
  zen_enabled = not zen_enabled
  if zen_enabled then
    zen_saved = {
      laststatus = vim.o.laststatus,
      showtabline = vim.o.showtabline,
      number = vim.o.number,
      signcolumn = vim.o.signcolumn,
      cursorline = vim.o.cursorline,
    }
    vim.o.laststatus = 0
    vim.o.showtabline = 0
    vim.o.number = false
    vim.o.signcolumn = "no"
    vim.o.cursorline = false
  else
    vim.o.laststatus = zen_saved.laststatus or 3
    vim.o.showtabline = zen_saved.showtabline or 2
    vim.o.number = zen_saved.number or true
    vim.o.signcolumn = zen_saved.signcolumn or "auto"
    vim.o.cursorline = zen_saved.cursorline or false
  end
end

function M.lazygit()
  local cwd = vim.fn.getcwd()
  local ok, lines = pcall(vim.fn.systemlist, "git rev-parse --show-toplevel")
  if ok and lines and #lines > 0 and lines[1] ~= "" then
    cwd = lines[1]
  end
  terminal_open({ cmd = "lazygit", cwd = cwd })
end

return M
