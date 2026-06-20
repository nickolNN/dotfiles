-- Sending function/identifier under cursor to Kilo chat

local buffer = require("plugins.kilo-integration.buffer_utils")

local function walk_tree(nodes, cursor_pos)
  local lnum = cursor_pos[1] - 1
  local col = cursor_pos[2]
  for _, node in ipairs(nodes) do
    local sl = node.range.start.line
    local sc = node.range.start.character
    local el = node.range["end"].line
    local ec = node.range["end"].character
    if lnum >= sl and lnum <= el and col >= sc and col <= ec then
      local name = node.name
      if name then
        return name
      end
      local found = walk_tree(node.children or {}, {lnum, col})
      if found then
        return found
      end
    end
  end
  return nil
end

local function _fn_name_from_lsp()
  local params = vim.lsp.util.make_position_params(0, "utf-32")
  local ok, resp = pcall(vim.lsp.buf_request_sync, 0, "textDocument/documentSymbol", params, 1000)
  if not ok or not resp then
    return nil
  end

  local cursorpos = vim.api.nvim_win_get_cursor(0)
  local cursor_pos = {cursorpos[1] - 1, cursorpos[2]}

  for _, _, r in pairs(resp) do
    if r and r.result then
      local name = walk_tree(r.result, cursor_pos)
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

local function _format_diagnostic_part(d, include_line_info)
  local parts = {}
  if include_line_info then
    local level = vim.diagnostic.severity[d.severity] or "HINT"
    table.insert(parts, level .. " line " .. (d.lnum + 1) .. " col " .. (d.col + 1))
  end
  if d.code then
    table.insert(parts, "[" .. d.code .. "]")
  end
  if d.message then
    table.insert(parts, d.message)
  end
  if d.source then
    table.insert(parts, "(source: " .. d.source .. ")")
  end
  return table.concat(parts, " | ")
end

local function _get_diagnostics(filter)
  local diags = vim.diagnostic.get(0, {
    severity = { min = vim.diagnostic.severity.HINT },
  })
  if #diags == 0 then
    return nil
  end

  local parts = {}
  for _, d in ipairs(diags) do
    if not filter or d.lnum == filter then
      table.insert(parts, _format_diagnostic_part(d, true))
    end
  end

  if #parts == 0 then
    return nil
  end
  return parts
end

local function _diagnostics_for_file()
  local parts = _get_diagnostics(nil)
  if not parts then
    return nil
  end
  return parts
end

local function _diagnostics_for_line()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local parts = _get_diagnostics(line - 1)
  if not parts then
    return nil
  end
  return table.concat(parts, "; ")
end

local function _all_diagnostics()
  local parts = _diagnostics_for_file()
  if not parts then
    return nil
  end
  return table.concat(parts, "\n")
end

return function(terminal)
  local function _focus_terminal()
    terminal:focusActiveTerminal()
  end

  local function send_under_cursor()
    local chan = buffer.ensure_context(terminal)
    if not chan then
      return
    end

    local line_number = vim.api.nvim_win_get_cursor(0)[1]
    local fn_name = fn_name_under_cursor()
    local relative_path = buffer.get_relative_path()
    local text_to_send = "@" .. relative_path .. " line " .. line_number .. " (function: " .. fn_name .. ")"
    local diag_info = _diagnostics_for_line()
    if diag_info then
      text_to_send = text_to_send .. " [errors/warnings: " .. diag_info .. "]"
    end
    text_to_send = text_to_send .. "\n"
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("Function context added to Kilo: " .. fn_name, vim.log.levels.INFO)
  end

  local function send_all_diagnostics()
    local chan = buffer.ensure_context(terminal)
    if not chan then
      return
    end

    local relative_path = buffer.get_relative_path()
    local diag_info = _all_diagnostics()
    if not diag_info then
      vim.notify("No diagnostics found in current buffer", vim.log.levels.INFO)
      return
    end

    local text_to_send = "fix all problems in @" .. relative_path .. ":\n" .. diag_info .. "\n"
    vim.api.nvim_chan_send(chan, text_to_send)
    _focus_terminal()
    vim.notify("All diagnostics sent to Kilo for: " .. relative_path, vim.log.levels.INFO)
  end

  return {
    send_under_cursor = send_under_cursor,
    send_all_diagnostics = send_all_diagnostics,
  }
end
