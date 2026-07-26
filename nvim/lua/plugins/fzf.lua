require("fzf-lua").setup({ profile = "fzf-native" })

local fzf = require("fzf-lua")

local map = vim.keymap.set

map("n", "<leader>sf", fzf.files, { silent = true, desc = "Find files" })
map("n", "<leader>sg", fzf.live_grep, { silent = true, desc = "Live grep" })
map("n", "<leader><space>", fzf.buffers, { silent = true, desc = "Buffers" })
map("n", "<leader>sw", fzf.grep, { silent = true, desc = "Grep word" })
map("n", "<leader>ss", fzf.lsp_document_symbols, { silent = true, desc = "Document symbols" })
map("n", "<leader>sd", fzf.diagnostics_document, { silent = true, desc = "Document diagnostics" })
map("n", "<leader>sr", fzf.resume, { silent = true, desc = "Resume last query" })
map("n", "<leader>s.", fzf.oldfiles, { silent = true, desc = "Old files" })

map("n", "<leader>gl", fzf.git_commits, { silent = true, desc = "Git commits" })
map("n", "<leader>gf", fzf.git_bcommits, { silent = true, desc = "Git file commits" })
map("n", "<leader>gb", fzf.git_blame, { silent = true, desc = "Git blame" })

require("todo-comments").setup({})

map("n", "<leader>st", "<cmd>TodoTrouble<cr>", { silent = true, desc = "Todos" })
map("n", "]t", function()
  require("todo-comments").jump_next({ keywords = { "TODO", "HACK", "WARN" } })
end, { silent = true, desc = "Next todo" })
map("n", "[t", function()
  require("todo-comments").jump_prev({ keywords = { "TODO", "HACK", "WARN" } })
end, { silent = true, desc = "Previous todo" })
