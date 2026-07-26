local ts = require("nvim-treesitter")

ts.setup({})

ts.install({
  "bash",
  "c",
  "diff",
  "html",
  "javascript",
  "jsdoc",
  "json",
  "lua",
  "luadoc",
  "luap",
  "markdown",
  "markdown_inline",
  "printf",
  "python",
  "query",
  "regex",
  "toml",
  "tsx",
  "typescript",
  "vim",
  "vimdoc",
  "xml",
  "yaml",
  "go",
  "vue",
})

local ts_augroup = vim.api.nvim_create_augroup("nvim_treesitter", { clear = true })

vim.api.nvim_create_autocmd("FileType", {
  group = ts_augroup,
  callback = function(event)
    local ok = pcall(vim.treesitter.start, event.buf)
    if ok then
      vim.bo[event.buf].indentexpr = "v:lua.require('nvim-treesitter').indentexpr()"
    end
  end,
})

local move = require("nvim-treesitter-textobjects.move")

require("nvim-treesitter-textobjects").setup({
  move = { set_jumps = true },
})

local function ts_map(modes, lhs, fn, desc)
  vim.keymap.set(modes, lhs, fn, { desc = desc })
end

ts_map({ "n", "x", "o" }, "]f", function()
  move.goto_next_start("@function.outer")
end, "Next Function")

ts_map({ "n", "x", "o" }, "[f", function()
  move.goto_previous_start("@function.outer")
end, "Prev Function")

ts_map({ "n", "x", "o" }, "]c", function()
  move.goto_next_start("@class.outer")
end, "Next Class")

ts_map({ "n", "x", "o" }, "[c", function()
  move.goto_previous_start("@class.outer")
end, "Prev Class")

ts_map({ "n", "x", "o" }, "]a", function()
  move.goto_next_start("@parameter.inner")
end, "Next Parameter")

ts_map({ "n", "x", "o" }, "[a", function()
  move.goto_previous_start("@parameter.inner")
end, "Prev Parameter")

require("nvim-ts-autotag").setup({})

require("ts-comments").setup({})
