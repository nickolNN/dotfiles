-- Extract function name from LSP hover response content
local FUNCTION_LANGUAGE_IDS = {
  ["typescript"] = true,
  ["typescriptreact"] = true,
  ["javascript"] = true,
  ["javascriptreact"] = true,
  ["tsx"] = true,
  ["jsx"] = true,
  ["ts"] = true,
  ["js"] = true,
}

return function(hover)
  local lang_id = hover.language_id
  local content = hover.contents.value

  if not content then
    return nil
  end

  -- TypeScript / JavaScript hover returns markdown
  if FUNCTION_LANGUAGE_IDS[lang_id] then
    -- Strip bold formatting: **functionName** -> functionName
    local stripped = content:gsub("\\*\\*(.-)\\*\\*", "%1"):gsub("^%s*(.-)%s*$", "%1")
    local words = stripped:match("^%a[%w_]*")
    if words then return words end
  end

  -- Plain text hover (Python, Go, etc.)
  local words = content:match("^%s*(.-)%s*$")
  if words then
    local first_word = words:match("^%a[%w_]*")
    if first_word then return first_word end
  end

  return nil
end
