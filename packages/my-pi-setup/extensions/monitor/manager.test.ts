import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EVENT_BYTES,
  MAX_EVENTS_PER_WINDOW,
  MonitorManager,
  type MonitorEvent,
  type MonitorSnapshot,
  type WebSocketLike,
} from "./src/manager.ts";

const TEST_DEADLINE_MS = 2_500;

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/["^&|<>()%!]/g, "^$&")}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source).toString("base64");
  const loader = `eval(Buffer.from('${encoded}','base64').toString())`;
  return `${shellQuote(process.execPath)} -e ${shellQuote(loader)}`;
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          TEST_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  await within(
    new Promise<void>((resolve) => {
      const poll = () => {
        if (predicate()) {
          resolve();
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    }),
    label,
  );
}

class FakeWebSocket implements WebSocketLike {
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<
    string,
    Set<(event: any) => void>
  >();

  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: any) => void,
  ): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  emitText(text: string): void {
    this.emit("message", { data: text });
  }

  emitBinary(data: Uint8Array): void {
    this.emit("message", { data });
  }

  remoteClose(code = 1000, reason = "done"): void {
    this.emit("close", { code, reason });
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function makeManager(options: {
  socket?: FakeWebSocket;
  now?: () => number;
} = {}): {
  manager: MonitorManager;
  events: MonitorEvent[];
  settled: Promise<MonitorSnapshot>;
} {
  const events: MonitorEvent[] = [];
  let resolveSettled!: (snapshot: MonitorSnapshot) => void;
  const settled = new Promise<MonitorSnapshot>((resolve) => {
    resolveSettled = resolve;
  });
  const manager = new MonitorManager({
    onEvent: (event) => events.push(event),
    onSettled: resolveSettled,
    ...(options.socket
      ? { websocketFactory: () => options.socket as FakeWebSocket }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { manager, events, settled };
}

test("command emits complete stdout lines in order and completes", async () => {
  const { manager, events, settled } = makeManager();
  try {
    const started = manager.start({
      description: "line handling",
      source: {
        kind: "command",
        command: nodeCommand(
          'process.stdout.write("first\\r\\nsecond\\nunfinished");' +
            'process.stderr.write("ignored\\n");',
        ),
        cwd: process.cwd(),
      },
      persistent: false,
      timeoutMs: 1_000,
    });

    const result = await within(settled, "command completion");
    assert.equal(result.id, started.id);
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      events.map(({ sequence, text }) => ({ sequence, text })),
      [
        { sequence: 1, text: "first" },
        { sequence: 2, text: "second" },
      ],
    );
    assert.equal(result.eventCount, 2);
    assert.equal(result.lastEvent, "second");
  } finally {
    await manager.dispose();
  }
});

test("explicit stop returns stopped and dispose is idempotent", async () => {
  const { manager, events } = makeManager();
  try {
    const started = manager.start({
      description: "persistent command",
      source: {
        kind: "command",
        command: nodeCommand(
          'process.stdout.write("ready\\n");setInterval(() => {}, 1_000);',
        ),
        cwd: process.cwd(),
      },
      persistent: true,
      timeoutMs: 0,
    });
    await waitFor(() => events.some((event) => event.text === "ready"), "ready event");

    const result = await within(manager.stop(started.id), "explicit stop");
    assert.equal(result.status, "stopped");

    const firstDispose = manager.dispose();
    const secondDispose = manager.dispose();
    assert.strictEqual(secondDispose, firstDispose);
    await within(firstDispose, "dispose");
  } finally {
    await manager.dispose();
  }
});

test("short command timeout returns timed_out", async () => {
  const { manager, settled } = makeManager();
  try {
    manager.start({
      description: "timeout",
      source: {
        kind: "command",
        command: nodeCommand("setInterval(() => {}, 1_000);"),
        cwd: process.cwd(),
      },
      persistent: false,
      timeoutMs: 25,
    });

    const result = await within(settled, "command timeout");
    assert.equal(result.status, "timed_out");
    assert.equal(result.error, "Monitor timed out after 25 ms.");
  } finally {
    await manager.dispose();
  }
});

test("WebSocket emits text and binary placeholders and reports remote close", async () => {
  const socket = new FakeWebSocket();
  const { manager, events, settled } = makeManager({ socket });
  try {
    manager.start({
      description: "websocket lifecycle",
      source: { kind: "websocket", url: "ws://example.test/socket" },
      persistent: true,
      timeoutMs: 0,
    });
    assert.equal(socket.listenerCount(), 3);

    socket.emitText("hello");
    socket.emitBinary(new Uint8Array([1, 2, 3]));
    socket.remoteClose();

    const result = await within(settled, "remote close");
    assert.equal(result.status, "completed");
    assert.deepEqual(events.map((event) => event.text), [
      "hello",
      "[binary frame, 3 bytes]",
    ]);
    assert.equal(result.eventCount, 2);
    assert.equal(result.closeCode, 1000);
    assert.equal(result.closeReason, "done");
    assert.equal(socket.listenerCount(), 0);
    assert.equal(socket.closeCalls.length, 0);
  } finally {
    await manager.dispose();
  }
});

test(
  "natural shell exit kills a SIGTERM-resistant descendant process group",
  { skip: process.platform === "win32" },
  async () => {
    const { manager, events, settled } = makeManager();
    try {
      manager.start({
        description: "descendant cleanup",
        source: {
          kind: "command",
          command: nodeCommand(
            `const { spawn } = require("node:child_process");` +
              `const child = spawn(process.execPath, ["-e", ` +
              `"process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000)"], ` +
              `{ stdio: ["ignore", "ignore", "ignore", "ipc"] });` +
              `child.once("message", () => {` +
              `process.stdout.write(String(child.pid) + "\\n");` +
              `child.disconnect();child.unref();` +
              `});`,
          ),
          cwd: process.cwd(),
        },
        persistent: false,
        timeoutMs: 3_000,
      });

      await waitFor(() => events.length === 1, "descendant pid");
      const descendantPid = Number(events[0].text);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

      const result = await within(settled, "descendant cleanup");
      assert.equal(result.status, "completed");
      await waitFor(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch {
          return true;
        }
      }, "descendant exit");
    } finally {
      await manager.dispose();
    }
  },
);

test("oversized WebSocket text fails and closes socket", async () => {
  const socket = new FakeWebSocket();
  const { manager, events, settled } = makeManager({ socket });
  try {
    manager.start({
      description: "oversized websocket event",
      source: { kind: "websocket", url: "ws://example.test/large" },
      persistent: true,
      timeoutMs: 0,
    });
    socket.emitText("x".repeat(MAX_EVENT_BYTES + 1));

    const result = await within(settled, "oversized event failure");
    assert.equal(result.status, "failed");
    assert.equal(result.error, `Event exceeds ${MAX_EVENT_BYTES} UTF-8 bytes.`);
    assert.equal(result.eventCount, 0);
    assert.equal(events.length, 0);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.listenerCount(), 0);
  } finally {
    await manager.dispose();
  }
});

test("101st WebSocket event in one window fails after exactly 100 deliveries", async () => {
  const socket = new FakeWebSocket();
  const { manager, events, settled } = makeManager({
    socket,
    now: () => 10_000,
  });
  try {
    manager.start({
      description: "websocket event limit",
      source: { kind: "websocket", url: "ws://example.test/rate" },
      persistent: true,
      timeoutMs: 0,
    });
    for (let index = 1; index <= MAX_EVENTS_PER_WINDOW + 1; index += 1) {
      socket.emitText(`event-${index}`);
    }

    const result = await within(settled, "event-rate failure");
    assert.equal(result.status, "failed");
    assert.equal(
      result.error,
      `More than ${MAX_EVENTS_PER_WINDOW} events within 60000 ms.`,
    );
    assert.equal(result.eventCount, MAX_EVENTS_PER_WINDOW);
    assert.equal(events.length, MAX_EVENTS_PER_WINDOW);
    assert.equal(events.at(-1)?.text, `event-${MAX_EVENTS_PER_WINDOW}`);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.listenerCount(), 0);
  } finally {
    await manager.dispose();
  }
});
