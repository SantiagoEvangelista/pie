#!/bin/sh
set -eu

if [ -n "${PI_CODING_AGENT_PACKAGE:-}" ]; then
  pi_root="$PI_CODING_AGENT_PACKAGE"
else
  pi_bin="$(command -v pi)"
  prefix="$(CDPATH= cd -- "$(dirname "$pi_bin")/.." && pwd)"
  pi_root="$prefix/lib/node_modules/@earendil-works/pi-coding-agent"
fi

PI_CODING_AGENT_PACKAGE="$pi_root" \
node --test "$(dirname "$0")/../tests/compaction-hardening.test.mjs"
