-- Kilo Code & Neovim Integration — thin wrapper around shared agent-integration core.
return require("agent-integration").create({
	name = "kilo",
	command = "kilo .",
	leader = "k",
	display_name = "Kilo",
	bracketed_paste = false,
	is_terminal = function(bufName)
		return bufName:find("term://", 1, true) and bufName:find("kilo", 1, true)
	end,
})
