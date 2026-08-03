import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolvePiRoot() {
  if (process.env.PI_CODING_AGENT_PACKAGE) return process.env.PI_CODING_AGENT_PACKAGE;
  const piBin = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
  return path.resolve(path.dirname(piBin), "../lib/node_modules/@earendil-works/pi-coding-agent");
}

const piRoot = resolvePiRoot();
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const extensionPath = path.join(agentRoot, "extensions/mouse-text-selection.ts");
const jitiUrl = pathToFileURL(path.join(piRoot, "node_modules/jiti/lib/jiti.mjs"));
const { createJiti } = await import(jitiUrl);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(piRoot, "dist/index.js"),
    "@earendil-works/pi-tui": path.join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  },
});
const {
  MousePacketBuffer,
  MouseSelectionEditor,
  TranscriptSelectionController,
  normalizeHttpHref,
  stripTerminalSequences,
} = await jiti.import(extensionPath);
const { FixedBottomContainer, Markdown, TUI, resetCapabilitiesCache, setCapabilities } = await import(
  pathToFileURL(path.join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")),
);

const mousePattern = /\x1b\[<\d+;\d+;\d+[Mm]/g;
const packet = (code, x, y, suffix = "M") => `\x1b[<${code};${x + 1};${y + 1}${suffix}`;
const press = (x, y) => packet(0, x, y);
const move = (x, y) => packet(32, x, y);
const release = (x, y) => packet(0, x, y, "m");
const wheel = (x, y, code = 64) => packet(code, x, y);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const settleRender = () => new Promise((resolve) => setTimeout(resolve, 25));

function frame(lines, options = {}) {
  const viewportTop = options.viewportTop ?? 0;
  return {
    revision: options.revision ?? 1,
    lines,
    viewportTop,
    viewportBottom: options.viewportBottom ?? lines.length,
    width: options.width ?? 80,
    height: options.height ?? lines.length,
    transcriptRows: options.transcriptRows ?? lines.map((_, row) => ({ row, sourceRow: row })),
    generatedPadding: options.generatedPadding ?? [],
    linkSpans: options.linkSpans ?? [],
  };
}

class FakeTui {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.terminal = {
      columns: snapshot?.width ?? 80,
      rows: snapshot?.height ?? 24,
    };
  }

  motions = [];
  highlights = [];
  clearCount = 0;

  getFrameSnapshot() {
    return this.snapshot;
  }

  setFrameHighlights(revision, ranges) {
    if (!this.snapshot || revision !== this.snapshot.revision) return false;
    this.highlights.push({ revision, ranges: structuredClone(ranges) });
    return true;
  }

  clearFrameHighlights() {
    this.clearCount += 1;
  }

  setMouseMotionTracking(enabled) {
    this.motions.push(enabled);
  }
}

function harness(snapshot) {
  const tui = new FakeTui(snapshot);
  const copied = [];
  const opened = [];
  const controller = new TranscriptSelectionController(tui, {
    copy: async (text) => { copied.push(text); },
    open: async (href) => { opened.push(href); },
  });
  const packets = new MousePacketBuffer();
  const input = (data) => {
    const delegated = packets.feed(data, (event) => controller.handle(event) || !event.wheel);
    mousePattern.lastIndex = 0;
    if (delegated.replace(mousePattern, "").length > 0) controller.clear();
    return delegated;
  };
  return { tui, copied, opened, controller, input };
}

test("wheel passes through unchanged and clears completed highlight", async () => {
  const h = harness(frame(["abcdef"]));
  assert.equal(h.input(press(0, 0)), "");
  assert.equal(h.input(move(3, 0)), "");
  assert.equal(h.input(release(3, 0)), "");
  await settle();
  assert.deepEqual(h.copied, ["abc"]);
  assert.deepEqual(h.tui.highlights.at(-1), {
    revision: 1,
    ranges: [{ row: 0, startColumn: 0, endColumn: 3 }],
  });

  const packet = wheel(2, 0);
  assert.equal(h.input(packet), packet);
  assert.equal(h.tui.motions.at(-1), false);
  assert.equal(h.opened.length, 0);
  assert.ok(h.tui.clearCount > 0);
});

test("drag packets cancel URL clicks while two-cell threshold begins selection", async () => {
  const href = "https://example.test/a?b=1";
  const snapshot = frame(["link text"], {
    linkSpans: [{ row: 0, startColumn: 0, endColumn: 9, href }],
  });
  const click = harness(snapshot);
  click.input(press(1, 0));
  click.input(release(2, 0));
  await settle();
  assert.deepEqual(click.opened, [href]);
  assert.deepEqual(click.copied, []);

  const oneCellDrag = harness(snapshot);
  oneCellDrag.input(press(1, 0));
  oneCellDrag.input(move(2, 0));
  oneCellDrag.input(release(2, 0));
  await settle();
  assert.deepEqual(oneCellDrag.opened, []);
  assert.deepEqual(oneCellDrag.copied, []);
  assert.deepEqual(oneCellDrag.tui.highlights, []);

  const drag = harness(snapshot);
  drag.input(press(1, 0));
  drag.input(move(3, 0));
  drag.input(release(3, 0));
  await settle();
  assert.deepEqual(drag.opened, []);
  assert.deepEqual(drag.copied, ["in"]);
  assert.deepEqual(drag.tui.motions, [false, true, false]);

  const source = readFileSync(extensionPath, "utf8");
  assert.doesNotMatch(source, /selectionModeArmed|Option\+A|alt\+a/i);
});

test("reverse multiline drag orders visible transcript rows", async () => {
  const h = harness(frame(["zero", "one", "two"]));
  h.input(press(3, 2));
  h.input(move(1, 0));
  h.input(release(1, 0));
  await settle();
  assert.deepEqual(h.copied, ["ero\none\ntwo"]);
  assert.deepEqual(h.tui.highlights.at(-1).ranges, [
    { row: 0, startColumn: 1, endColumn: 4 },
    { row: 1, startColumn: 0, endColumn: 3 },
    { row: 2, startColumn: 0, endColumn: 3 },
  ]);
});

test("ANSI and Unicode use display cells while only annotated padding is omitted", async () => {
  const styled = "\x1b[31mA\x1b[0m\x1b]8;;https://example.test\x07B\x1b]8;;\x07";
  const unicode = "e\u0301界🙂  ";
  const h = harness(frame([styled, unicode], {
    generatedPadding: [{ row: 1, startColumn: 5, endColumn: 7 }],
  }));
  h.input(press(0, 0));
  h.input(move(7, 1));
  h.input(release(7, 1));
  await settle();
  assert.deepEqual(h.copied, ["AB\ne\u0301界🙂"]);
  assert.deepEqual(h.tui.highlights.at(-1).ranges, [
    { row: 0, startColumn: 0, endColumn: 2 },
    { row: 1, startColumn: 0, endColumn: 5 },
  ]);

  const spaces = harness(frame(["  lead  middle  tail    "], {
    generatedPadding: [{ row: 0, startColumn: 22, endColumn: 24 }],
  }));
  spaces.input(press(0, 0));
  spaces.input(move(24, 0));
  spaces.input(release(24, 0));
  await settle();
  assert.deepEqual(spaces.copied, ["  lead  middle  tail  "]);
});

test("safe semantic HTTP links open through spy and unsafe hrefs never do", async () => {
  for (const [href, expected] of [
    ["http://example.test/path", "http://example.test/path"],
    ["https://example.test/a b", "https://example.test/a%20b"],
  ]) {
    const h = harness(frame(["url"], {
      linkSpans: [{ row: 0, startColumn: 0, endColumn: 3, href }],
    }));
    h.input(press(1, 0));
    h.input(release(1, 0));
    await settle();
    assert.deepEqual(h.opened, [expected]);
  }

  const unsafe = [
    "file:///tmp/x",
    "mailto:x@example.test",
    "/relative",
    "https://user:pass@example.test/",
    "https://example.test/%0a",
    "https://example.test/\x1b",
    "not a url",
  ];
  for (const href of unsafe) {
    assert.equal(normalizeHttpHref(href), undefined);
    const h = harness(frame(["url"], {
      linkSpans: [{ row: 0, startColumn: 0, endColumn: 3, href }],
    }));
    h.input(press(1, 0));
    h.input(release(1, 0));
    await settle();
    assert.deepEqual(h.opened, []);
  }
});

test("modifier and extended-button bits never alias primary", async () => {
  const href = "https://example.test/";
  for (const code of [8, 16, 128, 4_294_967_296]) {
    const h = harness(frame(["url"], {
      linkSpans: [{ row: 0, startColumn: 0, endColumn: 3, href }],
    }));
    assert.equal(h.input(packet(code, 1, 0)), "");
    assert.equal(h.input(packet(code, 1, 0, "m")), "");
    await settle();
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.copied, []);
    assert.equal(h.tui.motions.includes(true), false);
  }
});

