-- Sending current file or file+line context to Kilo chat

local context = require("plugins.kilo-integration.format_context")

local buffer = require("plugins.kilo-integration.context")

local LINE_CONTEXT_SUFFIX = " line "

return function(terminal)
  return {
    send_current_file = function(opts)
      context.send_file(terminal, "File added to Kilo context", { skip_focus = not (opts and opts.focused) })
    end,

    send_current_file_with_line = function(opts)
      local line_number = buffer.get_cursor_line()
      context.send(
        terminal,
        context.make_file_reference(buffer.get_relative_path(),
          LINE_CONTEXT_SUFFIX .. line_number .. "\n"),
        "File + line context added to Kilo",
        { skip_focus = not (opts and opts.focused) }
      )
    end,

    send_current_file_containing_folder = function(opts)
      local relative_path = buffer.get_relative_path()
      local current_folder = relative_path:match("(.*)/") or "."
      context.send(terminal, "@" .. current_folder .. "/", "Folder added to Kilo context", { skip_focus = not (opts and opts.focused) })
    end,
  }
end
