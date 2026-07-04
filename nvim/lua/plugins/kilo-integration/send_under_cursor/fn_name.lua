-- LSP cache to avoid synchronous requests when cursor hasn't moved
local _fn_name_cache = {}
local _CACHE_TTL_MS = 5000

local function _get_cached_fn_name()
  local now = vim.uv.now() * 1000
  if _fn_name_cache.pos and now - _fn_name_cache.pos < _CACHE_TTL_MS then
    return _fn_name_cache.name
  end
  return nil
end

local function _set_cached_fn_name(name)
  _fn_name_cache = { name = name, pos = vim.uv.now() * 1000 }
end

local function clear_fn_name_cache()
  _fn_name_cache = {}
end

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

local _LSP_TIMEOUT_MS = 1000
local _LSP_POSITION_ENCODING = "utf-32"

local function _walk_node(node, cursor_pos)
  if not node then
    return nil
  end
  local sl = node.range.start.line
  local el = node.range["end"].line
  if cursor_pos[1] < sl or cursor_pos[1] > el then
    return nil
  end
  if node.name then
    return node.name
  end
  for _, child in ipairs(node.children or {}) do
    local found = _walk_node(child, cursor_pos)
    if found then
      return found
    end
  end
  return nil
end

local function find_function_at_position(nodes, cursor_pos)
  for _, node in ipairs(nodes) do
    local result = _walk_node(node, cursor_pos)
    if result then
      return result
    end
  end
  return nil
end

local function _fn_name_from_lsp()
  local params = vim.lsp.util.make_position_params(0, _LSP_POSITION_ENCODING)
  local ok, resp = pcall(vim.lsp.buf_request_sync, 0, "textDocument/documentSymbol", params, _LSP_TIMEOUT_MS)
  if not ok or not resp then
    return nil, "request_failed"
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
    return nil, "no_result"
  end

  local best_name
  for _, node in ipairs(symbols) do
    if node.range.start.line == cursor_line then
      local name = find_function_at_position({ node }, { cursor_line, cursor_col })
      if name then
        best_name = name
      end
    end
  end
  return best_name, "ok"
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
  local stripped = line_text:gsub("^%s+", ""):gsub("^%a[%w_]*%s*", "")
  return stripped:match("^%a[%w_]*") or vim.fn.expand("<cword>")
end

local function fn_name_under_cursor()
  -- Check cache first (avoids blocking LSP request when cursor hasn't moved)
  local cached = _get_cached_fn_name()
  if cached then
    return cached
  end

  local name = _fn_name_from_lsp()
  if name then
    _set_cached_fn_name(name, 0)
    return name
  end
  name = _fn_name_from_ts()
  if name then
    _set_cached_fn_name(name, 0)
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
  clear_fn_name_cache = clear_fn_name_cache,
}
