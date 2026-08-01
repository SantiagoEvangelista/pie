# Local Pi patches

`pi-0.83-inline-compaction.patch` runs auto-compaction from agent-core's
`prepareNextTurn` boundary. It replaces active history and continues the same
agent turn, matching Codex inline compaction instead of aborting and injecting a
synthetic user continuation.

`pi-0.83-ultracode.patch` adds the selectable virtual `ultracode` harness
level, UI/docs, session persistence, and local-compaction normalization.

`pi-0.83-compaction-hardening.patch` makes compaction single-owner and
snapshot-validated across branch content, model, and effort; pins credentials
to that model; persists exact checkpoint identity; preserves composed next-turn
hooks; makes authentication-time auto-compaction cancellable; rebuilds from
readable history after corrupt boundaries (including a corrupt leaf); and fails
closed when a provider-payload rewrite throws.

`pi-agent-core-0.83-ultracode.patch` adds one shared normalization helper and
maps that virtual level to provider `xhigh` at every agent-loop and harness
compaction boundary while preserving `ultracode` in session state for
extensions.

`pi-codex-conversion-3.0.5-ultracode.patch` normalizes direct Codex WebSocket
prewarm and native compaction requests to `xhigh` too.

`pi-codex-conversion-3.0.5-compaction-hardening.patch` builds endpoint input
from Pi's immutable compaction snapshot, validates opaque output/window shape,
uses strict latest-checkpoint replay without lenient projection variants, keeps
a durable native marker plus readable previous summary, advertises the native
feature whenever the final request body needs it, and blocks requests that
cannot safely restore encrypted context. Opaque checkpoints remain reusable
across supported model switches on the same provider/API/endpoint.

Focused regression suite:

```sh
~/.pi/agent/packages/my-pi-setup/scripts/test-compaction-hardening.sh
```

Pi updates overwrite the global runtime file. Reapply with:

```sh
~/.pi/agent/packages/my-pi-setup/scripts/apply-pi-inline-compaction.sh
```

Patches are intentionally version-scoped to Pi 0.83.0 and fail on incompatible
future source instead of forcing a fuzzy edit.
