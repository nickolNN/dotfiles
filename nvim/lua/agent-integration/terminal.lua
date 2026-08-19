-- Terminal finder, creation, and toggle management.
-- Terminal detection is delegated via `config.is_terminal(bufName)`.

local function find_channel(predicate)
	for _, chan in ipairs(vim.api.nvim_list_chans()) do
		if chan.buf and vim.api.nvim_buf_is_valid(chan.buf) then
			local buffer_name = vim.api.nvim_buf_get_name(chan.buf)
			if predicate(buffer_name) then
				return chan.buf, chan.id
			end
		end
	end
	return nil, nil
end

local function find_channel_by_buffer(target_buf)
	for _, chan in ipairs(vim.api.nvim_list_chans()) do
		if chan.buf == target_buf then
			return target_buf, chan.id
		end
	end
	return nil, nil
end

return function(initial_state, config)
	local state = initial_state or {}
	local is_terminal = config.is_terminal
	local Module = {}

	local function get_session()
		-- Check cached window first
		if state.win and vim.api.nvim_win_is_valid(state.win) then
			local buf = vim.api.nvim_win_get_buf(state.win)
			if buf and vim.api.nvim_buf_is_valid(buf) and is_terminal(vim.api.nvim_buf_get_name(buf)) then
				return state.win, buf, state.chan
			end
		end

		-- Reject stale cached window: must be valid AND actually displaying the
		-- cached buffer. After Neovim session restore the Lua state is nil but
		-- the physical split may still exist with a different/buffer mismatch.
		if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
			if state.win and vim.api.nvim_win_is_valid(state.win) then
				if vim.api.nvim_win_get_buf(state.win) == state.buf then
					return state.win, state.buf, state.chan
				end
			end
		end

		-- Scan all windows for a matching terminal
		local buf_to_chan = {}
		for _, chan in ipairs(vim.api.nvim_list_chans()) do
			if chan.buf then
				buf_to_chan[chan.buf] = chan.id
			end
		end

		for _, win in ipairs(vim.api.nvim_list_wins()) do
			if vim.api.nvim_win_is_valid(win) then
				local buf = vim.api.nvim_win_get_buf(win)
				if buf and vim.api.nvim_buf_is_valid(buf) then
					if is_terminal(vim.api.nvim_buf_get_name(buf)) then
						return win, buf, buf_to_chan[buf]
					end
				end
			end
		end

		return nil, nil, nil
	end

	local function _show_in_window(win, buf)
		vim.api.nvim_win_set_buf(win, buf)
	end

	local function _close_active_window()
		if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
			vim.api.nvim_buf_delete(state.buf, { force = true })
		end
		state.win = nil
		state.buf = nil
		state.chan = nil
	end

	local function _setup_new_buffer()
		vim.cmd("vsplit | terminal " .. config.command)
		state.win = vim.api.nvim_get_current_win()
		state.buf = vim.api.nvim_get_current_buf()
		state.chan = find_channel_by_buffer(state.buf)
		vim.bo[state.buf].bufhidden = "hide"
		vim.wo[state.win].number = false
		vim.wo[state.win].relativenumber = false
	end

	local function _ensure_session()
		local win, buf, chan = get_session()
		if win then
			state.win = win
			state.buf = buf
			state.chan = chan
			_show_in_window(win, buf)
			return
		end
		_setup_new_buffer()
	end

	local function _focus_active_terminal()
		local target_win = state.win
		if not target_win or not vim.api.nvim_win_is_valid(target_win) then
			target_win, state.buf, state.chan = get_session()
			if not target_win then
				return false
			end
		end
		vim.api.nvim_set_current_win(target_win)
		vim.cmd("startinsert")
		return true
	end

	Module.toggle = function()
		local win, buf, chan = get_session()
		if win then
			if win == vim.api.nvim_get_current_win() then
				return
			end
			state.win = win
			state.buf = buf
			state.chan = chan
			vim.api.nvim_set_current_win(win)
			return
		end

		if state.win and vim.api.nvim_win_is_valid(state.win) then
			_close_active_window()
			return
		end

		if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
			vim.cmd("vsplit")
			state.win = vim.api.nvim_get_current_win()
			vim.api.nvim_win_set_buf(state.win, state.buf)
		else
			_ensure_session()
		end

		vim.cmd("startinsert")
	end

	Module.find = function()
		return find_channel(is_terminal)
	end

	Module.focus_active_terminal = function()
		return _focus_active_terminal()
	end

	return Module
end
