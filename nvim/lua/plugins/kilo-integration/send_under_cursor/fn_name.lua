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

local function _set_cached_fn_name(name, pos)
  _fn_name_cache = { name = name, pos = pos or vim.uv.now() * 1000 }
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

local _LSP_POSITION_ENCODING = "utf-32"
local _hover_parser = require("plugins.kilo-integration.send_under_cursor.fn_name_hover")

local function _fn_name_from_lsp(callback)
  local params = vim.lsp.util.make_position_params(0, _LSP_POSITION_ENCODING)

  local ok, err = pcall(function()
    vim.lsp.buf_request(0, "textDocument/hover", params, function(_, result)
      if result and result.contents then
        local name = _hover_parser(result)
        if name then
          callback(name)
        end
      end
      -- If hover didn't give us a name, fall through to treesitter in callback
    end)
  end)

  -- Don't cache LSP failure so treesitter can be tried on next call
  if ok then
    _set_cached_fn_name(nil, vim.uv.now() * 1000)
  end
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

  local name, status = _fn_name_from_lsp(function(f)
    if f then
      _set_cached_fn_name(f, vim.uv.now() * 1000)
    end
  end)

  if name then
    return name
  end

  -- Fallback to treesitter
  name = _fn_name_from_ts()
  if name then
    return name
  end

  -- Fallback to regex / word under cursor
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
