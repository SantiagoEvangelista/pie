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
  const layout = new FixedBottomContainer(new Lines(["one"]), new Lines(["editor", "footer"]), () => 6, () => {});
  assert.deepEqual(layout.render(80), ["one", "", "", "", "editor", "footer"]);
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

test("alternate screen and base mouse tracking restore on stop", async () => {
  class FakeTerminal {
    columns = 80;
    rows = 6;
    writes = [];

    write(value) {
      this.writes.push(value);
    }

    start() {}
    stop() {}
    hideCursor() {}
    showCursor() {}
  }

  const terminal = new FakeTerminal();
  const tui = new TUI(terminal);
  tui.setAlternateScreen(true);
  tui.setMouseTracking(true);
  tui.addChild(new Lines(["screen"]));
  tui.start();
  await new Promise((resolve) => setImmediate(resolve));
  tui.stop();

  const output = terminal.writes.join("");
  for (const sequence of ["\x1b[?1049h", "\x1b[?1000h", "\x1b[?1006h", "\x1b[?1006l", "\x1b[?1000l", "\x1b[?1049l"]) {
    assert.ok(output.includes(sequence), `missing terminal sequence ${JSON.stringify(sequence)}`);
  }
});

test("interactive mode installs pinned layout and wheel/page handlers", () => {
  const source = readFileSync(path.join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.match(source, /new FixedBottomContainer/);
  assert.match(source, /setupPinnedLayoutScrolling/);
  assert.match(source, /mouseWheelDirection/);
  assert.match(source, /shift\+pageup/);
  assert.match(source, /PI_FIXED_LAYOUT_ACTIVE/);
});

test("mouse text selection preserves fixed-layout wheel tracking", () => {
  const source = readFileSync(path.join(agentRoot, "extensions/mouse-text-selection.ts"), "utf8");
  assert.match(source, /PI_FIXED_LAYOUT_ACTIVE/);
  assert.match(source, /ENABLE_DRAG_MOUSE/);
  assert.match(source, /mouse\?\.wheel/);
  assert.match(source, /isMouseSelectionModeArmed/);
});
