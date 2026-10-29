#!/bin/bash
#
# Removes the hourly auto-update LaunchAgent that tools/auto-update-install.sh
# wrote. The log is left behind; delete it by hand if you want it gone.

set -u -o pipefail

LABEL="com.github.guyberger.grok-read-aloud.auto-update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/grok-read-aloud-auto-update.log"

if command -v launchctl >/dev/null 2>&1; then
  if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
    echo "unloaded $LABEL"
  elif launchctl unload "$PLIST" 2>/dev/null; then
    echo "unloaded $LABEL with the older launchctl"
  else
    echo "$LABEL was not loaded"
  fi
fi

if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "removed $PLIST"
else
  echo "no plist at $PLIST"
fi

[ -f "$LOG" ] && echo "the log is still at $LOG"
exit 0
