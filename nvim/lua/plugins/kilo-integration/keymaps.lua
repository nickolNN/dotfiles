-- Keybindings for Kilo integration

return function(terminal, key_handlers)
  local map = vim.keymap.set
  local opts = { noremap = true, silent = true }

  local function map_key(lhs, rhs, desc)
    map("n", lhs, rhs, vim.tbl_extend("force", opts, { desc = desc }))
  end

  map_key("<leader>kk", function()
    terminal.toggle()
  end, "Toggle Kilo TUI Panel")

  local specs = {
    { "f", "send_current_file", "Send current file to Kilo", "Send current file and focus Kilo" },
    {
      "d",
      "send_current_file_containing_folder",
      "Send current file folder to Kilo",
      "Send current file folder to Kilo (focus)",
    },
    { "m", "send_under_cursor", "Send function under cursor to Kilo", "Send function under cursor to Kilo (focus)" },
    {
      "l",
      "send_current_file_with_line",
      "Send current file + line to Kilo",
      "Send current file + line to Kilo (focus)",
    },
    { "a", "send_all_diagnostics", "Send all diagnostics to Kilo", "Send all diagnostics to Kilo (focus)" },
    { "w", "send_word_under_cursor", "Send word under cursor to Kilo", "Send word under cursor to Kilo (focus)" },
  }

  for _, spec in ipairs(specs) do
    local key, name, desc, desc_focus = spec[1], spec[2], spec[3], spec[4]
    map_key("<leader>k" .. key, function()
      key_handlers[name]()
    end, desc)
    map_key("<leader>k" .. key:upper(), function()
      key_handlers[name]({ focused = true })
    end, desc_focus)
  end
end
