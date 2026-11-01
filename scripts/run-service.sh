#!/usr/bin/env bash
# Snail user-service wrapper: map config errors (exit 2) to exit 0 for launchd KeepAlive.
set -euo pipefail

NODE="${1:?}"
SNAIL="${2:?}"
shift 2

"$NODE" "$SNAIL" "$@"
status=$?
if [ "$status" -eq 2 ]; then
  exit 0
fi
exit "$status"
