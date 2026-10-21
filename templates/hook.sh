#!/usr/bin/env bash
# Template Muse hook script for one Agent Bus share.
# `agentbus setup-messaging` instantiates this per share with real paths;
# this file documents the shape for anyone wiring it up by hand.
#
# The hook runtime (Muse) sources $HATCH_HOOK_RUNTIME, which provides
# `silent` and `wake`. The script polls only a local flag's worth of work:
# `agentbus check` diffs the local inbox against local seen-state.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

SHARE="__SHARE_NAME__"
AGENTBUS="__AGENTBUS_CLI__"   # e.g. node /path/to/agent-bus/dist/cli.js

NEW="$($AGENTBUS check --share "$SHARE" --mark-seen 2>/dev/null || true)"
if [ -n "$NEW" ]; then
  wake "new Agent Bus message(s) in share $SHARE" "{\"files\": \"$(echo "$NEW" | paste -sd, -)\"}"
else
  silent "no new messages"
fi
