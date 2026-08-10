-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
local o = vim.o
o.colorcolumn = "100"
vim.opt.sessionoptions = "buffers,curdir,folds,help,tabpages,winsize,winpos,terminal,localoptions"

-- Neovim's default terminal-mode cursor blinks (blinkon500-blinkoff500). In a
-- :terminal panel (e.g. Kilo) that reads as a cursor blinking in sync with the
-- TUI spinner. blinkon0/blinkoff0 makes it a solid block; other modes untouched.
vim.opt.guicursor:append("t:block-blinkon0-blinkoff0-TermCursor")

-- Kilo runs in a built-in :terminal; Neovim's default belloff=all
-- swallows its BEL so the tmux/Alacritty bell never fires. Silence
-- every bell source except 'term' so the Kilo bell reaches the host
-- terminal (pane bell + dock bounce) while ESC/error beeps stay off.
vim.opt.belloff = "backspace,cursor,complete,copy,ctrlg,error,esc,hangul,lang,mess,showmatch,operator,register,shell,spell,wildmode"
