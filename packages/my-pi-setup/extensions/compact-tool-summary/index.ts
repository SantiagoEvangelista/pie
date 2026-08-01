import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  classifyToolActivities,
  formatToolSummary,
  isFullOutputTool,
  shouldSummarizeTool,
  type ToolActivity,
  type ToolActivitySummary,
} from "./summary.ts";
import { createPatchLifecycle } from "./tool-component-lifecycle.ts";

const ENTRY_TYPE = "compact-tool-summary";
const WIDGET_ID = "compact-tool-activity";
const INTERCEPTOR_KEY = Symbol.for("my-pi-setup.compact-tool-summary.interceptor.v1");
const TOOL_COMPONENT_PATCH_KEY = Symbol.for("my-pi-setup.compact-tool-summary.tool-component-patch.v1");

interface RuntimeToolDefinition {
  name?: string;
  label?: string;
  renderCall?: unknown;
  renderResult?: unknown;
  renderShell?: unknown;
  [key: string]: unknown;
}

interface RegisterToolInterception {
  original: ExtensionAPI["registerTool"];
  wrapped: ExtensionAPI["registerTool"];
}

type InterceptablePi = ExtensionAPI & {
  [INTERCEPTOR_KEY]?: RegisterToolInterception;
};

interface ToolExecutionInstance {
  toolName?: string;
  args?: unknown;
  result?: ToolResult & { isError?: boolean };
}

interface ToolExecutionPrototype {
  render(this: ToolExecutionInstance, width: number): string[];
  updateDisplay(this: ToolExecutionInstance): void;
  [TOOL_COMPONENT_PATCH_KEY]?: {
    originalRender?: ToolExecutionPrototype["render"];
    patchedRender?: ToolExecutionPrototype["render"];
    originalUpdateDisplay?: ToolExecutionPrototype["updateDisplay"];
    patchedUpdateDisplay?: ToolExecutionPrototype["updateDisplay"];
    original?: ToolExecutionPrototype["render"];
    patched?: ToolExecutionPrototype["render"];
  };
}

interface ToolTrace {
  id: string;
  name: string;
  input?: unknown;
  status?: string;
}

interface ToolResult {
  content: unknown[];
  details?: unknown;
}

interface CallContribution {
  items: ToolActivity[];
  failed: number;
  nestedTraceIds: string[];
}

function emptyComponent(): Container {
  return new Container();
}

function compactRenderer(tool: RuntimeToolDefinition): void {
  const toolName = tool.name?.trim();
  if (!toolName || !shouldSummarizeTool(toolName)) return;

  // Self-rendering lets Pi remove rows whose call and result renderers are empty.
  // Tool result content remains untouched in session/LLM context.
  tool.renderShell = "self";
  tool.renderCall = emptyComponent;
  tool.renderResult = emptyComponent;
}

function toolExecutionModulePath(): string | undefined {
  const relativePath = join("modes", "interactive", "components", "tool-execution.js");
  const candidateFrom = (entryPath: string): string | undefined => {
    try {
      const candidate = join(dirname(realpathSync(entryPath)), relativePath);
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  };

  const argvCandidate = process.argv[1] ? candidateFrom(process.argv[1]) : undefined;
  if (argvCandidate) return argvCandidate;

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const executable = join(directory, process.platform === "win32" ? "pi.cmd" : "pi");
    const candidate = candidateFrom(executable);
    if (candidate) return candidate;
  }

  return undefined;
}

function codeModeTraces(result: ToolResult | undefined): ToolTrace[] {
  const details = result?.details;
  if (!details || typeof details !== "object" || !("traces" in details)) return [];
  if (!Array.isArray(details.traces)) return [];
  return details.traces.filter((trace): trace is ToolTrace =>
    !!trace &&
    typeof trace === "object" &&
    "id" in trace &&
    typeof trace.id === "string" &&
    "name" in trace &&
    typeof trace.name === "string"
  );
}

function hasFullOutputTrace(result: ToolResult | undefined): boolean {
  return codeModeTraces(result).some((trace) => isFullOutputTool(trace.name));
}

function fullOutputOnlyResult(result: ToolResult): ToolResult {
  const details = result.details && typeof result.details === "object"
    ? result.details
    : {};
  return {
    content: [{ type: "text", text: "Script completed" }],
    details: {
      ...details,
      traces: codeModeTraces(result).filter((trace) => isFullOutputTool(trace.name)),
      droppedTraceCount: 0,
      scriptError: undefined,
    },
  };
}

