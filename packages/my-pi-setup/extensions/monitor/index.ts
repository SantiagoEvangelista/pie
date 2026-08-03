/** Claude Code-style session monitors for command output and WebSocket events. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MonitorManager,
  type MonitorEvent,
  type MonitorSnapshot,
  type MonitorSourceInput,
} from "./src/manager.ts";
import {
  MONITOR_LIST_TOOL_DESCRIPTION,
  MONITOR_PARAMETER_DESCRIPTIONS,
  MONITOR_PROMPT_GUIDELINES,
  MONITOR_PROMPT_SNIPPET,
  MONITOR_STOP_PARAMETER_DESCRIPTIONS,
  MONITOR_STOP_TOOL_DESCRIPTION,
  MONITOR_TOOL_DESCRIPTION,
  buildEventMessage,
  buildListResult,
  buildSettledMessage,
  buildStartResult,
  buildStopResult,
} from "./prompt.ts";

const DESCRIPTION_MAX_LENGTH = 200;
const COMMAND_MAX_LENGTH = 32_768;
const URL_MAX_LENGTH = 2_048;
const MAX_PROTOCOLS = 16;

const WebSocketSourceSchema = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: URL_MAX_LENGTH,
      description: MONITOR_PARAMETER_DESCRIPTIONS.wsUrl,
    }),
    protocols: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: MAX_PROTOCOLS,
        description: MONITOR_PARAMETER_DESCRIPTIONS.wsProtocols,
      }),
    ),
  },
  { additionalProperties: false },
);

function cleanDescription(description: string): string {
  return description
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateWebSocketSource(
  input: { url: string; protocols?: string[] },
): Extract<MonitorSourceInput, { kind: "websocket" }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error(`Invalid WebSocket URL: ${input.url}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("WebSocket URL must use ws:// or wss://.");
  }

  const protocols = input.protocols?.map((protocol) => protocol.trim());
  if (protocols?.some((protocol) => !protocol)) {
    throw new Error("WebSocket protocols must not be blank.");
  }
  if (protocols && new Set(protocols).size !== protocols.length) {
    throw new Error("WebSocket protocols must be unique.");
  }
  return {
    kind: "websocket",
    url: url.toString(),
    ...(protocols && protocols.length > 0 ? { protocols } : {}),
  };
}

export default function monitorExtension(pi: ExtensionAPI) {
  let manager: MonitorManager | undefined;
  let shuttingDown = false;
  const consumedSettlements = new Set<string>();

  const sendMonitorMessage = (
    customType: "monitor-event" | "monitor-settled",
    content: string,
    snapshot: MonitorSnapshot,
    sequence?: number,
  ) => {
    if (shuttingDown) return;
    try {
      pi.sendMessage(
        {
          customType,
          content,
          display: true,
          details: {
            monitorId: snapshot.id,
            description: snapshot.description,
            status: snapshot.status,
            eventCount: snapshot.eventCount,
            ...(sequence === undefined ? {} : { sequence }),
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      console.error("monitor: failed to deliver event", error);
    }
  };

  const getManager = () => {
    if (shuttingDown) throw new Error("Monitor session is shutting down.");
    manager ??= new MonitorManager({
      onEvent(event: MonitorEvent, snapshot: MonitorSnapshot) {
        sendMonitorMessage(
          "monitor-event",
          buildEventMessage({
            id: snapshot.id,
            description: snapshot.description,
            status: snapshot.status,
            sequence: event.sequence,
            payload: event.text,
          }),
          snapshot,
          event.sequence,
        );
      },
      onSettled(snapshot: MonitorSnapshot) {
        if (consumedSettlements.delete(snapshot.id)) return;
        sendMonitorMessage(
          "monitor-settled",
          buildSettledMessage(snapshot),
          snapshot,
        );
      },
    });
    return manager;
  };

  pi.on("session_start", () => {
    shuttingDown = false;
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    consumedSettlements.clear();
    const closing = manager;
    manager = undefined;
    await closing?.dispose();
  });

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description: MONITOR_TOOL_DESCRIPTION,
    promptSnippet: MONITOR_PROMPT_SNIPPET,
    promptGuidelines: MONITOR_PROMPT_GUIDELINES,
    parameters: Type.Object(
      {
        command: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: COMMAND_MAX_LENGTH,
            description: MONITOR_PARAMETER_DESCRIPTIONS.command,
          }),
        ),
        ws: Type.Optional(WebSocketSourceSchema),
        description: Type.String({
          minLength: 1,
          maxLength: DESCRIPTION_MAX_LENGTH,
          description: MONITOR_PARAMETER_DESCRIPTIONS.description,
        }),
        timeout_ms: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
            description: MONITOR_PARAMETER_DESCRIPTIONS.timeoutMs,
          }),
        ),
        persistent: Type.Optional(
          Type.Boolean({
            description: MONITOR_PARAMETER_DESCRIPTIONS.persistent,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const hasCommand = params.command !== undefined;
      const hasWebSocket = params.ws !== undefined;
      if (hasCommand === hasWebSocket) {
        throw new Error("Provide exactly one of command or ws.");
      }

      const command = params.command?.trim();
      if (hasCommand && !command) {
        throw new Error("command must not be blank.");
      }

      const description = cleanDescription(params.description);
      if (!description) throw new Error("description must not be blank.");
      const persistent = params.persistent ?? false;
      if (persistent && params.timeout_ms !== undefined) {
        throw new Error(
          "Persistent monitors run for the session lifetime; omit timeout_ms.",
        );
      }

      const source: MonitorSourceInput = hasCommand
        ? { kind: "command", command: command!, cwd: ctx.cwd }
        : validateWebSocketSource(params.ws!);
      const snapshot = getManager().start({
        description,
        source,
        persistent,
        timeoutMs: persistent ? 0 : (params.timeout_ms ?? DEFAULT_TIMEOUT_MS),
      });
      return {
        content: [{ type: "text", text: buildStartResult(snapshot) }],
        details: {
          id: snapshot.id,
          description: snapshot.description,
          sourceKind: snapshot.sourceKind,
          persistent: snapshot.persistent,
          timeoutMs: snapshot.timeoutMs,
        },
      };
    },
  });

  pi.registerTool({
    name: "monitor_stop",
    label: "Stop Monitor",
    description: MONITOR_STOP_TOOL_DESCRIPTION,
    parameters: Type.Object(
      {
        id: Type.String({
          minLength: 1,
          description: MONITOR_STOP_PARAMETER_DESCRIPTIONS.id,
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      if (!manager?.get(params.id)) {
        const known = manager?.list().map((snapshot) => snapshot.id) ?? [];
        throw new Error(
          `Unknown monitor "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }
      consumedSettlements.add(params.id);
      const snapshot = await manager.stop(params.id);
      consumedSettlements.delete(params.id);
      return {
        content: [{ type: "text", text: buildStopResult(snapshot) }],
        details: {
          id: snapshot.id,
          status: snapshot.status,
          eventCount: snapshot.eventCount,
        },
      };
    },
  });

  pi.registerTool({
    name: "monitor_list",
    label: "List Monitors",
    description: MONITOR_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const monitors = manager?.list() ?? [];
      return {
        content: [{ type: "text", text: buildListResult(monitors) }],
        details: {
          monitors: monitors.map((snapshot) => ({
            id: snapshot.id,
            description: snapshot.description,
            sourceKind: snapshot.sourceKind,
            status: snapshot.status,
            eventCount: snapshot.eventCount,
            persistent: snapshot.persistent,
          })),
        },
      };
    },
  });
}
