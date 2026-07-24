local _fn_name_cache = {}

local function _get_cached_fn_name(buf, line, col)
  if _fn_name_cache.buf == buf and _fn_name_cache.line == line and _fn_name_cache.col == col then
    return _fn_name_cache.name
  end
  return nil
end

local function _set_cached_fn_name(name, buf, line, col)
  _fn_name_cache = { name = name, buf = buf, line = line, col = col }
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

local _LSP_POSITION_ENCODING = "utf-32"
local _hover_parser = require("plugins.kilo-integration.send_under_cursor.fn_name_hover")

local function _fn_name_from_lsp(callback)
  local params = vim.lsp.util.make_position_params(0, _LSP_POSITION_ENCODING)

  pcall(function()
    vim.lsp.buf_request(0, "textDocument/hover", params, function(err, result, ctx)
      if result and result.contents then
        local name = _hover_parser(result)
        if name then
          callback(name)
        end
      end
    end)
  end)
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
  local buf = vim.api.nvim_get_current_buf()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local line, col = cursor[1], cursor[2]

  local cached = _get_cached_fn_name(buf, line, col)
  if cached then
    return cached
  end

  local name = _fn_name_from_ts()
  if name then
    return name
  end

  _fn_name_from_lsp(function(f)
    if f then
      local cur = vim.api.nvim_win_get_cursor(0)
      if vim.api.nvim_get_current_buf() == buf and cur[1] == line and cur[2] == col then
        _set_cached_fn_name(f, buf, line, col)
      end
    end
  end)

  local line_text = vim.fn.getline(line)
  local fn = _fn_name_from_regex(line_text)
  if fn and fn ~= "" then
    return fn
  end
  return vim.fn.expand("<cword>")
end

return {
  fn_name_under_cursor = fn_name_under_cursor,
}
