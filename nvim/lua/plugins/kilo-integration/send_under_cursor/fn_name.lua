local FUNCTION_NODE_TYPES = {
  function_declaration = true,
  function_definition = true,
  method_definition = true,
  method_declaration = true,
  arrow_function = true,
  function_item = true,
  fn_item = true,
  method = true,
}

local function walk_document_symbols(nodes, cursor_pos)
  local lnum = cursor_pos[1]
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
      local found = walk_document_symbols(node.children or {}, {lnum, col})
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
  local cursor_line = cursorpos[1] - 1
  local cursor_col = cursorpos[2]

  local symbols
  for _, v in pairs(resp) do
    if v and v.result then
      symbols = v.result
      break
    end
  end
  if not symbols then
    return nil
  end

  local best_name
  for _, node in ipairs(symbols) do
    if node.range.start.line == cursor_line then
      local name = walk_document_symbols({node}, {cursor_line, cursor_col})
      if name then
        best_name = name
      end
    end
  end
  return best_name
end

local function _fn_name_from_ts()
  local buf = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local line, col = cursor[1], cursor[2]
  local row = line - 1

  local parser = vim.treesitter.get_parser(buf)
  if not parser then
    return nil
  end
  parser:parse()
  local tree = parser:trees()[1]
  if not tree then
    return nil
  end

  local node = tree:root():descendant_for_range(row, col, row, col)
  while node do
    local t = node:type()
    if FUNCTION_NODE_TYPES[t] then
      local name_fields = node:field("name")
      if name_fields and name_fields[1] then
        local name_node = name_fields[1]
        return vim.treesitter.get_node_text(name_node, buf)
      end
    end
    node = node:parent()
  end
  return nil
end

local function _fn_name_from_regex(line_text)
  local stripped = line_text
    :gsub("^%s+", "")
    :gsub("^%a[%w_]*%s*", "")
  return stripped:match("^%a[%w_]*") or vim.fn.expand("<cword>")
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
  local cursorpos = vim.api.nvim_win_get_cursor(0)
  local line_text = vim.fn.getline(cursorpos[1])
  local fn = _fn_name_from_regex(line_text)
  if fn and fn ~= "" then
    return fn
  end
  return vim.fn.expand("<cword>")
end

return {
  fn_name_under_cursor = fn_name_under_cursor,
}
