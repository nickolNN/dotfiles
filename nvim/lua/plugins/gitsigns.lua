require("gitsigns").setup({
  current_line_blame = true,
  current_line_blame_opts = { delay = 500 },
  on_attach = function(bufnr)
    local gs = require("gitsigns")
    local function map(lhs, rhs, desc)
      vim.keymap.set("n", lhs, rhs, { buffer = bufnr, silent = true, desc = desc })
    end

    map("<leader>ghs", gs.stage_hunk, "Stage hunk")
    map("<leader>ghr", gs.reset_hunk, "Reset hunk")
    map("<leader>ghS", gs.stage_buffer, "Stage buffer")
    map("<leader>ghu", gs.undo_stage_hunk, "Undo stage hunk")
    map("<leader>ghR", gs.reset_buffer, "Reset buffer")
    map("<leader>ghp", gs.preview_hunk_inline, "Preview hunk inline")
    map("<leader>ghb", function()
      gs.blame_line({ full = true })
    end, "Blame line")
    map("<leader>ghB", function()
      gs.blame({ full = true })
    end, "Blame buffer")
    map("<leader>ghd", gs.diffthis, "Diff this")
    map("<leader>ghD", function()
      gs.diffthis("~")
    end, "Diff this ~")
  end,
})
