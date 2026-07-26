local map = vim.keymap.set

map({ "n", "x" }, "j", "v:count == 0 ? 'gj' : 'j'", { desc = "Down", expr = true, silent = true })
map({ "n", "x" }, "<Down>", "v:count == 0 ? 'gj' : 'j'", { desc = "Down", expr = true, silent = true })
map({ "n", "x" }, "k", "v:count == 0 ? 'gk' : 'k'", { desc = "Up", expr = true, silent = true })
map({ "n", "x" }, "<Up>", "v:count == 0 ? 'gk' : 'k'", { desc = "Up", expr = true, silent = true })

map("n", "<C-h>", "<C-w>h", { desc = "Go to Left Window", remap = true })
map("n", "<C-j>", "<C-w>j", { desc = "Go to Lower Window", remap = true })
map("n", "<C-k>", "<C-w>k", { desc = "Go to Upper Window", remap = true })
map("n", "<C-l>", "<C-w>l", { desc = "Go to Right Window", remap = true })

map("n", "<C-Up>", "<cmd>resize +2<cr>", { desc = "Increase Window Height", silent = true })
map("n", "<C-Down>", "<cmd>resize -2<cr>", { desc = "Decrease Window Height", silent = true })
map("n", "<C-Left>", "<cmd>vertical resize -2<cr>", { desc = "Decrease Window Width", silent = true })
map("n", "<C-Right>", "<cmd>vertical resize +2<cr>", { desc = "Increase Window Width", silent = true })

map("n", "<A-j>", "<cmd>execute 'move .+' . v:count1<cr>==", { desc = "Move Down", silent = true })
map("n", "<A-k>", "<cmd>execute 'move .-' . (v:count1 + 1)<cr>==", { desc = "Move Up", silent = true })
map("i", "<A-j>", "<esc><cmd>m .+1<cr>==gi", { desc = "Move Down", silent = true })
map("i", "<A-k>", "<esc><cmd>m .-2<cr>==gi", { desc = "Move Up", silent = true })
map("v", "<A-j>", ":<C-u>execute \"'<,'>move '>+\" . v:count1<cr>gv=gv", { desc = "Move Down", silent = true })
map("v", "<A-k>", ":<C-u>execute \"'<,'>move '<-\" . (v:count1 + 1)<cr>gv=gv", { desc = "Move Up", silent = true })

map("n", "n", "'Nn'[v:searchforward].'zv'", { expr = true, desc = "Next Search Result", silent = true })
map("x", "n", "'Nn'[v:searchforward]", { expr = true, desc = "Next Search Result", silent = true })
map("o", "n", "'Nn'[v:searchforward]", { expr = true, desc = "Next Search Result", silent = true })
map("n", "N", "'nN'[v:searchforward].'zv'", { expr = true, desc = "Prev Search Result", silent = true })
map("x", "N", "'nN'[v:searchforward]", { expr = true, desc = "Prev Search Result", silent = true })
map("o", "N", "'nN'[v:searchforward]", { expr = true, desc = "Prev Search Result", silent = true })

map("i", ",", ",<c-g>u", { silent = true })
map("i", ".", ".<c-g>u", { silent = true })
map("i", ";", ";<c-g>u", { silent = true })

map({ "i", "x", "n", "s" }, "<C-s>", "<cmd>w<cr><esc>", { desc = "Save File", silent = true })

map("x", "<", "<gv", { desc = "Indent Left", silent = true })
map("x", ">", ">gv", { desc = "Indent Right", silent = true })

map("n", "gco", "o<esc>Vcx<esc><cmd>normal gcc<cr>fxa<bs>", { desc = "Add Comment Below" })
map("n", "gcO", "O<esc>Vcx<esc><cmd>normal gcc<cr>fxa<bs>", { desc = "Add Comment Above" })

map("n", "<leader>fn", "<cmd>enew<cr>", { desc = "New File", silent = true })

local function diagnostic_goto(next, severity)
  return function()
    vim.diagnostic.jump({
      count = (next and 1 or -1) * vim.v.count1,
      severity = severity and vim.diagnostic.severity[severity] or nil,
      float = true,
    })
  end
end

map("n", "]d", diagnostic_goto(true), { desc = "Next Diagnostic" })
map("n", "[d", diagnostic_goto(false), { desc = "Prev Diagnostic" })
map("n", "]e", diagnostic_goto(true, "ERROR"), { desc = "Next Error" })
map("n", "[e", diagnostic_goto(false, "ERROR"), { desc = "Prev Error" })
map("n", "]w", diagnostic_goto(true, "WARN"), { desc = "Next Warning" })
map("n", "[w", diagnostic_goto(false, "WARN"), { desc = "Prev Warning" })

map("n", "<leader>xq", function()
  local success, err = pcall(vim.fn.getqflist({ winid = 0 }).winid ~= 0 and vim.cmd.cclose or vim.cmd.copen)
  if not success and err then
    vim.notify(err, vim.log.levels.ERROR)
  end
end, { desc = "Quickfix List" })

map("n", "<leader>xl", function()
  local success, err = pcall(vim.fn.getloclist(0, { winid = 0 }).winid ~= 0 and vim.cmd.lclose or vim.cmd.lopen)
  if not success and err then
    vim.notify(err, vim.log.levels.ERROR)
  end
end, { desc = "Location List" })

map("n", "[q", function()
  local ok = pcall(vim.cmd.cprev)
  if not ok then
    vim.cmd.copen()
  end
end, { desc = "Previous Quickfix" })

