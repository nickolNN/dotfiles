return {
  "milanglacier/minuet-ai.nvim",
  lazy = true,
  event = "LazyFile",
  config = function()
    local openai_api_key = "sk-NmiCMsI3-3HKRq1Xv6uMsQ" -- взять из выданного конфига
    local openai_base_endpoint = "https://litellm-proxy.ai.yadro.com"
    require("minuet").setup({
      n_completions = 3,
      context_window = 32768,
      request_timeout = 2,
      provider = "openai_fim_compatible",
      provider_options = {
        openai_compatible = {
          api_key = function()
            return openai_api_key
          end,
          end_point = openai_base_endpoint .. "/v1/chat/completions",
          model = "Qwen2.5-Coder-7B-Instruct-fp8",
          stream = true,
          optional = {
            max_tokens = 2000,
            top_p = 0.9,
          },
        },
        openai_fim_compatible = {
          api_key = function()
            return openai_api_key
          end,
          end_point = openai_base_endpoint .. "/completions",
          model = "Qwen2.5-Coder-7B-Instruct-fp8",
          stream = true,
          template = {
            prompt = function(context_before_cursor, context_after_cursor, _)
              return "<|fim_prefix|>"
                .. context_before_cursor
                .. "<|fim_suffix|>"
                .. context_after_cursor
                .. "<|fim_middle|>"
            end,
            suffix = false,
          },
          optional = {
            max_tokens = 2000,
            top_p = 0.9,
          },
        },
      },
      virtualtext = {
        -- auto_trigger_ft = { "typescript", "html", "lua", "htmlangular", "json" },
        keymap = {
          accept = "<A-a>",
          accept_line = "<A-o>",
          accept_n_lines = "<A-z>",
          prev = "<A-k>",
          next = "<A-j>",
          dismiss = "<A-c>",
        },
      },
    })
  end,
}
