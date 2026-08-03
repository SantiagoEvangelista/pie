import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MAX_ACTIVE_MONITORS = 8;
export const MAX_EVENT_BYTES = 65_536;
export const MAX_EVENTS_PER_WINDOW = 100;
export const EVENT_WINDOW_MS = 60_000;

const MAX_SETTLED_MONITORS = 64;
const MAX_DIAGNOSTIC_CHARS = 4_096;
const MAX_LAST_EVENT_CHARS = 1_024;
const FORCE_KILL_AFTER_MS = 1_500;
const SETTLEMENT_FALLBACK_MS = 500;

export type MonitorStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out";

export type MonitorSourceInput =
  | { kind: "command"; command: string; cwd: string }
  | { kind: "websocket"; url: string; protocols?: string[] };

export interface MonitorStartInput {
  description: string;
  source: MonitorSourceInput;
  persistent: boolean;
  timeoutMs: number;
}

export interface MonitorEvent {
  monitorId: string;
  sequence: number;
  text: string;
}

export interface MonitorSnapshot {
  id: string;
  description: string;
  sourceKind: MonitorSourceInput["kind"];
  sourceLabel: string;
  status: MonitorStatus;
  persistent: boolean;
  timeoutMs: number;
  startedAt: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  closeCode?: number;
  closeReason?: string;
  error?: string;
  eventCount: number;
  lastEvent?: string;
}

interface WebSocketMessageEventLike {
  data: unknown;
}

interface WebSocketCloseEventLike {
  code?: number;
  reason?: string;
}

export interface WebSocketLike {
  addEventListener(
    type: "message",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: WebSocketCloseEventLike) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketFactory {
  (url: string, protocols?: string[]): WebSocketLike;
}

export interface MonitorManagerOptions {
  onEvent(event: MonitorEvent, snapshot: MonitorSnapshot): void;
  onSettled(snapshot: MonitorSnapshot): void;
  websocketFactory?: WebSocketFactory;
  now?: () => number;
}

interface MutableSnapshot extends MonitorSnapshot {
  status: MonitorStatus;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  eventCount: number;
  lastEvent?: string;
}

interface CommandResource {
  kind: "command";
  child: ChildProcess;
  closed: boolean;
  processGroupId?: number;
}

interface WebSocketResource {
  kind: "websocket";
  socket: WebSocketLike;
  listeners: Array<{ type: string; listener: (event: any) => void }>;
}

type MonitorResource = CommandResource | WebSocketResource;

interface MonitorEntry {
  snapshot: MutableSnapshot;
  eventTimes: number[];
  settledOrder?: number;
  timeout?: NodeJS.Timeout;
  resource?: MonitorResource;
  settlement?: Promise<MonitorSnapshot>;
}

interface TerminalDetails {
  exitCode?: number;
  signal?: string;
  closeCode?: number;
  closeReason?: string;
  error?: string;
}

function defaultWebSocketFactory(
  url: string,
  protocols?: string[],
): WebSocketLike {
  const WebSocketConstructor = (
    globalThis as typeof globalThis & {
      WebSocket?: new (url: string, protocols?: string[]) => WebSocketLike;
    }
  ).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("Global WebSocket is unavailable.");
  }
  return new WebSocketConstructor(url, protocols);
}

