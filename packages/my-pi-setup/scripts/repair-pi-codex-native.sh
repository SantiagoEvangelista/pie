#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

case "$(uname -m)" in
  arm64) platform="darwin-arm64" ;;
  x86_64) platform="darwin-x64" ;;
  *) exit 0 ;;
esac

conversion="${PI_CODEX_CONVERSION_PACKAGE:-$HOME/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion}"
bridge="$conversion/src/tools/exec/bin/$platform/exec_bridge"

if [ ! -x "$bridge" ]; then
  exit 0
fi

if ("$bridge" </dev/null >/dev/null 2>&1) 2>/dev/null; then
  echo "Pi Codex exec bridge passed launch check"
  exit 0
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "Pi Codex exec bridge failed launch check and codesign is unavailable" >&2
  exit 1
fi

codesign --force --sign - --timestamp=none "$bridge"
codesign --verify --deep --strict "$bridge"

if ! ("$bridge" </dev/null >/dev/null 2>&1) 2>/dev/null; then
  echo "Pi Codex exec bridge still fails after local signing" >&2
  exit 1
fi

echo "Re-signed Pi Codex exec bridge after failed launch check"
