-- Sending function/identifier under cursor to Kilo chat

local TERMINAL_NOT_RUNNING_MSG = "Kilo terminal is not running. Open it first with <leader>kk"
local NOT_A_FILE_MSG = "Current buffer is not a file"

local function get_relative_path()
  local full_path = vim.fn.expand("%:p")
  local cwd = vim.fn.getcwd() .. "/"
  local relative = full_path:gsub("^" .. cwd, "")
  return relative:gsub("^%./", "")
end

local function _validate_buffer()
  local path = get_relative_path()
  if path == "" or vim.bo.buftype == "terminal" then
    vim.notify(NOT_A_FILE_MSG, vim.log.levels.WARN)
    return false
  end
  return true
end

return function(terminal)
  local function _get_channel()
    local _, chan = terminal.find()
    if not chan then
      vim.notify(TERMINAL_NOT_RUNNING_MSG, vim.log.levels.WARN)
      return nil
    end
    return chan
  end

  local function _focus_terminal()
    terminal:focusActiveTerminal()
  end

  local function _diagnostics_from_lsp()
    local buf = vim.api.nvim_get_current_buf()
    local lnum = vim.api.nvim_win_get_cursor(0)[1] - 1
    local diags = vim.diagnostic.get(buf, {
      lnum = lnum,
      severity = { vim.diagnostic.severity.ERROR, vim.diagnostic.severity.WARN },
    })
    if not diags or #diags == 0 then
      return nil
    end
    local msgs = {}
    for _, d in ipairs(diags) do
      local parts = {}
      if d.code then
        table.insert(parts, "[" .. d.code .. "]")
      end
      if d.message then
        table.insert(parts, d.message)
      end
      if d.source then
        table.insert(parts, "(source: " .. d.source .. ")")
      end
      table.insert(msgs, table.concat(parts, " "))
    end
    return table.concat(msgs, " | ")
  end

  local function _fn_name_from_lsp()
    local params = vim.lsp.util.make_position_params(0, "utf-32")
    local ok, resp = pcall(vim.lsp.buf_request_sync, 0, "textDocument/documentSymbol", params, 1000)
    if not ok or not resp then
      return nil
    end

    local cursorpos = vim.api.nvim_win_get_cursor(0)
    local lnum, col = cursorpos[1] - 1, cursorpos[2]

    local function walk(syms)
      for _, s in ipairs(syms) do
        local sl, sc = s.range.start.line, s.range.start.character
        local el, ec = s.range["end"].line, s.range["end"].character
        if lnum >= sl and lnum <= el and col >= sc and col <= ec then
          return s.name, walk(s.children or {})
        end
        local found = walk(s.children or {})
        if found then
          return found
        end
      end
    end

    for _, _, r in pairs(resp) do
      if r and r.result then
        local name = walk(r.result)
        if name then
          return name
        end
      end
    end
    return nil
  end

  local function _fn_name_from_ts()
    local buf = vim.api.nvim_get_current_buf()
    local cursor = vim.api.nvim_win_get_cursor(0)
    local row = cursor[1] - 1 -- 0-indexed for Treesitter
    local col = cursor[2]

    local parser = vim.treesitter.get_parser(buf)
    if not parser then
      return nil
    end
    parser:parse()
    local tree = parser:trees()[1]
    if not tree then
      return nil
    end

    local node = tree:root():descendant_for_range(row - 1, col, row - 1, col)
    while node do
      local t = node:type()
      if
        t == "function_declaration"
        or t == "function_definition"
        or t == "method_definition"
        or t == "method_declaration"
        or t == "arrow_function"
        or t == "function_item"
        or t == "fn_item"
        or t == "method"
      then
        local name_node = node:field("name")[1] or node:field("name")[1]
        if name_node then
          return vim.treesitter.get_node_text(name_node, buf)
        end
      end
      node = node:parent()
    end
    return nil
  end

  local function fn_name_under_cursor()
    local name = _fn_name_from_lsp()
    if name then
      return name
    end
    name = _fn_name_from_ts()
    if name then
      return name
    end
    return vim.fn.expand("<cword>")
  end

  local function send_under_cursor()
    if not _validate_buffer() then
      return
    end
    local chan = _get_channel()
    if not chan then
      return
    end

    local line_number = vim.api.nvim_win_get_cursor(0)[1]
    local fn_name = fn_name_under_cursor()
    local relative_path = get_relative_path()
    local text_to_send = "@" .. relative_path .. " line " .. line_number .. " (function: " .. fn_name .. ")"
    local diag_info = _diagnostics_from_lsp()
    if diag_info then
      text_to_send = text_to_send .. " [errors/warnings: " .. diag_info .. "]"
    end
    text_to_send = text_to_send .. "\n"
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("Function context added to Kilo: " .. fn_name, vim.log.levels.INFO)
  end

  return {
    send_under_cursor = send_under_cursor,
  }
end
