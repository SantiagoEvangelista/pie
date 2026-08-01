import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const { FixedBottomContainer, TUI } = await import(pathToFileURL(path.join(tuiRoot, "dist/index.js")));

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

  assert.deepEqual(layout.render(80), ["content-6", "content-7", "content-8", "content-9", "editor", "footer"]);
  assert.deepEqual(layout.getScrollState(), {
    scrollTop: 6,
    maxScrollTop: 6,
    viewportHeight: 4,
    followBottom: true,
  });

  assert.equal(layout.scrollPage(-1), true);
  assert.deepEqual(layout.render(80), ["content-4", "content-5", "content-6", "content-7", "editor", "footer"]);
  assert.equal(layout.getScrollState().followBottom, false);
  assert.equal(layout.scrollToTop(), true);
  assert.deepEqual(layout.render(80), ["content-0", "content-1", "content-2", "content-3", "editor", "footer"]);
  assert.equal(layout.scrollToBottom(), true);
  assert.equal(renderRequests, 3);
});

test("fixed layout pads short conversations above pinned chrome", () => {
  let height = 6;
  const layout = new FixedBottomContainer(new Lines(["one"]), new Lines(["editor", "footer"]), () => height, () => {});
  assert.deepEqual(layout.render(80), ["one", "", "", "", "editor", "footer"]);
  height = 4;
  assert.deepEqual(layout.render(80), ["one", "", "editor", "footer"]);
});

test("history stays anchored while scrolled and resumes following at bottom", () => {
  const content = new Lines(Array.from({ length: 8 }, (_, index) => `content-${index}`));
  const layout = new FixedBottomContainer(content, new Lines(["editor", "footer"]), () => 6, () => {});

  layout.render(80);
  layout.scrollPage(-1);
  const anchoredTop = layout.getScrollState().scrollTop;
  content.lines.push("content-8", "content-9");
  assert.equal(layout.render(80)[0], `content-${anchoredTop}`);
  assert.equal(layout.getScrollState().followBottom, false);

  layout.scrollToBottom();
  content.lines.push("content-10");
  assert.deepEqual(layout.render(80).slice(-3), ["content-10", "editor", "footer"]);
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

test("mouse text selection delegates mouse mode ownership to TUI", () => {
  const source = readFileSync(path.join(agentRoot, "extensions/mouse-text-selection.ts"), "utf8");
  assert.match(source, /setMouseMotionTracking\(armed\)/);
  assert.match(source, /mouse\?\.wheel/);
  assert.match(source, /isMouseSelectionModeArmed/);
  assert.doesNotMatch(source, /process\.stdout\.write/);
  assert.doesNotMatch(source, /ENABLE_DRAG_MOUSE|DISABLE_DRAG_MOUSE/);
});

test("apply script upgrades prior pinned-layout installs", () => {
  const source = readFileSync(path.join(agentRoot, "packages/my-pi-setup/scripts/apply-pi-inline-compaction.sh"), "utf8");
  assert.match(source, /setMouseMotionTracking\(enabled\)/);
  assert.match(source, /pi-tui-0\.83-mouse-ownership\.patch/);
  assert.match(source, /pi-0\.83-pinned-listener-order\.patch/);
});
