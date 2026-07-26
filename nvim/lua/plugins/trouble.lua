require("trouble").setup({})

vim.keymap.set("n", "<leader>xx", "<cmd>Trouble diagnostics toggle<cr>", {
  silent = true,
  desc = "Diagnostics (Trouble)",
})
vim.keymap.set(
  "n",
  "<leader>xX",
  "<cmd>Trouble diagnostics toggle filter.buf=0<cr>",
  { silent = true, desc = "Buffer Diagnostics (Trouble)" }
)
vim.keymap.set("n", "<leader>cs", "<cmd>Trouble symbols toggle focus=false<cr>", {
  silent = true,
  desc = "Symbols (Trouble)",
})
vim.keymap.set("n", "<leader>xQ", "<cmd>Trouble qflist toggle<cr>", {
  silent = true,
  desc = "Quickfix List (Trouble)",
})
vim.keymap.set("n", "<leader>xL", "<cmd>Trouble loclist toggle<cr>", {
  silent = true,
  desc = "Location List (Trouble)",
})
