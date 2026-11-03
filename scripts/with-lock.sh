#!/bin/sh
# Run a heavy command (install, build, full verify) under a machine-wide lock so
# parallel agents on one development VM take turns instead of starving each
# other. Usage: scripts/with-lock.sh pnpm verify
# Set CINDL_HEAVY_LOCK to use another lock file. Without flock (for example on
# macOS) the command runs unlocked, and this script says so.
set -eu
lock="${CINDL_HEAVY_LOCK:-/tmp/cindl-heavy-build.lock}"
if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-lock.sh <command> [args...]" >&2
  exit 2
fi
if command -v flock >/dev/null 2>&1; then
  exec flock "$lock" "$@"
fi
echo "with-lock: flock not found; running without the shared lock" >&2
exec "$@"
