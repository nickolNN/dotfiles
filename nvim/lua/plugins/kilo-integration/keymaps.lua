-- Keybindings for Kilo integration

return function(terminal, key_handlers)
  local map = vim.keymap.set
  local opts = { noremap = true, silent = true }

  local function map_key(lhs, rhs, desc)
    map("n", lhs, rhs, vim.tbl_extend("force", opts, { desc = desc }))
  end

  -- <leader>kk — Show / hide Kilo Code chat panel
  map_key("<leader>kk", function()
    terminal.toggle()
  end, "Toggle Kilo TUI Panel")

  -- <leader>kf — Copy current file path and paste into Kilo as @-mention
  map_key("<leader>kf", function()
    key_handlers.send_current_file()
  end, "Send current file to Kilo")

  -- <leader>kd — Send current file's containing folder to Kilo
  map_key("<leader>kd", function()
    key_handlers.send_current_file_containing_folder()
  end, "Send current file folder to Kilo")

  -- <leader>km — Send current file's function under cursor to Kilo
  map_key("<leader>km", function()
    key_handlers.send_under_cursor()
  end, "Send function under cursor to Kilo")

  -- <leader>kl — Send current file with cursor line number to Kilo
  map_key("<leader>kl", function()
    key_handlers.send_current_file_with_line()
  end, "Send current file + line to Kilo")

  -- <leader>ka — Send all buffer diagnostics to Kilo
  map_key("<leader>ka", function()
    key_handlers.send_all_diagnostics()
  end, "Send all diagnostics to Kilo")

  -- <leader>kw - Send word under cursor to Kilo
  map_key("<leader>kw", function()
    key_handlers.send_word_under_cursor()
  end, "Send word under cursor to Kilo")
end