function shellInvocation(command: string): {
  executable: string;
  arguments: string[];
} {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      arguments: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", arguments: ["-c", command] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendTail(current: string, text: string): string {
  return (current + text).slice(-MAX_DIAGNOSTIC_CHARS);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function binaryFrameSize(data: unknown): number | undefined {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

export class MonitorManager {
  private readonly entries = new Map<string, MonitorEntry>();
  private readonly onEvent: MonitorManagerOptions["onEvent"];
  private readonly onSettled: MonitorManagerOptions["onSettled"];
  private readonly websocketFactory: WebSocketFactory;
  private readonly now: () => number;
  private nextId = 1;
  private nextSettledOrder = 1;
  private notificationsSealed = false;
  private disposePromise?: Promise<void>;

  constructor(options: MonitorManagerOptions) {
    this.onEvent = options.onEvent;
    this.onSettled = options.onSettled;
    this.websocketFactory =
      options.websocketFactory ?? defaultWebSocketFactory;
    this.now = options.now ?? Date.now;
  }

  start(input: MonitorStartInput): MonitorSnapshot {
    if (this.notificationsSealed) {
      throw new Error("MonitorManager is disposed.");
    }
    this.validateInput(input);
    if (this.runningCount() >= MAX_ACTIVE_MONITORS) {
      throw new Error(
        `Cannot run more than ${MAX_ACTIVE_MONITORS} monitors concurrently.`,
      );
    }

    const id = `m-${this.nextId++}`;
    const snapshot: MutableSnapshot = {
      id,
      description: input.description,
      sourceKind: input.source.kind,
      sourceLabel:
        input.source.kind === "command"
          ? input.source.command
          : input.source.url,
      status: "running",
      persistent: input.persistent,
      timeoutMs: input.timeoutMs,
      startedAt: this.now(),
      eventCount: 0,
    };
    const entry: MonitorEntry = { snapshot, eventTimes: [] };
    this.entries.set(id, entry);

    if (!input.persistent) {
      entry.timeout = setTimeout(() => {
        void this.settle(
          entry,
          "timed_out",
          { error: `Monitor timed out after ${input.timeoutMs} ms.` },
          true,
        );
      }, input.timeoutMs);
    }

    if (input.source.kind === "command") {
      this.startCommand(entry, input.source);
    } else {
      this.startWebSocket(entry, input.source);
    }
    return this.copySnapshot(snapshot);
  }

  get(id: string): MonitorSnapshot | undefined {
    const entry = this.entries.get(id);
    return entry ? this.copySnapshot(entry.snapshot) : undefined;
  }

  list(): MonitorSnapshot[] {
    return [...this.entries.values()].map((entry) =>
      this.copySnapshot(entry.snapshot),
    );
  }

  stop(id: string): Promise<MonitorSnapshot> {
    const entry = this.entries.get(id);
    if (!entry) {
      return Promise.reject(new Error(`Unknown monitor: ${id}`));
    }
    if (entry.snapshot.status !== "running") {
      const settlement =
        entry.settlement ?? Promise.resolve(this.copySnapshot(entry.snapshot));
      return settlement.then((snapshot) => this.copySnapshot(snapshot));
    }
    return this.settle(entry, "stopped", {}, true).then((snapshot) =>
      this.copySnapshot(snapshot),
    );
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.notificationsSealed = true;
    this.disposePromise = (async () => {
      const work: Promise<MonitorSnapshot>[] = [];
      for (const entry of this.entries.values()) {
        if (entry.snapshot.status === "running") {
          work.push(this.settle(entry, "stopped", {}, true));
        } else if (entry.settlement) {
          work.push(entry.settlement);
        }
      }
      await Promise.all(work);
    })();
    return this.disposePromise;
  }

  private validateInput(input: MonitorStartInput): void {
    if (!Number.isFinite(input.timeoutMs) || !Number.isInteger(input.timeoutMs)) {
      throw new RangeError("timeoutMs must be a finite integer.");
    }
    if (input.persistent) {
      if (input.timeoutMs !== 0) {
        throw new RangeError("Persistent monitors require timeoutMs 0.");
      }
    } else if (input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`,
      );
    }
  }

  private runningCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.snapshot.status === "running") count += 1;
    }
    return count;
  }

  private startCommand(
    entry: MonitorEntry,
    source: Extract<MonitorSourceInput, { kind: "command" }>,
  ): void {
    const invocation = shellInvocation(source.command);
    let child: ChildProcess;
    try {
      child = spawn(invocation.executable, invocation.arguments, {
        cwd: source.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      void this.settle(
        entry,
        "failed",
        { error: errorText(error) },
        false,
      );
      return;
    }

    const resource: CommandResource = {
      kind: "command",
      child,
      closed: false,
      ...(process.platform !== "win32" && child.pid
        ? { processGroupId: child.pid }
        : {}),
    };
    entry.resource = resource;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutFragment = "";
    let stderrTail = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      if (entry.snapshot.status !== "running") return;
      stdoutFragment += stdoutDecoder.write(chunk);
      let newline = stdoutFragment.indexOf("\n");
      while (newline >= 0 && entry.snapshot.status === "running") {
        let line = stdoutFragment.slice(0, newline);
        stdoutFragment = stdoutFragment.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!this.emitEvent(entry, line)) return;
        newline = stdoutFragment.indexOf("\n");
      }
      if (Buffer.byteLength(stdoutFragment, "utf8") > MAX_EVENT_BYTES) {
        void this.settle(
          entry,
          "failed",
          { error: `Event exceeds ${MAX_EVENT_BYTES} UTF-8 bytes.` },
          true,
        );
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, stderrDecoder.write(chunk));
    });
    child.once("error", (error) => {
      const diagnostic = appendTail(stderrTail, errorText(error));
      void this.settle(entry, "failed", { error: diagnostic }, true);
    });
    child.once("close", (code, signal) => {
      resource.closed = true;
      stderrTail = appendTail(stderrTail, stderrDecoder.end());
      if (entry.snapshot.status !== "running") return;
      if (code === 0) {
        void this.settle(entry, "completed", { exitCode: 0 }, true);
        return;
      }
      const diagnostic =
        stderrTail ||
        (signal
          ? `Command terminated by ${signal}.`
          : `Command exited with code ${String(code)}.`);
      void this.settle(
        entry,
        "failed",
        {
          ...(typeof code === "number" ? { exitCode: code } : {}),
          ...(signal ? { signal } : {}),
          error: diagnostic,
        },
        true,
      );
    });
  }

  private startWebSocket(
    entry: MonitorEntry,
    source: Extract<MonitorSourceInput, { kind: "websocket" }>,
  ): void {
    let socket: WebSocketLike;
    try {
      socket = this.websocketFactory(source.url, source.protocols);
    } catch (error) {
      void this.settle(
        entry,
        "failed",
        { error: errorText(error) },
        false,
      );
      return;
    }
    const listeners: WebSocketResource["listeners"] = [];
    const onMessage = (event: WebSocketMessageEventLike) => {
      if (typeof event.data === "string") {
        this.emitEvent(entry, event.data);
        return;
      }
      const bytes = binaryFrameSize(event.data);
      if (bytes !== undefined) {
        if (bytes > MAX_EVENT_BYTES) {
          void this.settle(
            entry,
            "failed",
            { error: `Event exceeds ${MAX_EVENT_BYTES} bytes.` },
            true,
          );
          return;
        }
        this.emitEvent(entry, `[binary frame, ${bytes} bytes]`);
      }
    };
    const onError = () => {
      void this.settle(
        entry,
        "failed",
        { error: "WebSocket error." },
        true,
      );
    };
    const onClose = (event: WebSocketCloseEventLike) => {
      void this.settle(
        entry,
        "completed",
        {
          ...(typeof event.code === "number" ? { closeCode: event.code } : {}),
          ...(event.reason ? { closeReason: event.reason } : {}),
        },
        false,
      );
    };
    listeners.push(
      { type: "message", listener: onMessage },
      { type: "error", listener: onError },
      { type: "close", listener: onClose },
    );
    entry.resource = { kind: "websocket", socket, listeners };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  }

  private emitEvent(entry: MonitorEntry, text: string): boolean {
    if (entry.snapshot.status !== "running") return false;
    if (Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES) {
      void this.settle(
        entry,
        "failed",
        { error: `Event exceeds ${MAX_EVENT_BYTES} UTF-8 bytes.` },
        true,
      );
      return false;
    }

    const now = this.now();
    const cutoff = now - EVENT_WINDOW_MS;
    entry.eventTimes = entry.eventTimes.filter((time) => time > cutoff);
    if (entry.eventTimes.length >= MAX_EVENTS_PER_WINDOW) {
      void this.settle(
        entry,
        "failed",
        {
          error: `More than ${MAX_EVENTS_PER_WINDOW} events within ${EVENT_WINDOW_MS} ms.`,
        },
        true,
      );
      return false;
    }

    entry.eventTimes.push(now);
    entry.snapshot.eventCount += 1;
    entry.snapshot.lastEvent = text.slice(0, MAX_LAST_EVENT_CHARS);
    if (!this.notificationsSealed) {
      const event: MonitorEvent = {
        monitorId: entry.snapshot.id,
        sequence: entry.snapshot.eventCount,
        text,
      };
      try {
        this.onEvent(event, this.copySnapshot(entry.snapshot));
      } catch {}
    }
    return true;
  }

  private settle(
    entry: MonitorEntry,
    status: Exclude<MonitorStatus, "running">,
    details: TerminalDetails,
    terminateResource: boolean,
  ): Promise<MonitorSnapshot> {
    if (entry.snapshot.status !== "running") {
      return entry.settlement ?? Promise.resolve(this.copySnapshot(entry.snapshot));
    }

    // Status changes synchronously so first terminal cause owns every race.
    entry.snapshot.status = status;
    entry.snapshot.settledAt = this.now();
    entry.settledOrder = this.nextSettledOrder++;
    if (details.exitCode !== undefined) {
      entry.snapshot.exitCode = details.exitCode;
    }
    if (details.signal !== undefined) entry.snapshot.signal = details.signal;
    if (details.closeCode !== undefined) {
      entry.snapshot.closeCode = details.closeCode;
    }
    if (details.closeReason !== undefined) {
      entry.snapshot.closeReason = details.closeReason;
    }
    if (details.error !== undefined) entry.snapshot.error = details.error;
    if (entry.timeout) {
      clearTimeout(entry.timeout);
      entry.timeout = undefined;
    }

    const cleanup = this.releaseResource(entry.resource, terminateResource);
    entry.settlement = cleanup
      .catch(() => undefined)
      .then(() => {
        entry.resource = undefined;
        this.pruneSettled();
        if (!this.notificationsSealed) {
          try {
            this.onSettled(this.copySnapshot(entry.snapshot));
          } catch {}
        }
        return this.copySnapshot(entry.snapshot);
      });
    return entry.settlement;
  }

  private async releaseResource(
    resource: MonitorResource | undefined,
    terminate: boolean,
  ): Promise<void> {
    if (!resource) return;
    if (resource.kind === "websocket") {
      for (const { type, listener } of resource.listeners) {
        resource.socket.removeEventListener(type, listener);
      }
      if (terminate) {
        try {
          resource.socket.close();
        } catch {}
      }
      return;
    }
    if (!terminate) return;

    if (resource.processGroupId !== undefined) {
      if (!this.processGroupAlive(resource.processGroupId)) return;
      this.killCommand(resource, "SIGTERM");
      if (await this.waitForProcessGroup(resource.processGroupId, FORCE_KILL_AFTER_MS)) {
        return;
      }
      this.killCommand(resource, "SIGKILL");
      await this.waitForProcessGroup(
        resource.processGroupId,
        SETTLEMENT_FALLBACK_MS,
      );
      return;
    }

    if (resource.closed) return;

    this.killCommand(resource, "SIGTERM");
    if (await this.waitForClose(resource, FORCE_KILL_AFTER_MS)) return;
    this.killCommand(resource, "SIGKILL");
    await this.waitForClose(resource, SETTLEMENT_FALLBACK_MS);
  }

  private killCommand(
    resource: CommandResource,
    signal: NodeJS.Signals,
  ): void {
    if (resource.processGroupId !== undefined) {
      try {
        process.kill(-resource.processGroupId, signal);
        return;
      } catch {}
    }
    try {
      resource.child.kill(signal);
    } catch {}
  }

  private processGroupAlive(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      return !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
  }

  private async waitForProcessGroup(
    processGroupId: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processGroupAlive(processGroupId)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(25, remaining));
    }
    return true;
  }

  private async waitForClose(
    resource: CommandResource,
    timeoutMs: number,
  ): Promise<boolean> {
    if (resource.closed) return true;
    let timeout: NodeJS.Timeout | undefined;
    let onClose: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        onClose = resolve;
        resource.child.once("close", onClose);
        timeout = setTimeout(resolve, timeoutMs);
      });
      return resource.closed;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onClose) resource.child.off("close", onClose);
    }
  }

  private pruneSettled(): void {
    const settled = [...this.entries.values()]
      .filter((entry) => entry.snapshot.status !== "running")
      .sort(
        (left, right) =>
          (left.settledOrder ?? 0) - (right.settledOrder ?? 0),
      );
    for (let index = 0; index < settled.length - MAX_SETTLED_MONITORS; index += 1) {
      this.entries.delete(settled[index].snapshot.id);
    }
  }

  private copySnapshot(snapshot: MonitorSnapshot): MonitorSnapshot {
    return { ...snapshot };
  }
}
