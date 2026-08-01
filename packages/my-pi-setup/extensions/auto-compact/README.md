# Auto-compact bridge

Local fork of [`@capyup/pi-auto-compact` 0.2.4](./UPSTREAM.md).

Pi emits `turn_end.toolResults` and assistant content blocks named `toolCall`.
Upstream checks for Anthropic's `tool_use`, so its mid-turn compaction path never
fires on current Pi. This fork detects completed tool batches from
`turn_end.toolResults`, checks measured context after every batch, and starts
compaction before the next model request.

Additional changes:

- Guards pre-turn checks while compaction is already pending.
- Emergency checks use the larger of Pi's measured usage and raw message
  estimates.
- OpenAI Codex sessions use Responses compaction V2 through
  `pi-codex-conversion.json`.

This extension is retained as reference and regression coverage but is no longer
loaded. Pi core now compacts through its `prepareNextTurn` path, preserving the
active turn without aborting or injecting a continuation user message. Upstream
npm package remains installed but inactive.
