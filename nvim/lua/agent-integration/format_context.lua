-- Shared context formatting: relative paths, cursor position, file references,
-- and bracketed-paste-aware sending to agent terminals.

local PASTE_START = "\x1b[200~"
local PASTE_END = "\x1b[201~"

-- Module-level caches — safe to share across integrations since they depend
-- only on the current buffer/cursor, not on the agent config.
local _relative_path_cache = nil
local _last_buf_path = nil

local function get_relative_path()
	local full_path = vim.fn.expand("%:p")
	if _relative_path_cache ~= nil and _last_buf_path == full_path then
		return _relative_path_cache
	end
	local cwd = vim.fn.getcwd()
	local prefix = cwd .. "/"
	if string.sub(full_path, 1, #prefix) == prefix then
		_relative_path_cache = string.sub(full_path, #prefix + 1)
	else
		_relative_path_cache = full_path
	end
	_last_buf_path = full_path
	return _relative_path_cache
end

local function get_cursor_line(win_id)
	win_id = win_id or 0
	return vim.api.nvim_win_get_cursor(win_id)[1]
end

local function make_file_reference(path, suffix)
	return "@" .. path .. (suffix or " ")
end

-- Factory: returns config-dependent send helpers.
-- `terminal` and `state` are the shared terminal manager and plugin state.
return function(config, terminal, state)
	local warned = false
	local toggle_key = "<leader>" .. config.leader .. config.leader

	local function ensure_terminal()
		if state.chan then
			return state.chan
		end
		local _, chan = terminal.find()
		if not chan then
			if not warned then
				warned = true
				vim.notify(
					config.display_name .. " terminal is not running. Open it first with " .. toggle_key,
					vim.log.levels.WARN
				)
			end
			return nil
		end
		state.chan = chan
		return chan
	end

	local function send(text, message, opts, path)
		opts = opts or {}
		if not path or path == "" then
			vim.notify("Current buffer is not a file", vim.log.levels.WARN)
			return
		end
		local chan = state.chan or ensure_terminal()
		if not chan then
			return
		end

		local payload = text
		if config.bracketed_paste then
			payload = PASTE_START .. text .. PASTE_END
		end
		if opts.submit then
			payload = payload .. "\r"
		end
		vim.api.nvim_chan_send(chan, payload)
		if opts.focused then
			terminal:focus_active_terminal()
		end
		if not opts.skip_notify then
			vim.notify(message, vim.log.levels.INFO)
		end
	end

	return {
		get_relative_path = get_relative_path,
		get_cursor_line = get_cursor_line,
		make_file_reference = make_file_reference,
		send = send,
		send_file = function(message, opts)
			opts = opts or {}
			local relative_path = get_relative_path()
			send(make_file_reference(relative_path, " "), message, opts, relative_path)
		end,
	}
end
