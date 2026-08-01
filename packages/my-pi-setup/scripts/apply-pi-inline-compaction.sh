#!/bin/sh
set -eu
if [ -n "${PI_CODING_AGENT_PACKAGE:-}" ]; then
  root="$PI_CODING_AGENT_PACKAGE"
else
  pi_bin="$(command -v pi)"
  prefix="$(CDPATH= cd -- "$(dirname "$pi_bin")/.." && pwd)"
  root="$prefix/lib/node_modules/@earendil-works/pi-coding-agent"
fi
patches="$(CDPATH= cd -- "$(dirname "$0")/../patches" && pwd)"
agent_session="$root/dist/core/agent-session.js"
agent_core="$root/node_modules/@earendil-works/pi-agent-core"
conversion="${PI_CODEX_CONVERSION_PACKAGE:-$HOME/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion}"

if grep -q '_compactBetweenAgentTurns' "$agent_session"; then
  echo "Pi inline compaction patch already applied"
else
  patch -d "$root" -p1 < "$patches/pi-0.83-inline-compaction.patch"
  echo "Applied Pi inline compaction patch"
fi

if grep -q 'ULTRACODE_THINKING_LEVEL' "$agent_session" &&
   grep -q '"ultracode"' "$root/dist/cli/args.js"; then
  echo "Pi ultracode patch already applied"
else
  patch -d "$root" -p1 < "$patches/pi-0.83-ultracode.patch"
  echo "Applied Pi ultracode patch"
fi

if grep -q '_compactionInProgress' "$agent_session" &&
   grep -q 'branchDigest' "$agent_session" &&
   grep -q 'Compaction context changed while the compaction request was running' "$agent_session" &&
   grep -q 'Invalid checkpoints are ignored completely' "$root/dist/core/compaction/compaction.js" &&
   grep -q 'Payload rewriters own provider-request correctness' "$root/dist/core/extensions/runner.js"; then
  echo "Pi compaction hardening patch already applied"
else
  patch -d "$root" -p1 < "$patches/pi-0.83-compaction-hardening.patch"
  echo "Applied Pi compaction hardening patch"
fi

if grep -q 'ultracode' "$agent_core/dist/types.d.ts" &&
   grep -q 'toProviderThinkingLevel' "$agent_core/dist/agent.js" &&
   grep -q 'toProviderThinkingLevel' "$agent_core/dist/agent-loop.js" &&
   grep -q 'toProviderThinkingLevel' "$agent_core/dist/harness/compaction/compaction.js"; then
  echo "Pi agent-core ultracode patch already applied"
else
  patch -d "$agent_core" -p1 < "$patches/pi-agent-core-0.83-ultracode.patch"
  echo "Applied Pi agent-core ultracode patch"
fi

if [ -d "$conversion" ]; then
  if grep -q 'level === "ultracode"' "$conversion/dist/extension/runtime.js" &&
     grep -q 'selectedLevel === "ultracode"' "$conversion/dist/adapter/compaction/compaction.js"; then
    echo "Pi Codex conversion ultracode patch already applied"
  else
    patch -d "$conversion" -p1 < "$patches/pi-codex-conversion-3.0.5-ultracode.patch"
    echo "Applied Pi Codex conversion ultracode patch"
  fi

  if grep -q 'readableFallback' "$conversion/dist/adapter/compaction/compaction.js" &&
     grep -q 'one canonical compaction output item and no additional output' "$conversion/dist/adapter/compaction/remote-v2-client.js" &&
     grep -q 'withRemoteCompactionV2ForBody' "$conversion/dist/providers/openai-codex-custom-provider.js" &&
     grep -q 'never result.stdout/result.stderr' "$conversion/dist/tools/code-mode/custom-tool-prompt.js" &&
     ! grep -q 'buildLenientNativeReplayPayload' "$conversion/dist/adapter/replay/native-replay-matching.js" &&
     ! grep -q 'buildLenientNativeReplayPayload' "$conversion/dist/adapter/replay/native-replay-segments.js"; then
    echo "Pi Codex conversion compaction hardening patch already applied"
  else
    patch -d "$conversion" -p1 < "$patches/pi-codex-conversion-3.0.5-compaction-hardening.patch"
    echo "Applied Pi Codex conversion compaction hardening patch"
  fi
fi

node --check "$agent_session"
node --check "$root/dist/core/session-manager.js"
node --check "$root/dist/core/compaction/compaction.js"
node --check "$root/dist/core/extensions/runner.js"
node --check "$agent_core/dist/agent.js"
node --check "$agent_core/dist/agent-loop.js"
node --check "$agent_core/dist/harness/agent-harness.js"
if [ -d "$conversion" ]; then
  node --check "$conversion/dist/extension/runtime.js"
  node --check "$conversion/dist/adapter/compaction/compaction.js"
  node --check "$conversion/dist/adapter/provider-request.js"
  node --check "$conversion/dist/adapter/compaction/remote-v2-client.js"
  node --check "$conversion/dist/adapter/compaction/remote-v2-history.js"
  node --check "$conversion/dist/adapter/compaction/types.js"
  node --check "$conversion/dist/adapter/replay/native-replay-matching.js"
  node --check "$conversion/dist/adapter/replay/native-replay-segments.js"
  node --check "$conversion/dist/providers/openai-codex-custom-provider.js"
fi
