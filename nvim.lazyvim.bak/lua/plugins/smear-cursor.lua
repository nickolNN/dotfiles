return {
  "sphamba/smear-cursor.nvim",
  enabled = true,
  opts = {
    time_interval = 7,
    cursor_color = "none",
    stiffness = 0.65, -- 0.6      [0, 1]
    trailing_stiffness = 0.5, -- 0.45     [0, 1]
    stiffness_insert_mode = 0.6, -- 0.5      [0, 1]
    trailing_stiffness_insert_mode = 0.55, -- 0.5      [0, 1]
    damping = 0.9, -- 0.85     [0, 1]
    damping_insert_mode = 0.9, -- 0.9      [0, 1]
    distance_stop_animating = 0.25, -- 0.1      > 0
  },
}
