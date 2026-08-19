-- Shared agent-integration core.
-- Creates a lazy.nvim plugin spec for any terminal-based coding agent.
--
-- Usage (from a wrapper plugin):
--   return require("agent-integration").create({
--     name         = "kilo",
--     command      = "kilo .",
--     leader       = "k",
--     display_name = "Kilo",
--     bracketed_paste = false,
--     is_terminal  = function(bufName) ... end,
--   })

local M = {}

M.ACTIONS = {
	{ key = "f", handler = "send_current_file", action = "Send current file" },
	{ key = "d", handler = "send_current_file_containing_folder", action = "Send current file folder" },
	{ key = "m", handler = "send_under_cursor", action = "Send function under cursor" },
	{ key = "l", handler = "send_current_file_with_line", action = "Send current file + line" },
	{ key = "a", handler = "send_all_diagnostics", action = "Send all diagnostics" },
	{ key = "w", handler = "send_word_under_cursor", action = "Send word under cursor" },
}

function M.create(config)
	config = vim.tbl_extend("force", { bracketed_paste = false }, config)

	local name = config.name
	local leader = config.leader
	local display = config.display_name
	local plugin_dir = vim.fn.stdpath("config") .. "/lua/plugins/" .. name .. "-integration"

	-- Build lazy.nvim keys for auto-loading
	local keys = {
		{ "<leader>" .. leader .. leader, mode = "n", desc = "Toggle " .. display .. " TUI Panel" },
	}
	for _, a in ipairs(M.ACTIONS) do
		table.insert(keys, {
			"<leader>" .. leader .. a.key,
			mode = "n",
			desc = a.action .. " to " .. display,
		})
		table.insert(keys, {
			"<leader>" .. leader .. a.key:upper(),
			mode = "n",
			desc = a.action .. " to " .. display .. " (focus)",
		})
	end

	return {
		name .. "-integration",
		dir = plugin_dir,
		lazy = true,
		keys = keys,
		config = function()
			local state = { buf = nil, win = nil, chan = nil }

			local terminal = require("agent-integration.terminal")(state, config)
			local context = require("agent-integration.format_context")(config, terminal, state)

			local key_handlers = vim.tbl_extend(
				"force",
				require("agent-integration.send_file")(context, config),
				require("agent-integration.send_under_cursor")(context, config)
			)

			require("agent-integration.keymaps")(terminal, key_handlers, config)
		end,
	}
end

return M
