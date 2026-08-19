-- Keymap registration for agent integration.

local core = require("agent-integration")

return function(terminal, key_handlers, config)
	local leader = config.leader
	local display = config.display_name
	local map = vim.keymap.set
	local base_opts = { noremap = true, silent = true }

	local function map_key(lhs, rhs, desc)
		map("n", lhs, rhs, vim.tbl_extend("force", base_opts, { desc = desc }))
	end

	-- Toggle
	map_key("<leader>" .. leader .. leader, function()
		terminal.toggle()
	end, "Toggle " .. display .. " TUI Panel")

	-- Action keys: lowercase = background, uppercase = focus
	for _, a in ipairs(core.ACTIONS) do
		map_key("<leader>" .. leader .. a.key, function()
			key_handlers[a.handler]()
		end, a.action .. " to " .. display)
		map_key("<leader>" .. leader .. a.key:upper(), function()
			key_handlers[a.handler]({ focused = true })
		end, a.action .. " to " .. display .. " (focus)")
	end
end