map("n", "]q", function()
  local ok = pcall(vim.cmd.cnext)
  if not ok then
    vim.cmd.copen()
  end
end, { desc = "Next Quickfix" })

map("n", "<leader><tab>l", "<cmd>tablast<cr>", { desc = "Last Tab", silent = true })
map("n", "<leader><tab>f", "<cmd>tabfirst<cr>", { desc = "First Tab", silent = true })
map("n", "<leader><tab><tab>", "<cmd>tabnew<cr>", { desc = "New Tab", silent = true })
map("n", "<leader><tab>]", "<cmd>tabnext<cr>", { desc = "Next Tab", silent = true })
map("n", "<leader><tab>d", "<cmd>tabclose<cr>", { desc = "Close Tab", silent = true })
map("n", "<leader><tab>[", "<cmd>tabprevious<cr>", { desc = "Previous Tab", silent = true })

map("n", "<leader>-", "<C-W>s", { desc = "Split Window Below", remap = true })
map("n", "<leader>|", "<C-W>v", { desc = "Split Window Right", remap = true })
map("n", "<leader>wd", "<C-W>c", { desc = "Delete Window", remap = true })

map("n", "<S-h>", "<cmd>bprevious<cr>", { desc = "Prev Buffer", silent = true })
map("n", "<S-l>", "<cmd>bnext<cr>", { desc = "Next Buffer", silent = true })
map("n", "[b", "<cmd>bprevious<cr>", { desc = "Prev Buffer", silent = true })
map("n", "]b", "<cmd>bnext<cr>", { desc = "Next Buffer", silent = true })
map("n", "<leader>bb", "<cmd>e #<cr>", { desc = "Switch to Other Buffer", silent = true })
map("n", "<leader>`", "<cmd>e #<cr>", { desc = "Switch to Other Buffer", silent = true })

map("n", "<leader>bd", "<cmd>lua require('config.util').bufdelete(0)<cr>", { desc = "Delete Buffer", silent = true })

map("n", "<leader>ft", "<cmd>lua require('config.util').terminal({ cwd = vim.fn.getcwd() })<cr>", {
  desc = "Terminal (cwd)",
  silent = true,
})

map(
  "n",
  "<leader>fT",
  "<cmd>lua require('config.util').terminal({ cwd = vim.fs.root(0, '.git') or vim.fn.getcwd() })<cr>",
  { desc = "Terminal (root)", silent = true }
)

map("n", "<C-/>", "<cmd>lua require('config.util').terminal.toggle()<cr>", {
  desc = "Toggle Terminal",
  silent = true,
})
map("t", "<C-/>", "<cmd>lua require('config.util').terminal.toggle()<cr>", { desc = "Toggle Terminal" })

map("n", "<C-_>", "<cmd>lua require('config.util').terminal.toggle()<cr>", {
  desc = "Toggle Terminal",
  silent = true,
})
map("t", "<C-_>", "<cmd>lua require('config.util').terminal.toggle()<cr>", {
  desc = "Toggle Terminal",
  noremap = true,
})

map("n", "<leader>gg", "<cmd>lua require('config.util').lazygit()<cr>", { desc = "Lazygit", silent = true })

map("n", "<leader>n", "<cmd>lua require('config.util').notify_history()<cr>", {
  desc = "Notification History",
  silent = true,
})

map("n", "<leader>wm", "<cmd>lua require('config.util').zoom()<cr>", { desc = "Zoom Window", silent = true })
map("n", "<leader>uZ", "<cmd>lua require('config.util').zoom()<cr>", { desc = "Zoom Window", silent = true })
map("n", "<leader>uz", "<cmd>lua require('config.util').zen()<cr>", { desc = "Zen Mode", silent = true })

map("n", "<leader>qq", "<cmd>qa<cr>", { desc = "Quit All", silent = true })

map(
  "n",
  "<leader>us",
  "<cmd>lua require('config.util').toggle('spell')()<cr>",
  { desc = "Toggle Spell", silent = true }
)
map("n", "<leader>uw", "<cmd>lua require('config.util').toggle('wrap')()<cr>", { desc = "Toggle Wrap", silent = true })
map(
  "n",
  "<leader>uL",
  "<cmd>lua require('config.util').toggle('relativenumber')()<cr>",
  { desc = "Toggle Relative Number", silent = true }
)
map(
  "n",
  "<leader>uc",
  "<cmd>lua require('config.util').toggle('conceallevel')()<cr>",
  { desc = "Toggle Conceal Level", silent = true }
)
map(
  "n",
  "<leader>ul",
  "<cmd>lua require('config.util').toggle('number')()<cr>",
  { desc = "Toggle Line Numbers", silent = true }
)
map(
  "n",
  "<leader>uA",
  "<cmd>lua require('config.util').toggle('showtabline')()<cr>",
  { desc = "Toggle Tabline", silent = true }
)
map(
  "n",
  "<leader>ub",
  "<cmd>lua require('config.util').toggle('background')()<cr>",
  { desc = "Toggle Background", silent = true }
)

map("n", "<leader>ud", "<cmd>lua require('config.util').toggle_diagnostics()<cr>", {
  desc = "Toggle Diagnostics",
  silent = true,
})
map("n", "<leader>uh", "<cmd>lua require('config.util').toggle_inlay_hints()<cr>", {
  desc = "Toggle Inlay Hints",
  silent = true,
})

map("n", "<leader>cf", function()
  vim.lsp.buf.format()
end, { desc = "Format" })
