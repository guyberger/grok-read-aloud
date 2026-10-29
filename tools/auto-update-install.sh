#!/bin/bash
#
# Installs the hourly auto-update as a macOS LaunchAgent pointing at this
# checkout. Run it once, from the checkout you load unpacked in Chrome.
#
#   tools/auto-update-install.sh
#   tools/auto-update-install.sh --no-load   # write the plist, don't load it
#
# launchd gives an agent a PATH of /usr/bin:/bin:/usr/sbin:/sbin and nothing
# else, which is why node is resolved here, now, and written into the plist:
# Homebrew puts it in /opt/homebrew/bin, nvm puts it under ~/.nvm, and neither
# is anywhere launchd will look.

set -eu -o pipefail

LABEL="com.github.guyberger.grok-read-aloud.auto-update"
LOAD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-load) LOAD=0; shift ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/tools/auto-update.sh"
[ -f "$SCRIPT" ] || { echo "cannot find $SCRIPT" >&2; exit 1; }

AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
LOG="$HOME/Library/Logs/grok-read-aloud-auto-update.log"

resolve_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then echo "$NODE_BIN"; return; fi
  local found
  found="$(command -v node 2>/dev/null)" && [ -n "$found" ] && { echo "$found"; return; }
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  local nvm
  nvm="$(ls -d "${HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$nvm" ] && [ -x "$nvm" ] && { echo "$nvm"; return; }
  echo ""
}

NODE="$(resolve_node)"
if [ -z "$NODE" ]; then
  echo "no node found. Install one, or run this with NODE_BIN=/path/to/node." >&2
  exit 1
fi
# A symlink in /opt/homebrew/bin survives a node upgrade; the versioned path an
# nvm install resolves to does not, so keep whichever one was asked for.
NODE_DIR="$(dirname "$NODE")"

mkdir -p "$AGENTS" "$(dirname "$LOG")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_BIN</key>
    <string>$NODE</string>
  </dict>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST

echo "wrote $PLIST"
echo "  checkout  $REPO"
echo "  node      $NODE"
echo "  log       $LOG"

if [ "$LOAD" -eq 0 ]; then
  echo "not loaded (--no-load)"
  exit 0
fi

if ! command -v launchctl >/dev/null 2>&1; then
  echo "no launchctl here, so nothing was loaded — this part is macOS only." >&2
  exit 1
fi

# `bootout`/`bootstrap` on anything current; `unload`/`load` for older macOS.
# Booting out first is how this doubles as "reinstall after moving the checkout".
if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
  echo "unloaded the previous agent"
fi
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "loaded (runs now, then hourly)"
else
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded with the older launchctl (runs now, then hourly)"
fi

echo
echo "Watch it with:  tail -f \"$LOG\""
echo "Remove it with: $REPO/tools/auto-update-uninstall.sh"