test("editor select-all is super+a only and focused non-wheel packets are consumed", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.match(source, /if \(matchesKey\(data, "super\+a"\)\)/);
  assert.doesNotMatch(source, /matchesKey\(data, "ctrl\+a"\)/);
  assert.match(source, /editor\?\.handlePointerMouse\(event\) \|\| !event\.wheel/);
});

test("complete ANSI tokenizer drops DCS, APC, PM, and SOS payloads", () => {
  const sevenBit = ["P", "_", "^", "X"].map((introducer) => `\x1b${introducer}UNTRUSTED\x1b\\`).join("");
  const eightBit = ["\x90", "\x9f", "\x9e", "\x98"].map((introducer) => `${introducer}HIDDEN\x9c`).join("");
  assert.equal(stripTerminalSequences(`safe${sevenBit}middle${eightBit}end`), "safemiddleend");
  assert.equal(stripTerminalSequences("before\x1b_UNTERMINATED"), "before");
});

test("editor and footer starts stay inert; transcript drags clamp above chrome", async () => {
  const snapshot = frame(["first", "second", "editor", "footer"], {
    transcriptRows: [{ row: 0, sourceRow: 0 }, { row: 1, sourceRow: 1 }],
  });
  for (const row of [2, 3]) {
    const h = harness(snapshot);
    assert.equal(h.input(press(1, row)), "");
    assert.equal(h.input(move(3, row)), "");
    assert.equal(h.input(release(3, row)), "");
    await settle();
    assert.deepEqual(h.copied, []);
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.tui.highlights, []);
    assert.equal(h.tui.motions.includes(true), false);
  }

  const clamped = harness(snapshot);
  clamped.input(press(1, 0));
  clamped.input(move(7, 3));
  clamped.input(release(7, 3));
  await settle();
  assert.deepEqual(clamped.copied, ["irst\nsecond"]);
  assert.deepEqual(clamped.tui.highlights.at(-1).ranges, [
    { row: 0, startColumn: 1, endColumn: 5 },
    { row: 1, startColumn: 0, endColumn: 6 },
  ]);
});

