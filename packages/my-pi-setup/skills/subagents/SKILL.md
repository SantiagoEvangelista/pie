---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child one atomic, self-contained purpose with paths, constraints, and expected report. Split compound work into more calls or later batches.

## Pi-Only Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Only supported harness:** `pi`. Omitted child model defaults to GPT-5.6 Sol at medium effort. Claude Code and Codex CLI harnesses are disabled.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous. Common picks in this environment:

| Role                         | Model                        | Effort      |
| ---------------------------- | ---------------------------- | ----------- |
| Parent orchestrator          | `openai-codex/gpt-5.6-sol` | `ultracode` |
| Default worker               | `openai-codex/gpt-5.6-sol` | `medium`    |
| Advanced specialist/reviewer | `openai-codex/gpt-5.6-sol` | `high`      |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to provider thinking levels. Sol children use `medium` or `high`; child agents never inherit ultracode workflow-orchestration mode.

## Role Design

- Parent keeps framing, decomposition, tradeoffs, cross-agent adjudication, integration, and final synthesis.
- Sol/medium handles inspection, focused research, coding, tests/builds, routine debugging, and narrow review.
- Sol/high handles deep ambiguity, architecture, difficult root cause, domain/math, security, or deep high-stakes adversarial review.
- Parent decomposes first; each child executes one mechanical or independently verifiable purpose per call.
- Never assign a child compound inspect/design/implement/test work. Split stages into separate calls. If a prompt has multiple independent files, questions, or deliverables, split again.
- For nontrivial work, prefer 3-4 orthogonal workers followed by at least 2 independent verification/critique tasks when scope permits. Use later batches instead of broader prompts; max four concurrent.
- Every prompt names exact inputs, one owned file or tightly coupled file set, one question/change, one deliverable, acceptance criteria, explicit stop condition, and out-of-scope work. Ban open-ended discovery, adjacent exploration, generic subsystem fixes, and overlapping whole-repo scans.
- Never prohibit read-only tools when a child must inspect source, files, patches, or diffs unless complete evidence is embedded. Use “do not edit” to constrain review; never use “do not run tools” for source-dependent work.
- Parallel writers own disjoint files. One agent owns shared/integration files; parent resolves conflicts and reviews every result.

## Spawn and Manage

Call `subagent_spawn` with one complete atomic `prompt`, short `name`, and optional `working_dir`, `model`, and `reasoning_effort`. Harness is always `pi`. At most four subagents run concurrently; launch later batches for additional narrow roles.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_send({ id, message })`: queue material new guidance into a running child, or resume a settled child with the same conversation context. Do not use it for status polling.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
