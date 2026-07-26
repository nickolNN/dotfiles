local gh = function(x)
  return "https://github.com/" .. x
end

vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(ev)
    local name = ev.data.spec.name
    local kind = ev.data.kind
    if kind ~= "install" and kind ~= "update" then
      return
    end
    if name == "nvim-treesitter" then
      pcall(vim.cmd, "TSUpdate")
    elseif name == "mason.nvim" then
      pcall(vim.cmd, "MasonUpdate")
    elseif name == "blink.cmp" then
      pcall(function()
        require("blink.cmp").build():pwait()
      end)
    end
  end,
})

vim.pack.add({
  gh("nvim-lualine/lualine.nvim"),
  gh("akinsho/bufferline.nvim"),
  gh("folke/which-key.nvim"),
  gh("goolord/alpha-nvim"),
  gh("nvim-mini/mini.icons"),
  gh("MunifTanjim/nui.nvim"),
  gh("iruzo/matrix-nvim"),
  gh("folke/tokyonight.nvim"),
  gh("sphamba/smear-cursor.nvim"),
  gh("ibhagwan/fzf-lua"),
  gh("nvim-mini/mini.ai"),
  gh("nvim-mini/mini.pairs"),
  gh("nvim-treesitter/nvim-treesitter"),
  gh("nvim-treesitter/nvim-treesitter-textobjects"),
  gh("windwp/nvim-ts-autotag"),
  gh("folke/ts-comments.nvim"),
  gh("MagicDuck/grug-far.nvim"),
  gh("folke/todo-comments.nvim"),
  gh("nvim-lua/plenary.nvim"),
  gh("neovim/nvim-lspconfig"),
  gh("mason-org/mason.nvim"),
  gh("mason-org/mason-lspconfig.nvim"),
  gh("saghen/blink.lib"),
  gh("saghen/blink.cmp"),
  gh("stevearc/conform.nvim"),
  gh("folke/trouble.nvim"),
  gh("folke/lazydev.nvim"),
  gh("b0o/SchemaStore.nvim"),
  gh("lewis6991/gitsigns.nvim"),
  gh("MeanderingProgrammer/render-markdown.nvim"),
  gh("folke/persistence.nvim"),
})
