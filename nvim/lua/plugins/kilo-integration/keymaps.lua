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

  map_key("<leader>kf", function()
    key_handlers.send_current_file()
  end, "Send current file to Kilo")

  map_key("<leader>kF", function()
    key_handlers.send_current_file({ focused = true })
  end, "Send current file and focus Kilo")

  map_key("<leader>kd", function()
    key_handlers.send_current_file_containing_folder()
  end, "Send current file folder to Kilo")

  map_key("<leader>kD", function()
    key_handlers.send_current_file_containing_folder({ focused = true })
  end, "Send current file folder to Kilo (focus)")

  map_key("<leader>km", function()
    key_handlers.send_under_cursor()
  end, "Send function under cursor to Kilo")

  map_key("<leader>kM", function()
    key_handlers.send_under_cursor({ focused = true })
  end, "Send function under cursor to Kilo (focus)")

  map_key("<leader>kl", function()
    key_handlers.send_current_file_with_line()
  end, "Send current file + line to Kilo")

  map_key("<leader>kL", function()
    key_handlers.send_current_file_with_line({ focused = true })
  end, "Send current file + line to Kilo (focus)")

  map_key("<leader>ka", function()
    key_handlers.send_all_diagnostics()
  end, "Send all diagnostics to Kilo")

  map_key("<leader>kA", function()
    key_handlers.send_all_diagnostics({ focused = true })
  end, "Send all diagnostics to Kilo (focus)")

  map_key("<leader>kw", function()
    key_handlers.send_word_under_cursor()
  end, "Send word under cursor to Kilo")

  map_key("<leader>kW", function()
    key_handlers.send_word_under_cursor({ focused = true })
  end, "Send word under cursor to Kilo (focus)")
end
