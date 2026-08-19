-- Pi (pi coding agent) & Neovim integration — thin wrapper around shared agent-integration core.
return require("agent-integration").create({
	name = "pi",
	command = "pi",
	leader = "p",
	display_name = "Pi",
	bracketed_paste = true,
	is_terminal = function(bufName)
		if not bufName:find("term://", 1, true) then
			return false
		end
		-- Match only the command segment after the last ":" so unrelated shells
		-- (e.g. `pip install`) or paths containing "pi" are never misdetected.
		local cmd = bufName:match(":([^:]*)$")
		if not cmd then
			return false
		end
		cmd = cmd:match("^%s*(.-)%s*$")
		return cmd == "pi" or cmd:find("^pi%s") ~= nil
	end,
})
