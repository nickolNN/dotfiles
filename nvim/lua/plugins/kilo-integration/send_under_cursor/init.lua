local buffer = require("plugins.kilo-integration.context")
local context = require("plugins.kilo-integration.format_context")
local fn_name = require("plugins.kilo-integration.send_under_cursor.fn_name")

local function _format_diagnostic_part(d)
  local parts = {}
  local level = vim.diagnostic.severity[d.severity] or "HINT"
  table.insert(parts, level .. " line " .. (d.lnum + 1) .. " col " .. (d.col + 1))
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

local function get_formatted_diagnostics(line_number_filter)
  local diags = vim.diagnostic.get(0, {
    severity = { min = vim.diagnostic.severity.HINT },
  })
  if #diags == 0 then
    return nil
  end

  local parts = {}
  for _, d in ipairs(diags) do
    if line_number_filter == nil or d.lnum == line_number_filter then
      table.insert(parts, _format_diagnostic_part(d))
    end
  end

  return #parts > 0 and parts or nil
end

return function(terminal)
  local function send_under_cursor()
    local line_number = buffer.get_cursor_line()
    local fn = fn_name.fn_name_under_cursor() or "<none>"
    local relative_path = buffer.get_relative_path()
    local text_to_send = "@" .. relative_path .. " line " .. line_number .. " (function: " .. fn .. ")"
    local diag_parts = get_formatted_diagnostics(line_number - 1)
    if diag_parts then
      text_to_send = text_to_send .. " [errors/warnings: " .. table.concat(diag_parts, "; ") .. "]"
    end
    text_to_send = text_to_send .. "\n"
    context.send(terminal, text_to_send, "Function context added to Kilo: " .. fn)
  end

  local function send_all_diagnostics()
    local relative_path = buffer.get_relative_path()
    local diag_parts = get_formatted_diagnostics(nil)
    if not diag_parts then
      vim.notify("No diagnostics found in current buffer", vim.log.levels.INFO)
      return
    end

    local text_to_send = "fix all problems in @" .. relative_path .. ":\n" .. table.concat(diag_parts, "\n") .. "\n"
    context.send(terminal, text_to_send, "All diagnostics sent to Kilo for: " .. relative_path)
  end

  return {
    send_under_cursor = send_under_cursor,
    send_all_diagnostics = send_all_diagnostics,
  }
end
