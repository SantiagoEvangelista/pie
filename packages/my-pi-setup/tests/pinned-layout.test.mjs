import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolvePiRoot() {
  if (process.env.PI_CODING_AGENT_PACKAGE) {
    return process.env.PI_CODING_AGENT_PACKAGE;
  }
  const piBin = execFileSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
  return path.resolve(path.dirname(piBin), "../lib/node_modules/@earendil-works/pi-coding-agent");
}

const piRoot = resolvePiRoot();
const tuiRoot = path.join(piRoot, "node_modules/@earendil-works/pi-tui");
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Editor, FixedBottomContainer, TUI } = await import(
  pathToFileURL(path.join(tuiRoot, "dist/index.js")),
);

const identity = (text) => text;
const frameAnnotationPattern = /\x1b_pi:f:[^:]+:(row|padding):([^\x07]*)\x07/g;
const layoutText = (lines) => lines.map((line) => {
  let paddingStart;
  const clean = line.replace(frameAnnotationPattern, (_annotation, kind, payload) => {
    if (kind === "padding") paddingStart = Number(payload.split(":", 1)[0]);
    return "";
  });
  return paddingStart === undefined ? clean : clean.slice(0, paddingStart);
});
const editorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

class Lines {
  constructor(lines) {
    this.lines = lines;
  }

  render() {
    return [...this.lines];
  }

  invalidate() {}
}

class StateTerminal {
  columns = 80;
  rows = 6;
  writes = [];
  alternateScreen = false;
  mouseMode = "off";
  sgrMouse = false;
  viewportShift = 0;

  write(value) {
    this.writes.push(value);
    for (const match of value.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
      const mode = Number(match[1]);
      const enabled = match[2] === "h";
      if (mode === 1049) this.alternateScreen = enabled;
      if (mode === 1006) this.sgrMouse = enabled;
      if (mode === 1000 || mode === 1002 || mode === 1003) {
        if (enabled) this.mouseMode = String(mode);
        else if (this.mouseMode === String(mode)) this.mouseMode = "off";
      }
    }
  }

  wheel() {
    if (this.mouseMode !== "off") return true;
    if (this.alternateScreen) this.viewportShift += 3;
    return false;
  }

  start() {}
  stop() {}
  hideCursor() {}
  showCursor() {}
}

test("fixed layout pins bottom rows and scrolls only content", () => {
  const content = new Lines(Array.from({ length: 10 }, (_, index) => `content-${index}`));
  const bottom = new Lines(["editor", "footer"]);
  let renderRequests = 0;
  const layout = new FixedBottomContainer(content, bottom, () => 6, () => {
    renderRequests += 1;
  });

  assert.deepEqual(layoutText(layout.render(80)), ["content-6", "content-7", "content-8", "content-9", "editor", "footer"]);
  assert.deepEqual(layout.getScrollState(), {
    scrollTop: 6,
    maxScrollTop: 6,
    viewportHeight: 4,
    followBottom: true,
  });

  assert.equal(layout.scrollPage(-1), true);
  assert.deepEqual(layoutText(layout.render(80)), ["content-4", "content-5", "content-6", "content-7", "editor", "footer"]);
  assert.equal(layout.getScrollState().followBottom, false);
  assert.equal(layout.scrollToTop(), true);
  assert.deepEqual(layoutText(layout.render(80)), ["content-0", "content-1", "content-2", "content-3", "editor", "footer"]);
  assert.equal(layout.scrollToBottom(), true);
  assert.equal(renderRequests, 3);
});

test("fixed layout pads short conversations above pinned chrome", () => {
  let height = 6;
  const layout = new FixedBottomContainer(new Lines(["one"]), new Lines(["editor", "footer"]), () => height, () => {});
  assert.deepEqual(layoutText(layout.render(80)), ["one", "", "", "", "editor", "footer"]);
  height = 4;
  assert.deepEqual(layoutText(layout.render(80)), ["one", "", "editor", "footer"]);
});

