-- Sending current file or file+line context to Kilo chat

local context = require("plugins.kilo-integration.format_context")

return function(terminal, state)
  return {
    send_current_file = function(opts)
      context.send_file(terminal, state, "File added to Kilo context", { focused = opts and opts.focused })
    end,

    send_current_file_with_line = function(opts)
      local line_number = context.get_cursor_line()
      local relative_path = context.get_relative_path()
      context.send(
        terminal,
        state,
        context.make_file_reference(relative_path, " line " .. line_number .. "\n"),
        "File + line context added to Kilo",
        { focused = opts and opts.focused },
        relative_path
      )
    end,

    send_current_file_containing_folder = function(opts)
      local relative_path = context.get_relative_path()
      local current_folder = relative_path:match("(.*)/") or "."
      context.send(
        terminal,
        state,
        "@" .. current_folder .. "/",
        "Folder added to Kilo context",
        { focused = opts and opts.focused },
        relative_path
      )
    end,
  }
end
