-- Send-file handlers: current file, file+line, containing folder.

return function(ctx, config)
	local display = config.display_name

	return {
		send_current_file = function(opts)
			ctx.send_file("File added to " .. display .. " context", { focused = opts and opts.focused })
		end,

		send_current_file_with_line = function(opts)
			local line_number = ctx.get_cursor_line()
			local relative_path = ctx.get_relative_path()
			ctx.send(
				ctx.make_file_reference(relative_path, " line " .. line_number),
				"File + line context added to " .. display,
				{ focused = opts and opts.focused },
				relative_path
			)
		end,

		send_current_file_containing_folder = function(opts)
			local relative_path = ctx.get_relative_path()
			local current_folder = relative_path:match("(.*)/") or "."
			ctx.send(
				"@" .. current_folder .. "/",
				"Folder added to " .. display .. " context",
				{ focused = opts and opts.focused },
				relative_path
			)
		end,
	}
end
