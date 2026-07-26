require("mini.pairs").setup({
  modes = { command = true, insert = true, terminal = false },
})

local ai = require("mini.ai")
ai.setup({
  custom_textobjects = {
    f = ai.gen_spec.treesitter({ a = "@function.outer", i = "@function.inner" }),
    c = ai.gen_spec.treesitter({ a = "@class.outer", i = "@class.inner" }),
    o = ai.gen_spec.treesitter({
      a = { "@block.outer", "@conditional.outer", "@loop.outer" },
      i = { "@block.inner", "@conditional.inner", "@loop.inner" },
    }),
  },
})

require("grug-far").setup({ headerMaxWidth = 80 })
vim.keymap.set("n", "<leader>sr", function()
  local ext = vim.fn.expand("%:e")
  require("grug-far").open({
    prefills = { filesFilter = ext ~= "" and "*." .. ext or nil },
    transient = true,
  })
end, { desc = "Grug-far search (current filetype)" })