test("editor lower boundary excludes multiline, history, and autocomplete navigation", async () => {
  const tui = new TUI(new StateTerminal());
  const editor = new Editor(tui, editorTheme);

  editor.setText("first\nsecond");
  editor.render(12);
  assert.equal(editor.isAtVisualBottomBoundary(), true);

  editor.handleInput("\x1b[D");
  assert.equal(editor.isAtVisualBottomBoundary(), false);
  editor.handleInput("\x1b[B");
  assert.equal(editor.isAtVisualBottomBoundary(), true);

  editor.handleInput("\x1b[A");
  assert.equal(editor.isAtVisualBottomBoundary(), false);
  editor.handleInput("\x1b[B");
  assert.equal(editor.isAtVisualBottomBoundary(), true);

  editor.addToHistory("older prompt");
  editor.setText("");
  editor.render(20);
  editor.handleInput("\x1b[A");
  assert.equal(editor.getText(), "older prompt");
  assert.equal(editor.isAtVisualBottomBoundary(), false);
  editor.handleInput("\x1b[B");
  assert.equal(editor.getText(), "");
  assert.equal(editor.isAtVisualBottomBoundary(), true);

  editor.setAutocompleteProvider({
    async getSuggestions() {
      return { prefix: "/", items: [{ value: "/workflows", label: "/workflows" }] };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  });
  editor.handleInput("/");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.isShowingAutocomplete(), true);
  assert.equal(editor.isAtVisualBottomBoundary(), false);
});

