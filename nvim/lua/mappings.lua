require "nvchad.mappings"

-- add yours here

local map = vim.keymap.set

map("n", ";", ":", { desc = "CMD enter command mode" })
map("i", "jk", "<ESC>")
-- Search word under cursor
map("n", "<leader>fc", function()
  local word = vim.fn.expand "<cword>" -- Get current word
  require("telescope.builtin").grep_string { search = word }
end, { desc = "Find current word" })
-- map({ "n", "i", "v" }, "<C-s>", "<cmd> w <cr>")
