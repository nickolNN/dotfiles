#!/usr/bin/env bash
# ── Session watcher ───────────────────────────────────────────────
# Watches ~/.agent-sessions and ~/.config/pi/sessions for new
# session files and sends a macOS notification with a summary.
#
# Managed by launchd: ~/Library/LaunchAgents/com.dotfiles.session-watcher.plist
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

WATCH_DIRS=(
      "$HOME/.agent-sessions"
      "$HOME/.config/pi/sessions"
)

# ── Debounce: track seen files ──────────────────────────────────
declare -A SEEN

# ── Extract summary from a session file ──────────────────────────
summarize() {
      local file="$1"
      local session_id="" cwd="" timestamp="" first_prompt=""
      local msg_count=0

      while IFS= read -r line; do
            case "$(echo "$line" | jq -r '.type // empty')" in
            session)
                  session_id=$(echo "$line" | jq -r '.id // empty')
                  cwd=$(echo "$line" | jq -r '.cwd // empty')
                  timestamp=$(echo "$line" | jq -r '.timestamp // empty')
                  ;;
            message)
                  local role
                  role=$(echo "$line" | jq -r '.message.role // empty')
                  if [ "$role" = "user" ] && [ -z "$first_prompt" ]; then
                        first_prompt=$(echo "$line" | jq -r '.message.content[0].text // empty')
                  fi
                  msg_count=$((msg_count + 1))
                  ;;
            esac
      done <"$file"

      # Format timestamp
      local when=""
      if [ -n "$timestamp" ]; then
            when=$(date -jf "%Y-%m-%dT%H:%M:%S" "${timestamp%.*}" "+%H:%M" 2>/dev/null || echo "$timestamp")
      fi

      # Truncate prompt
      if [ ${#first_prompt} -gt 120 ]; then
            first_prompt="${first_prompt:0:117}..."
      fi

      # Notification
      local title="Session: ${session_id:0:8}…"
      local subtitle="${when:+$when · }$(basename "$cwd") · ${msg_count} msgs"
      local body="${first_prompt:-no prompt}"

      osascript -e "display notification \"$body\" with title \"$title\" subtitle \"$subtitle\""
}

# ── Watch loop ───────────────────────────────────────────────────
# Ensure directories exist
for d in "${WATCH_DIRS[@]}"; do
      mkdir -p "$d"
done

# Use fswatch to monitor for new/modified files
# We watch for .jsonl files only (Pi session format)
fswatch -0 --event Created --event Updated --include '\.jsonl$' \
      "${WATCH_DIRS[@]}" 2>/dev/null | while IFS= read -r -d '' file; do

      # Debounce: skip if seen recently (within 5s)
      now=$(date +%s)
      if [ -n "${SEEN[$file]:-}" ]; then
            last=$((now - ${SEEN[$file]}))
            if [ "$last" -lt 5 ]; then
                  continue
            fi
      fi
      SEEN[$file]=$now

      # Wait a moment for the file to finish writing
      sleep 0.5

      # Skip if file doesn't exist or is empty
      [ -f "$file" ] || continue
      [ -s "$file" ] || continue

      summarize "$file"
done