test("editor lower boundary excludes pending async autocomplete", async () => {
  const tui = new TUI(new StateTerminal());
  const editor = new Editor(tui, editorTheme);
  let resolveSuggestions;
  const suggestions = new Promise((resolve) => {
    resolveSuggestions = resolve;
  });

  editor.setAutocompleteProvider({
    getSuggestions() {
      return suggestions;
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  });
  editor.handleInput("/");
  assert.equal(editor.isShowingAutocomplete(), false);
  assert.equal(editor.isAtVisualBottomBoundary(), false);

  resolveSuggestions({
    prefix: "/",
    items: [{ value: "/workflows", label: "/workflows" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.isShowingAutocomplete(), true);
  assert.equal(editor.isAtVisualBottomBoundary(), false);
});

test("history stays anchored while scrolled and resumes following at bottom", () => {
  const content = new Lines(Array.from({ length: 8 }, (_, index) => `content-${index}`));
  const layout = new FixedBottomContainer(content, new Lines(["editor", "footer"]), () => 6, () => {});

  layout.render(80);
  layout.scrollPage(-1);
  const anchoredTop = layout.getScrollState().scrollTop;
  content.lines.push("content-8", "content-9");
  assert.equal(layoutText(layout.render(80))[0], `content-${anchoredTop}`);
  assert.equal(layout.getScrollState().followBottom, false);

  layout.scrollToBottom();
  content.lines.push("content-10");
  assert.deepEqual(layoutText(layout.render(80)).slice(-3), ["content-10", "editor", "footer"]);
  assert.equal(layout.getScrollState().followBottom, true);
});

test("TUI restores normal mouse tracking after button-motion selection", async () => {
  const terminal = new StateTerminal();
  const tui = new TUI(terminal);
  tui.setAlternateScreen(true);
  tui.setMouseTracking(true);
  tui.addChild(new Lines(["screen"]));
  tui.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(terminal.alternateScreen, true);
  assert.equal(terminal.mouseMode, "1000");
  assert.equal(terminal.sgrMouse, true);

  tui.setMouseMotionTracking(true);
  assert.equal(terminal.mouseMode, "1002");
  tui.setMouseMotionTracking(false);
  assert.equal(terminal.mouseMode, "1000");
  assert.equal(terminal.wheel(), true);
  assert.equal(terminal.viewportShift, 0);

  tui.stop();

  assert.equal(terminal.alternateScreen, false);
  assert.equal(terminal.mouseMode, "off");
  assert.equal(terminal.sgrMouse, false);

  tui.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminal.alternateScreen, true);
  assert.equal(terminal.mouseMode, "1000");
  tui.setMouseMotionTracking(true);
  tui.stop();
  assert.equal(terminal.alternateScreen, false);
  assert.equal(terminal.mouseMode, "off");
  assert.equal(terminal.sgrMouse, false);

  const output = terminal.writes.join("");
  const lifecycleSequences = [
    "\x1b[?1049h",
    "\x1b[?1000h",
    "\x1b[?1006h",
    "\x1b[?1000l\x1b[?1002h",
    "\x1b[?1002l\x1b[?1000h",
    "\x1b[?1006l\x1b[?1002l\x1b[?1000l",
    "\x1b[?1049l",
  ];
  for (const sequence of lifecycleSequences) {
    assert.ok(output.includes(sequence), `missing terminal sequence ${JSON.stringify(sequence)}`);
  }
});

test("full-screen overlay close preserves pinned mouse and viewport state", async () => {
  const terminal = new StateTerminal();
  const tui = new TUI(terminal);
  tui.setAlternateScreen(true);
  tui.setMouseTracking(true);
  tui.addChild(new Lines(["content", "", "", "", "editor", "footer"]));
  tui.start();
  await new Promise((resolve) => setImmediate(resolve));

  const overlay = tui.showOverlay(new Lines(Array.from({ length: 6 }, (_, index) => `workflow-${index}`)), {
    width: "100%",
    maxHeight: "100%",
  });
  await new Promise((resolve) => setImmediate(resolve));
  overlay.hide();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(terminal.alternateScreen, true);
  assert.equal(terminal.mouseMode, "1000");
  assert.equal(terminal.wheel(), true);
  assert.equal(terminal.viewportShift, 0);
  tui.stop();
});

test("extension wheel cancellation stays ahead of pinned scrolling after rebind", () => {
  const terminal = new StateTerminal();
  const tui = new TUI(terminal);
  tui.setAlternateScreen(true);
  tui.setMouseTracking(true);
  tui.addChild(new Lines(["screen"]));
  tui.start();

  const wheel = "\x1b[<64;1;1M";
  const events = [];
  let pinnedUnsubscribe;
  const setupPinned = () => {
    pinnedUnsubscribe?.();
    pinnedUnsubscribe = tui.addInputListener((data) => {
      if (data !== wheel) return undefined;
      events.push("pinned");
      return { consume: true };
    });
  };
  const bindExtension = () =>
    tui.addInputListener((data) => {
      if (data !== wheel) return undefined;
      events.push("extension");
      tui.setMouseMotionTracking(false);
      return undefined;
    });

  let extensionUnsubscribe = bindExtension();
  setupPinned();
  tui.setMouseMotionTracking(true);
  tui.handleInput(wheel);
  assert.deepEqual(events.splice(0), ["extension", "pinned"]);
  assert.equal(terminal.mouseMode, "1000");

  extensionUnsubscribe();
  extensionUnsubscribe = bindExtension();
  setupPinned();
  tui.setMouseMotionTracking(true);
  tui.handleInput(wheel);
  assert.deepEqual(events, ["extension", "pinned"]);
  assert.equal(terminal.mouseMode, "1000");

  extensionUnsubscribe();
  pinnedUnsubscribe?.();
  tui.stop();
});

test("interactive mode installs pinned layout and wheel/page handlers", () => {
  const source = readFileSync(path.join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.match(source, /new FixedBottomContainer/);
  assert.match(source, /setupPinnedLayoutScrolling/);
  assert.match(source, /mouseWheelDirection/);
  assert.match(source, /shift\+pageup/);
  assert.match(source, /PI_FIXED_LAYOUT_ACTIVE/);
  assert.match(source, /bottomContainer\.addChild\(this\.customFooter\)/);
  assert.match(source, /pinnedLayoutInputUnsubscribe/);
  assert.match(source, /bindCurrentSessionExtensions\(\)[\s\S]*setupPinnedLayoutScrolling\(\)/);
  assert.match(source, /async handleReloadCommand\(\)[\s\S]*setupPinnedLayoutScrolling\(\)/);
});

test("installed TUI exposes public editor lower-boundary contract", () => {
  const editorSource = readFileSync(path.join(tuiRoot, "dist/components/editor.js"), "utf8");
  const concreteTypes = readFileSync(path.join(tuiRoot, "dist/components/editor.d.ts"), "utf8");
  const editorTypes = readFileSync(path.join(tuiRoot, "dist/editor-component.d.ts"), "utf8");
  assert.match(editorSource, /autocompleteRequestScheduled/);
  assert.match(editorSource, /isAtVisualBottomBoundary\(\)/);
  assert.match(concreteTypes, /autocompleteRequestScheduled/);
  assert.match(concreteTypes, /isAtVisualBottomBoundary\(\): boolean/);
  assert.match(editorTypes, /isAtVisualBottomBoundary\?\(\): boolean/);
});

test("footer navigation upgrade patches recover partial installs", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-footer-navigation-"));
  const files = [
    "dist/components/editor.js",
    "dist/components/editor.d.ts",
    "dist/editor-component.d.ts",
  ];
  const patches = [
    "pi-tui-0.83-footer-navigation-editor-js.patch",
    "pi-tui-0.83-footer-navigation-editor-dts.patch",
    "pi-tui-0.83-footer-navigation-interface-dts.patch",
  ];

  try {
    for (const file of files) {
      const target = path.join(fixture, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(tuiRoot, file), target);
    }
    for (const patchName of [...patches].reverse()) {
      execFileSync("patch", ["-s", "-R", "-d", fixture, "-p1", "-i", path.join(agentRoot, "packages/my-pi-setup/patches", patchName)]);
    }

    for (const patchName of [patches[0], patches[2]]) {
      execFileSync("patch", ["-s", "-d", fixture, "-p1", "-i", path.join(agentRoot, "packages/my-pi-setup/patches", patchName)]);
    }
    assert.doesNotMatch(readFileSync(path.join(fixture, files[1]), "utf8"), /isAtVisualBottomBoundary/);
    execFileSync("patch", ["-s", "-d", fixture, "-p1", "-i", path.join(agentRoot, "packages/my-pi-setup/patches", patches[1])]);

    assert.match(readFileSync(path.join(fixture, files[0]), "utf8"), /autocompleteRequestScheduled/);
    assert.match(readFileSync(path.join(fixture, files[1]), "utf8"), /autocompleteRequestScheduled/);
    assert.match(readFileSync(path.join(fixture, files[2]), "utf8"), /isAtVisualBottomBoundary/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("mouse text selection delegates mouse mode ownership to TUI", () => {
  const source = readFileSync(path.join(agentRoot, "extensions/mouse-text-selection.ts"), "utf8");
  assert.match(source, /setMouseMotionTracking\(true\)/);
  assert.match(source, /setMouseMotionTracking\(false\)/);
  assert.match(source, /getFrameSnapshot\(\)/);
  assert.match(source, /setFrameHighlights/);
  assert.doesNotMatch(source, /isMouseSelectionModeArmed|selectionModeArmed/);
  assert.doesNotMatch(source, /process\.stdout\.write/);
  assert.doesNotMatch(source, /ENABLE_DRAG_MOUSE|DISABLE_DRAG_MOUSE/);
});

test("apply script upgrades prior pinned-layout installs", () => {
  const source = readFileSync(path.join(agentRoot, "packages/my-pi-setup/scripts/apply-pi-inline-compaction.sh"), "utf8");
  assert.match(source, /setMouseMotionTracking\(enabled\)/);
  assert.match(source, /isAtVisualBottomBoundary\(\)/);
  assert.match(source, /pi-tui-0\.83-mouse-ownership\.patch/);
  assert.match(source, /pi-tui-0\.83-footer-navigation-editor-js\.patch/);
  assert.match(source, /pi-tui-0\.83-footer-navigation-editor-dts\.patch/);
  assert.match(source, /pi-tui-0\.83-footer-navigation-interface-dts\.patch/);
  assert.match(source, /pi-0\.83-pinned-listener-order\.patch/);
});
