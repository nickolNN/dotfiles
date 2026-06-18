-- Keybindings for Kilo integration

return function(terminal, key_handlers)
  local map = vim.keymap.set
  local opts = { noremap = true, silent = true }

  -- <leader>kk — Show / hide Kilo Code chat panel
  map("n", "<leader>kk", function()
    terminal.toggle()
  end, vim.tbl_extend("force", opts, { desc = "Toggle Kilo TUI Panel" }))

  -- <leader>kf — Copy current file path and paste into Kilo as @-mention
  map("n", "<leader>kf", function()
    key_handlers.send_current_file()
  end, vim.tbl_extend("force", opts, { desc = "Send current file to Kilo" }))

  -- <leader>kd — Send current file's containing folder to Kilo
  map("n", "<leader>kd", function()
    key_handlers.send_current_file_containing_folder()
  end, vim.tbl_extend("force", opts, { desc = "Send current file folder to Kilo" }))

  -- <leader>km — Send current file's function under cursor to Kilo
  map("n", "<leader>km", function()
    key_handlers.send_under_cursor()
  end, vim.tbl_extend("force", opts, { desc = "Send function under cursor to Kilo" }))

  -- <leader>kl — Send current file with cursor line number to Kilo
  map("n", "<leader>kl", function()
    key_handlers.send_current_file_with_line()
  end, vim.tbl_extend("force", opts, { desc = "Send current file + line to Kilo" }))

  -- <leader>ka — Send all buffer diagnostics to Kilo
  map("n", "<leader>ka", function()
    key_handlers.send_all_diagnostics()
  end, vim.tbl_extend("force", opts, { desc = "Send all diagnostics to Kilo" }))
end
