/** All model-facing strings for the subagents tools. */

import { DELEGATED_MODEL_TIERING_GUIDELINES } from "../../shared/intelligence-tiering.ts";

/** Describes subagent_spawn and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background pi subagent for one atomic purpose: a fully autonomous, headless, in-process pi session with its own context window and this environment's tools and config. Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Split compound work into additional calls or later batches. Only use trusted working directories. Max 4 subagents can run at once.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background pi subagent with its own context and normal tools for one self-contained atomic task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate one atomic, self-contained purpose that can run in the background; give it a complete standalone prompt and split compound work into more calls or later batches.",
  "All subagents use the in-process pi harness; Claude Code and Codex CLI harnesses are disabled.",
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
  "Use subagent_send only for material new context or a course correction after spawning; it queues guidance into a running child or resumes a settled child with the same context. Do not use it for status polling or to compensate for an incomplete initial prompt.",
  ...DELEGATED_MODEL_TIERING_GUIDELINES,
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Atomic task prompt for the subagent. Must be self-contained and limited to one purpose: include exact inputs, owned file/question/change, concrete deliverable, acceptance criteria, explicit stop condition, and out-of-scope work. Split compound work into more subagents.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Pi model hint as "provider/model-id" or a model id. Omitted defaults to openai-codex/gpt-5.6-sol. Use the same Sol model for worker and advanced tasks; reasoning_effort selects the tier.',
  reasoningEffort:
    'Pi thinking level. Omitted Sol children default to medium; use high for advanced work. Sol children accept only "medium" or "high"; ultracode remains parent-only.',
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_send to provide new guidance, subagent_wait(ids: ["${options.id}"]) to block for it, ` +
    `subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes steering a running subagent or continuing a settled one. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send new guidance to a subagent without waiting for it. During an active run, the message is queued as a course correction after the current assistant turn finishes its tool calls. A settled subagent resumes in the background under the same id with its conversation history preserved. Use this for material new context, not status polling.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: 'Subagent id, e.g. "sa-1"',
  message: "Non-empty additional instruction or context for the subagent",
};

export function buildSubagentSendResult(options: {
  id: string;
  title: string;
}) {
  return `Sent guidance to subagent ${options.id} "${options.title}". It continues in the background.`;
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