async function patchToolExecutionComponent(): Promise<(() => void) | undefined> {
  const modulePath = toolExecutionModulePath();
  if (!modulePath) return undefined;

  const module = await import(pathToFileURL(modulePath).href) as {
    ToolExecutionComponent?: { prototype: ToolExecutionPrototype };
  };
  const prototype = module.ToolExecutionComponent?.prototype;
  if (!prototype) return undefined;

  const stale = prototype[TOOL_COMPONENT_PATCH_KEY];
  if (stale?.patchedRender && prototype.render === stale.patchedRender) {
    prototype.render = stale.originalRender!;
    prototype.updateDisplay = stale.originalUpdateDisplay!;
    delete prototype[TOOL_COMPONENT_PATCH_KEY];
  } else if (stale?.patched && prototype.render === stale.patched) {
    prototype.render = stale.original!;
    delete prototype[TOOL_COMPONENT_PATCH_KEY];
  }

  const originalRender = prototype.render;
  const originalUpdateDisplay = prototype.updateDisplay;
  const patchedRender = function renderCompactToolRow(
    this: ToolExecutionInstance,
    width: number,
  ): string[] {
    if (!this.toolName) return [];
    if (isFullOutputTool(this.toolName) || hasFullOutputTrace(this.result)) {
      return originalRender.call(this, width);
    }
    return [];
  };
  const patchedUpdateDisplay = function updateCompactToolRow(
    this: ToolExecutionInstance,
  ): void {
    const originalResult = this.result;
    if (!originalResult || !hasFullOutputTrace(originalResult)) {
      originalUpdateDisplay.call(this);
      return;
    }

    this.result = {
      ...fullOutputOnlyResult(originalResult),
      isError: originalResult.isError,
    };
    try {
      originalUpdateDisplay.call(this);
    } finally {
      this.result = originalResult;
    }
  };

  prototype.render = patchedRender;
  prototype.updateDisplay = patchedUpdateDisplay;
  prototype[TOOL_COMPONENT_PATCH_KEY] = {
    originalRender,
    patchedRender,
    originalUpdateDisplay,
    patchedUpdateDisplay,
  };

  return () => {
    if (prototype.render === patchedRender) prototype.render = originalRender;
    if (prototype.updateDisplay === patchedUpdateDisplay) {
      prototype.updateDisplay = originalUpdateDisplay;
    }
    if (prototype[TOOL_COMPONENT_PATCH_KEY]?.patchedRender === patchedRender) {
      delete prototype[TOOL_COMPONENT_PATCH_KEY];
    }
  };
}

function validSummary(value: unknown): value is ToolActivitySummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<ToolActivitySummary>;
  return summary.version === 2 &&
    Array.isArray(summary.items) &&
    summary.items.every((item) =>
      !!item &&
      typeof item.toolName === "string" &&
      typeof item.label === "string" &&
      typeof item.count === "number"
    ) &&
    typeof summary.failed === "number" &&
    Array.isArray(summary.toolCallIds);
}

