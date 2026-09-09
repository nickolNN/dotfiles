#!/bin/sh
# heading.sh — dynamic status-right heading: git branch of the active pane.
# Called by tmux as #(~/.config/tmux/heading.sh '#{pane_current_path}')
# every status-interval. Prints nothing when the pane isn't in a git repo.

d="${1:-$(tmux display -p '#{pane_current_path}' 2>/dev/null)}"
[ -n "$d" ] || exit 0
b=$(git -C "$d" symbolic-ref --short HEAD 2>/dev/null) || exit 0
printf '%s' "$b"