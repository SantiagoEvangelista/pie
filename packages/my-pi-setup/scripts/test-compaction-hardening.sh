#!/bin/sh
set -eu

if [ -n "${PI_CODING_AGENT_PACKAGE:-}" ]; then
  pi_root="$PI_CODING_AGENT_PACKAGE"
else
  pi_bin="$(command -v pi)"
  prefix="$(CDPATH= cd -- "$(dirname "$pi_bin")/.." && pwd)"
  pi_root="$prefix/lib/node_modules/@earendil-works/pi-coding-agent"
fi
conversion="${PI_CODEX_CONVERSION_PACKAGE:-$HOME/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion}"
peer_dir="$conversion/node_modules/@earendil-works"
created_links=""

cleanup() {
  for link in $created_links; do
    rm -f "$link"
  done
  rmdir "$peer_dir" "$conversion/node_modules" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

mkdir -p "$peer_dir"
for package in pi-ai pi-agent-core pi-tui; do
  link="$peer_dir/$package"
  if [ ! -e "$link" ]; then
    ln -s "$pi_root/node_modules/@earendil-works/$package" "$link"
    created_links="$created_links $link"
  fi
done
link="$peer_dir/pi-coding-agent"
if [ ! -e "$link" ]; then
  ln -s "$pi_root" "$link"
  created_links="$created_links $link"
fi

PI_CODING_AGENT_PACKAGE="$pi_root" \
PI_CODEX_CONVERSION_PACKAGE="$conversion" \
node --test "$(dirname "$0")/../tests/compaction-hardening.test.mjs"