test("both wheel directions pass through over transcript, editor, and footer after drag", async () => {
  const snapshot = frame(["first", "second", "editor", "footer"], {
    transcriptRows: [{ row: 0, sourceRow: 0 }, { row: 1, sourceRow: 1 }],
  });
  for (const code of [64, 65]) {
    for (const row of [0, 2, 3]) {
      const h = harness(snapshot);
      h.input(press(0, 0));
      h.input(move(3, 0));
      h.input(release(3, 0));
      await settle();
      const event = wheel(2, row, code);
      assert.equal(h.input(event), event);
      assert.deepEqual(h.opened, []);
      assert.equal(h.tui.motions.at(-1), false);
      assert.ok(h.tui.clearCount > 0);
    }
  }
});

test("keyboard, revision change, null frame, and focus loss clear selection", () => {
  const ordinary = harness(frame(["abcdef"]));
  ordinary.input(press(0, 0));
  ordinary.input(move(3, 0));
  assert.equal(ordinary.input("x"), "x");
  assert.equal(ordinary.tui.motions.at(-1), false);

  for (const replacement of [frame(["changed"], { revision: 2 }), null]) {
    const h = harness(frame(["abcdef"]));
    h.input(press(0, 0));
    h.input(move(3, 0));
    h.tui.snapshot = replacement;
    h.controller.reconcile(true);
    assert.equal(h.tui.motions.at(-1), false);
    assert.ok(h.tui.clearCount > 0);
  }

  const focus = harness(frame(["abcdef"]));
  focus.input(press(0, 0));
  focus.controller.reconcile(false);
  assert.equal(focus.tui.motions.at(-1), false);
  assert.ok(focus.tui.clearCount > 0);

  for (const dimension of ["width", "height"]) {
    const h = harness(frame(["abcdef"], { width: 80, height: 1 }));
    h.input(press(0, 0));
    h.tui.terminal[dimension === "width" ? "columns" : "rows"] += 1;
    assert.equal(h.input(release(0, 0)), "");
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.copied, []);
    assert.equal(h.tui.motions.at(-1), false);
  }
});

class Lines {
  constructor(lines) {
    this.lines = lines;
  }
  render() {
    return [...this.lines];
  }
  invalidate() {}
}

class CaptureTerminal {
  columns = 20;
  rows = 4;
  writes = [];
  write(value) { this.writes.push(value); }
  start() {}
  stop() {}
  hideCursor() {}
  showCursor() {}
}

const editorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};
const inertKeybindings = { matches: () => false };

