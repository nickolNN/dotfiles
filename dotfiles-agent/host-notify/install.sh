#!/usr/bin/env bash
set -euo pipefail
# Installs (or updates) the pi desktop-notification bridge as a macOS
# LaunchAgent. Idempotent: re-running reloads with the current node path
# and restarts the daemon so server.mjs edits take effect.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.yadro.pi-notify"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE="/opt/homebrew/bin/node"
PORT="${PI_NOTIFY_PORT:-49151}"
BIND="${PI_NOTIFY_BIND:-127.0.0.1}"

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${SCRIPT_DIR}/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_NOTIFY_PORT</key><string>${PORT}</string>
    <key>PI_NOTIFY_BIND</key><string>${BIND}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pi-notify.log</string>
  <key>StandardErrorPath</key><string>/tmp/pi-notify.err</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  # Already loaded: restart in place (re-runs node → picks up server.mjs).
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
else
  # Not loaded yet: bootstrap, retrying past launchd's bootout→bootstrap EIO
  # race (errno 5) that can occur when reloading back-to-back.
  LOADED=0
  for _ in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
      LOADED=1
      break
    fi
    sleep 1
  done
  if [ "$LOADED" -ne 1 ]; then
    echo "✗ failed to bootstrap ${LABEL}" >&2
    exit 1
  fi
  launchctl enable "${DOMAIN}/${LABEL}"
fi

echo "✓ ${LABEL} running"
echo "  node:            ${NODE}"
echo "  notify endpoint: http://${BIND}:${PORT}/notify  (health: /health)"
