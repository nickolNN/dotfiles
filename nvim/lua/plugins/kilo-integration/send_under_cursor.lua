-- Sending function/identifier under cursor to Kilo chat

local buffer = require("plugins.kilo-integration.buffer_utils")

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

local function _diagnostics_from_lsp()
  local diags = vim.diagnostic.get(0, {
    severity = { min = vim.diagnostic.severity.HINT },
  })
  if #diags == 0 then
    return nil
  end
  local parts = {}
  -- Only include errors and warnings for the under-cursor context
  for _, d in ipairs(diags) do
    if d.severity == vim.diagnostic.severity.ERROR or d.severity == vim.diagnostic.severity.WARN then
      table.insert(parts, _format_diagnostic_part(d, true))
    end
  end
  if #parts == 0 then
    return nil
  end
  return table.concat(parts, "; ")
end

local function _all_diagnostics()
  local diags = vim.diagnostic.get(0, {
    severity = { min = vim.diagnostic.severity.HINT },
  })
  if #diags == 0 then
    return nil
  end
  local parts = {}
  for _, d in ipairs(diags) do
    table.insert(parts, _format_diagnostic_part(d, true))
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
    local fn_name = buffer.fn_name_under_cursor()
    local relative_path = buffer.get_relative_path()
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
