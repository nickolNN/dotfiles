require("lualine").setup({
  options = {
    theme = "auto",
    globalstatus = true,
  },
  sections = {
    lualine_a = { "mode" },
    lualine_b = { "branch" },
    lualine_c = { "diagnostics", "filetype", { "filename", path = 1 } },
    lualine_x = {
      {
        "diff",
        source = function()
          local g = vim.b.gitsigns_status_dict
          if g then
            return { added = g.added, modified = g.changed, removed = g.removed }
          end
        end,
      },
    },
    lualine_y = { "progress", "location" },
    lualine_z = {},
  },
})

require("bufferline").setup({
  options = {
    diagnostics = "nvim_lsp",
    always_show_bufferline = false,
    close_command = function(n)
      require("config.util").bufdelete(n)
    end,
    right_mouse_command = function(n)
      require("config.util").bufdelete(n)
    end,
  },
})

vim.keymap.set("n", "<leader>bp", "<cmd>BufferLineTogglePin<cr>", { desc = "Toggle Pin" })
vim.keymap.set("n", "<leader>br", "<cmd>BufferLineCloseRight<cr>", { desc = "Delete Right Buffers" })
vim.keymap.set("n", "<leader>bl", "<cmd>BufferLineCloseLeft<cr>", { desc = "Delete Left Buffers" })

require("which-key").setup({ preset = "helix" })
require("which-key").add({
  { "<leader>b", group = "buffer" },
  { "<leader>c", group = "code" },
  { "<leader>f", group = "file/find" },
  { "<leader>g", group = "git" },
  { "<leader>k", group = "kilo" },
  { "<leader>q", group = "quit" },
  { "<leader>s", group = "search" },
  { "<leader>u", group = "ui" },
  { "<leader>w", group = "window" },
  { "<leader>x", group = "diagnostics" },
  { "<leader><tab>", group = "tabs" },
})

require("mini.icons").setup({})
pcall(function()
  require("mini.icons").mock_nvim_web_devicons()
end)

local dashboard = require("alpha.themes.dashboard")

dashboard.section.header.val = {
  [[                                                    ]],
  [[ ███╗   ██╗███████╗ ██████╗ ██╗   ██╗██╗███╗   ███╗ ]],
  [[ ████╗  ██║██╔════╝██╔═══██╗██║   ██║██║████╗ ████║ ]],
  [[ ██╔██╗ ██║█████╗  ██║   ██║██║   ██║██║██╔████╔██║ ]],
  [[ ██║╚██╗██║██╔══╝  ██║   ██║╚██╗ ██╔╝██║██║╚██╔╝██║ ]],
  [[ ██║ ╚████║███████╗╚██████╔╝ ╚████╔╝ ██║██║ ╚═╝ ██║ ]],
  [[ ╚═╝  ╚═══╝╚══════╝ ╚═════╝   ╚═══╝  ╚═╝╚═╝     ╚═╝ ]],
  [[                                                    ]],
}

dashboard.section.buttons.val = {
  dashboard.button("f", "Find file", function()
    require("fzf-lua").files()
  end),
  dashboard.button("g", "Grep", function()
    require("fzf-lua").live_grep()
  end),
  dashboard.button("r", "Recent files", function()
    require("fzf-lua").oldfiles()
  end),
  dashboard.button("c", "Edit config", function()
    vim.cmd("edit " .. vim.fn.stdpath("config") .. "/init.lua")
  end),
  dashboard.button("s", "Restore session", function()
    require("persistence").load()
  end),
  dashboard.button("l", "Update plugins", function()
    vim.cmd("PackUpdate")
  end),
  dashboard.button("q", "Quit", "<cmd>qa<cr>"),
}

dashboard.section.footer.val = function()
  local plugins = #vim.pack.get()
  return string.format("%d plugins loaded", plugins)
end

require("alpha").setup(dashboard.config)