export default async function compactToolSummary(pi: ExtensionAPI): Promise<void> {
  const toolComponentPatch = createPatchLifecycle(patchToolExecutionComponent);
  const toolLabels = new Map<string, string>();
  const interceptablePi = pi as InterceptablePi;
  const stale = interceptablePi[INTERCEPTOR_KEY];
  if (stale && pi.registerTool === stale.wrapped) {
    pi.registerTool = stale.original;
    delete interceptablePi[INTERCEPTOR_KEY];
  }

  const originalRegisterTool = pi.registerTool;
  const wrappedRegisterTool = function registerCompactTool(
    this: ExtensionAPI,
    definition: ToolDefinition,
  ): void {
    const runtimeDefinition = definition as RuntimeToolDefinition;
    const toolName = runtimeDefinition.name?.trim();
    if (toolName) {
      toolLabels.set(toolName, runtimeDefinition.label?.trim() || toolName);
    }
    compactRenderer(runtimeDefinition);
    originalRegisterTool.call(this, definition);
  } as ExtensionAPI["registerTool"];

  pi.registerTool = wrappedRegisterTool;
  interceptablePi[INTERCEPTOR_KEY] = {
    original: originalRegisterTool,
    wrapped: wrappedRegisterTool,
  };

  let active: ToolActivitySummary = { items: [], failed: 0, toolCallIds: [] };
  const contributions = new Map<string, CallContribution>();
  const seenNestedTraceIds = new Set<string>();

  const clearLiveWidget = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  };

  const resetActivity = (): void => {
    active = { items: [], failed: 0, toolCallIds: [] };
    contributions.clear();
  };

  const activitiesFor = (toolName: string, input?: unknown): ToolActivity[] => {
    return classifyToolActivities(toolName, input)
      .filter((activity) => shouldSummarizeTool(activity.toolName))
      .map((activity) => ({
        ...activity,
        label: activity.toolName === toolName
          ? toolLabels.get(toolName) ?? toolName
          : activity.toolName,
      }));
  };

  const rebuildActivity = (): void => {
    const items: ToolActivity[] = [];
    let failed = 0;
    for (const contribution of contributions.values()) {
      failed += contribution.failed;
      for (const incoming of contribution.items) {
        const existing = items.find((item) => item.toolName === incoming.toolName);
        if (existing) existing.count += incoming.count;
        else items.push({ ...incoming });
      }
    }
    active = {
      items,
      failed,
      toolCallIds: [...contributions.keys()],
    };
  };

  const contributionFromTraces = (
    traces: ToolTrace[],
    outerFailed = false,
  ): CallContribution => {
    const items: ToolActivity[] = [];
    let failed = 0;
    const nestedTraceIds: string[] = [];
    for (const trace of traces) {
      if (seenNestedTraceIds.has(trace.id)) continue;
      nestedTraceIds.push(trace.id);
      if (trace.status === "error") failed += 1;
      for (const activity of activitiesFor(trace.name, trace.input)) {
        const existing = items.find((item) => item.toolName === activity.toolName);
        if (existing) existing.count += activity.count;
        else items.push(activity);
      }
    }
    if (outerFailed && failed === 0) failed = 1;
    return { items, failed, nestedTraceIds };
  };

  const estimatedExecContribution = (args: unknown): CallContribution => {
    const code = args && typeof args === "object" && "code" in args && typeof args.code === "string"
      ? args.code
      : "";
    const traces = [...code.matchAll(/\btools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
      .map((match, index) => ({
        id: `estimated-${index}`,
        name: match[1] ?? "exec",
      }));
    if (traces.length > 0) return contributionFromTraces(traces);
    const activities = activitiesFor("exec");
    return {
      items: activities,
      failed: 0,
      nestedTraceIds: [],
    };
  };

  const updateLiveWidget = (ctx: Pick<ExtensionContext, "mode" | "ui">): void => {
    if (ctx.mode !== "tui") return;
    const text = formatToolSummary(active);
    ctx.ui.setWidget(
      WIDGET_ID,
      text ? [ctx.ui.theme.fg("muted", text)] : undefined,
    );
  };

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    if (!validSummary(entry.data)) return undefined;
    const text = formatToolSummary(entry.data);
    return text ? new Text(theme.fg("muted", text), 2, 0) : undefined;
  });

  pi.on("agent_start", async (_event, ctx) => {
    resetActivity();
    seenNestedTraceIds.clear();
    clearLiveWidget(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    await toolComponentPatch.start(ctx.mode);
  });

  pi.on("turn_start", async (_event, ctx) => {
    resetActivity();
    clearLiveWidget(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!shouldSummarizeTool(event.toolName) || contributions.has(event.toolCallId)) return;

    if (event.toolName === "exec") {
      contributions.set(event.toolCallId, estimatedExecContribution(event.args));
    } else {
      contributions.set(event.toolCallId, {
        items: activitiesFor(event.toolName, event.args),
        failed: 0,
        nestedTraceIds: [],
      });
    }

    rebuildActivity();
    updateLiveWidget(ctx);
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    if (event.toolName !== "exec" && event.toolName !== "wait") return;
    const traces = codeModeTraces(event.partialResult as ToolResult);
    if (traces.length === 0) return;
    contributions.set(event.toolCallId, contributionFromTraces(traces));
    rebuildActivity();
    updateLiveWidget(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!contributions.has(event.toolCallId)) return;
    if (event.toolName === "exec" || event.toolName === "wait") {
      const traces = codeModeTraces(event.result as ToolResult);
      if (traces.length > 0) {
        contributions.set(
          event.toolCallId,
          contributionFromTraces(traces, event.isError),
        );
      } else if (event.isError) {
        const contribution = contributions.get(event.toolCallId)!;
        contributions.set(event.toolCallId, { ...contribution, failed: 1 });
      }
    } else if (event.isError) {
      const contribution = contributions.get(event.toolCallId)!;
      contributions.set(event.toolCallId, { ...contribution, failed: 1 });
    }
    rebuildActivity();
    updateLiveWidget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    clearLiveWidget(ctx);
    if (active.items.length === 0 && active.failed === 0) return;

    pi.appendEntry(ENTRY_TYPE, {
      version: 2,
      items: active.items.map((item) => ({ ...item })),
      failed: active.failed,
      toolCallIds: [...active.toolCallIds],
    } satisfies ToolActivitySummary);

    for (const contribution of contributions.values()) {
      for (const traceId of contribution.nestedTraceIds) {
        seenNestedTraceIds.add(traceId);
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearLiveWidget(ctx);
    toolComponentPatch.stop();
    if (pi.registerTool === wrappedRegisterTool) {
      pi.registerTool = originalRegisterTool;
    }
    if (interceptablePi[INTERCEPTOR_KEY]?.wrapped === wrappedRegisterTool) {
      delete interceptablePi[INTERCEPTOR_KEY];
    }
  });
}
