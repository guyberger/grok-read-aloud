#!/bin/bash
#
# Fast-forwards this checkout to origin/main and rebuilds the dev build, so the
# copy of the extension loaded in Chrome reloads itself into it.
#
#   tools/auto-update.sh                 # this checkout
#   tools/auto-update.sh --repo /path    # another one
#   tools/auto-update.sh --no-build      # pull only
#
# It is deliberately timid. It never resets, never stashes, never cleans and
# never merges anything but a fast-forward: if the tree is dirty, if HEAD is not
# main, or if main has moved in a way that would need a real merge, it says so
# and stops. Nothing it does can lose work.
#
# The last line of output is always `status=<word>`, which is what
# tests/auto-update.test.js reads.

set -u -o pipefail

REPO=""
BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; [ -n "$REPO" ] || { echo "--repo needs a path" >&2; exit 2; }; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [ -z "$REPO" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# `status=` is the last thing printed, whatever happens.
finish() { echo "status=$1"; exit "${2:-0}"; }

cd "$REPO" 2>/dev/null || { say "no such directory: $REPO"; finish failed-repo 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { say "not a git checkout: $REPO"; finish failed-repo 1; }

say "checking $REPO"

# node, for the build. launchd hands a process a PATH of almost nothing, so the
# installer resolves one and passes it in; this is the fallback for a run by
# hand, and for a Homebrew or nvm install that is not on the PATH either way.
resolve_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then echo "$NODE_BIN"; return; fi
  local found
  found="$(command -v node 2>/dev/null)" && [ -n "$found" ] && { echo "$found"; return; }
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  # The newest nvm install, by version order rather than by mtime.
  local nvm
  nvm="$(ls -d "${HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$nvm" ] && [ -x "$nvm" ] && { echo "$nvm"; return; }
  echo ""
}

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$BRANCH" != "main" ]; then
  say "on $BRANCH, not main — leaving it alone"
  finish skipped-branch
fi

# The explicit refspec rather than a bare branch name, so the remote-tracking
# ref this then compares against is certainly the one that was just fetched.
if ! git fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"; then
  say "could not fetch origin/main"
  finish failed-fetch 1
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main 2>/dev/null || echo "")"
if [ -z "$REMOTE" ]; then
  say "origin/main does not exist"
  finish failed-fetch 1
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  say "already at origin/main (${LOCAL:0:8})"
  finish up-to-date
fi

# Dirty is only asked about once there is something to pull: a tree being worked
# on with nothing waiting for it is the ordinary state of a working day, and a
# line in the log every hour saying so would be noise.
if [ -n "$(git status --porcelain)" ]; then
  say "origin/main has moved to ${REMOTE:0:8}, but there are local changes — not touching them"
  git status --short | sed 's/^/    /'
  finish skipped-dirty
fi

if ! git merge-base --is-ancestor HEAD origin/main; then
  say "origin/main (${REMOTE:0:8}) is not ahead of HEAD (${LOCAL:0:8}); this would need a real merge"
  finish skipped-diverged
fi

if ! git merge --ff-only origin/main >/dev/null 2>&1; then
  say "fast-forward to ${REMOTE:0:8} refused"
  finish failed-merge 1
fi
say "fast-forwarded ${LOCAL:0:8} → ${REMOTE:0:8}"

if [ "$BUILD" -eq 0 ]; then
  finish updated
fi

NODE="$(resolve_node)"
if [ -z "$NODE" ]; then
  say "pulled, but found no node to rebuild with — set NODE_BIN"
  finish failed-build 1
fi

if ! "$NODE" tools/build.js --dev --only chrome; then
  say "pulled, but the dev build failed"
  finish failed-build 1
fi

say "rebuilt dist/chrome; the extension picks it up within about half a minute"
finish updated