test("textbox supports Shift+Arrow and always-on mouse selection", () => {
  const keyboardTui = new TUI(new CaptureTerminal());
  const keyboardEditor = new MouseSelectionEditor(keyboardTui, editorTheme, inertKeybindings, () => {});
  keyboardEditor.setText("hello");
  keyboardEditor.handleInput("\x1b[1;2D");
  assert.match(keyboardEditor.render(30).join("\n"), /\x1b\[7m/);
  keyboardEditor.handleInput("X");
  assert.equal(keyboardEditor.getText(), "hellX");

  const mouseTui = new TUI(new CaptureTerminal());
  const mouseEditor = new MouseSelectionEditor(mouseTui, editorTheme, inertKeybindings, () => {});
  mouseEditor.setText("hello");
  mouseEditor.render(30);
  mouseTui.hardwareCursorRow = mouseEditor.lastCursorRenderRow;
  mouseTui.previousViewportTop = 0;
  assert.equal(mouseEditor.handlePointerMouse({
    rawCode: 0, button: 0, x: 1, y: 1, release: false, drag: false, wheel: false,
  }), true);
  assert.equal(mouseEditor.handlePointerMouse({
    rawCode: 32, button: 0, x: 4, y: 1, release: false, drag: true, wheel: false,
  }), true);
  assert.match(mouseEditor.render(30).join("\n"), /\x1b\[7m/);
  mouseEditor.handleInput("X");
  assert.equal(mouseEditor.getText(), "hXo");
});

test("real TUI keeps links row-local and emits then clears inverse-video selection", async () => {
  const terminal = new CaptureTerminal();
  const tui = new TUI(terminal);
  const content = new Lines([
    "\x1b]8;;https://example.test/\x07linked",
    "plain",
  ]);
  const layout = new FixedBottomContainer(content, new Lines(["editor", "footer"]), () => terminal.rows, () => {});
  tui.addChild(layout);
  tui.start();
  await settleRender();

  const snapshot = tui.getFrameSnapshot();
  assert.ok(snapshot);
  assert.deepEqual(snapshot.linkSpans.map(({ row, startColumn, endColumn }) => ({ row, startColumn, endColumn })), [
    { row: 0, startColumn: 0, endColumn: 6 },
  ]);
  assert.equal(tui.setFrameHighlights(snapshot.revision, [{ row: 1, startColumn: 0, endColumn: 5 }]), true);
  await settleRender();
  const highlightedOutput = terminal.writes.at(-1);
  assert.match(highlightedOutput, /\x1b\[7mplain\x1b\[27m/);

  tui.clearFrameHighlights();
  await settleRender();
  const clearedOutput = terminal.writes.at(-1);
  assert.match(clearedOutput, /plain/);
  assert.doesNotMatch(clearedOutput, /\x1b\[7m/);
  tui.stop();
});

test("fallback Markdown links remain semantic when terminal lacks OSC-8 support", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const identity = (text) => text;
  const theme = {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: identity,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  };
  const terminal = new CaptureTerminal();
  terminal.columns = 80;
  const tui = new TUI(terminal);
  const content = new Markdown("[Example link](https://example.test/path)", 0, 0, theme);
  const layout = new FixedBottomContainer(content, new Lines(["editor", "footer"]), () => terminal.rows, () => {});
  tui.addChild(layout);
  try {
    tui.start();
    await settleRender();
    const snapshot = tui.getFrameSnapshot();
    assert.ok(snapshot);
    assert.deepEqual(snapshot.linkSpans.map(({ row, href }) => ({ row, href })), [
      { row: 0, href: "https://example.test/path" },
    ]);
    assert.match(stripTerminalSequences(snapshot.lines[0]), /Example link \(https:\/\/example\.test\/path\)/);
  } finally {
    tui.stop();
    resetCapabilitiesCache();
  }
});

test("integrated-pointer completeness requires every declaration and exact reversible patch", () => {
  const setupRoot = path.resolve(agentRoot, "packages/my-pi-setup");
  const patchPath = path.join(setupRoot, "patches/pi-tui-0.83-integrated-pointer.patch");
  const script = readFileSync(path.join(setupRoot, "scripts/apply-pi-inline-compaction.sh"), "utf8");
  for (const symbol of [
    "FrameTranscriptRow",
    "FrameGeneratedPadding",
    "FrameLinkSpan",
    "FrameHighlightRange",
    "FrameSnapshot",
    "getFrameSnapshot(): FrameSnapshot | null",
    "setFrameHighlights(revision: number, ranges: readonly FrameHighlightRange[]): boolean",
    "clearFrameHighlights(): void",
  ]) {
    assert.ok(script.includes(symbol), `missing completeness symbol ${symbol}`);
  }
  assert.match(script, /--reverse --dry-run --batch/);

  const fixture = mkdtempSync(path.join(tmpdir(), "pi-integrated-pointer-"));
  const tuiRoot = path.join(piRoot, "node_modules/@earendil-works/pi-tui");
  try {
    for (const file of ["dist/tui.js", "dist/tui.d.ts", "dist/index.d.ts", "dist/components/markdown.js"]) {
      const target = path.join(fixture, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(tuiRoot, file), target);
    }
    const reverseDryRun = () => execFileSync("patch", [
      "-s", "-R", "--dry-run", "--batch", "-d", fixture, "-p1", "-i", patchPath,
    ]);
    assert.doesNotThrow(reverseDryRun);

    const declarations = path.join(fixture, "dist/tui.d.ts");
    writeFileSync(
      declarations,
      readFileSync(declarations, "utf8").replace("    clearFrameHighlights(): void;\n", ""),
    );
    assert.throws(reverseDryRun);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
