#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
repair="$root/scripts/repair-pi-codex-native.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

bin="$fixture/bin"
conversion="$fixture/conversion"
bridge="$conversion/src/tools/exec/bin/darwin-arm64/exec_bridge"
marker="$fixture/codesign-calls"
mkdir -p "$bin" "$(dirname "$bridge")"

cat > "$bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) exit 1 ;;
esac
EOF

cat > "$bin/codesign" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "--force" ]; then
  cat > "$FAKE_BRIDGE" <<'BRIDGE'
#!/bin/sh
exit 0
BRIDGE
  chmod 755 "$FAKE_BRIDGE"
  echo repair >> "$FAKE_CODESIGN_MARKER"
fi
exit 0
EOF

cat > "$bridge" <<'EOF'
#!/bin/sh
exit 9
EOF
chmod 755 "$bin/uname" "$bin/codesign" "$bridge"

output="$({
  PATH="$bin:$PATH" \
  PI_CODEX_CONVERSION_PACKAGE="$conversion" \
  FAKE_BRIDGE="$bridge" \
  FAKE_CODESIGN_MARKER="$marker" \
    "$repair"
} 2>&1)"
printf '%s\n' "$output" | grep -q 'Re-signed Pi Codex exec bridge'
test "$(wc -l < "$marker" | tr -d ' ')" = 1

output="$({
  PATH="$bin:$PATH" \
  PI_CODEX_CONVERSION_PACKAGE="$conversion" \
  FAKE_BRIDGE="$bridge" \
  FAKE_CODESIGN_MARKER="$marker" \
    "$repair"
} 2>&1)"
printf '%s\n' "$output" | grep -q 'Pi Codex exec bridge passed launch check'
test "$(wc -l < "$marker" | tr -d ' ')" = 1

echo "Pi Codex native repair tests passed"
