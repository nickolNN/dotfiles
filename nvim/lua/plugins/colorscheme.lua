if not pcall(vim.cmd.colorscheme, "matrix") then
  pcall(vim.cmd.colorscheme, "tokyonight")
end
