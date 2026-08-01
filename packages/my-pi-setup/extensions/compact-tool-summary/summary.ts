export interface ToolActivity {
  toolName: string;
  label: string;
  count: number;
}

export interface ToolActivitySummary {
  version?: 2;
  items: ToolActivity[];
  failed: number;
  toolCallIds: string[];
}

const MUTATION_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
]);

const FULL_OUTPUT_TOOLS = new Set([
  "workflow",
]);

const SHELL_TOOLS = new Set([
  "bash",
  "exec_command",
  "shell",
]);

export interface ClassifiedToolActivity {
  toolName: string;
  count: number;
}

function classifyShellSegment(segment: string): string | undefined {
  const cmd = segment.trim().replace(/^\(+\s*/, "");
  if (/^(?:command\s+)?ls(?:\s|$)/.test(cmd)) return "ls";
  if (/^(?:command\s+)?(?:find|fd)(?:\s|$)/.test(cmd)) return "find";
  if (/^(?:command\s+)?rg(?:\s|$)/.test(cmd)) {
    return /(?:^|\s)--files(?:\s|$)/.test(cmd) ? "find" : "grep";
  }
  if (/^(?:command\s+)?grep(?:\s|$)/.test(cmd)) return "grep";
  if (/^(?:command\s+)?(?:cat|head|tail)(?:\s|$)/.test(cmd)) return "read";
  if (/^(?:command\s+)?sed\s+-n(?:\s|$)/.test(cmd)) return "read";

  return undefined;
}

function isShellHousekeeping(segment: string): boolean {
  return /^(?:cd\b|echo\b|printf\b|true\b|:($|\s))/.test(segment.trim());
}

export function classifyToolActivities(
  toolName: string,
  input: unknown,
): ClassifiedToolActivity[] {
  if (!SHELL_TOOLS.has(toolName.toLowerCase())) return [{ toolName, count: 1 }];
  if (!input || typeof input !== "object" || !("cmd" in input)) {
    return [{ toolName, count: 1 }];
  }
  const cmd = typeof input.cmd === "string" ? input.cmd.trim() : "";
  if (!cmd) return [{ toolName, count: 1 }];

  const classified: ClassifiedToolActivity[] = [];
  for (const segment of cmd.split(/(?:&&|;|\n)+/)) {
    if (!segment.trim() || isShellHousekeeping(segment)) continue;
    const classifiedName = classifyShellSegment(segment);
    if (!classifiedName) return [{ toolName, count: 1 }];
    const existing = classified.find((item) => item.toolName === classifiedName);
    if (existing) existing.count += 1;
    else classified.push({ toolName: classifiedName, count: 1 });
  }

  return classified.length > 0 ? classified : [{ toolName, count: 1 }];
}

export function classifyToolName(toolName: string, input: unknown): string {
  return classifyToolActivities(toolName, input)[0]?.toolName ?? toolName;
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().split(/[.:/]/).pop() ?? "";
}

export function isFileMutationTool(toolName: string): boolean {
  return MUTATION_TOOLS.has(normalizedToolName(toolName));
}

/** Tools whose native TUI output is useful enough to keep in full. */
export function isFullOutputTool(toolName: string): boolean {
  const normalized = normalizedToolName(toolName);
  return MUTATION_TOOLS.has(normalized) || FULL_OUTPUT_TOOLS.has(normalized);
}

export function shouldSummarizeTool(toolName: string): boolean {
  return !isFullOutputTool(toolName);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/^mcp[_:-]?/i, "")
    .split(/[_:\-.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function displayName(item: ToolActivity): string {
  const label = item.label.trim();
  if (label && label.toLowerCase() !== item.toolName.toLowerCase()) {
    return label;
  }
  return humanizeToolName(item.toolName) || "Tool";
}

export function formatActivity(item: ToolActivity): string {
  const toolName = item.toolName.toLowerCase();
  const count = item.count;

  if (toolName === "read") return `Read ${plural(count, "file")}`;
  if (SHELL_TOOLS.has(toolName)) return `Ran ${plural(count, "shell command")}`;
  if (toolName === "exec") return `Ran ${plural(count, "code block")}`;
  if (toolName === "wait") return `Waited for ${plural(count, "code block")}`;
  if (toolName === "write_stdin") return `Continued ${plural(count, "shell command")}`;
  if (toolName === "grep") return `Searched for ${plural(count, "pattern")}`;
  if (toolName === "find") return count === 1 ? "Searched for files" : `Searched for files ${count} times`;
  if (toolName === "ls") return `Listed ${plural(count, "directory", "directories")}`;
  if (toolName === "web_search") return count === 1 ? "Searched web" : `Searched web ${count} times`;
  if (toolName === "fetch_content") return `Fetched ${plural(count, "source")}`;
  if (toolName === "get_search_content") return `Read ${plural(count, "stored result")}`;
  if (toolName === "ask_user") return `Asked ${plural(count, "question")}`;
  if (toolName === "view_image") return `Viewed ${plural(count, "image")}`;

  const name = displayName(item);
  return count === 1 ? `Called ${name}` : `Called ${name} ${count} times`;
}

export function formatToolSummary(summary: Pick<ToolActivitySummary, "items" | "failed">): string {
  const actions = summary.items
    .filter((item) => item.count > 0)
    .map(formatActivity);

  if (summary.failed > 0) {
    actions.push(`${plural(summary.failed, "call")} failed`);
  }

  return actions
    .map((action, index) => index === 0 ? action : action.charAt(0).toLowerCase() + action.slice(1))
    .join(", ");
}
