---@type snacks.Config
local snacksOpts = {
  lazygit = { enabled = true },
  animate = {
    duration = 100, -- ms per step
    easing = "inOutBounce",
    fps = 144, -- frames per second. Global setting for all animations
  },
  scroll = {
    animate = {
      easing = "inOutBounce",
    },
    -- faster animation when repeating scroll after delay
    animate_repeat = {
      delay = 100, -- delay in ms before using the repeat animation
    },
    -- what buffers to animate
    filter = function(buf)
      return vim.g.snacks_scroll ~= false and vim.b[buf].snacks_scroll ~= false and vim.bo[buf].buftype ~= "terminal"
    end,
  },
  indent = {
    style = "out",
  },
}

return snacksOpts
