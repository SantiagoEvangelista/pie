import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function resolvePiRoot() {
  if (process.env.PI_CODING_AGENT_PACKAGE) {
    return process.env.PI_CODING_AGENT_PACKAGE;
  }
  const piBin = execFileSync("sh", ["-lc", "command -v pi"], {
    encoding: "utf8",
  }).trim();
  return path.resolve(
    path.dirname(piBin),
    "../lib/node_modules/@earendil-works/pi-coding-agent",
  );
}

const piRoot = resolvePiRoot();
const tuiEntry = path.join(
  piRoot,
  "node_modules/@earendil-works/pi-tui/dist/index.js",
);
const { Markdown } = await import(pathToFileURL(tuiEntry));

const identity = (text) => text;
const theme = {
  heading: (text) => `<heading>${text}</heading>`,
  link: identity,
  linkUrl: identity,
  code: (text) => `<code>${text}</code>`,
  codeBlock: (text) => `<block>${text}</block>`,
  codeBlockBorder: (text) => `<border>${text}</border>`,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: (text) => `<bold>${text}</bold>`,
  italic: identity,
  strikethrough: identity,
  underline: identity,
  highlightCode: (text) => text.split("\n").map((line) => `<hl>${line}</hl>`),
  codeBlockIndent: "  ",
};

test("clean Markdown hides source markers and preserves styled content", () => {
  const fence = "`".repeat(3);
  const source = [
    "### Explicit use",
    "",
    `${fence}ts`,
    'model: "kimi-coding/k3"',
    fence,
  ].join("\n");
  const lines = new Markdown(source, 0, 0, theme).render(80);
  const rendered = lines.join("\n");

  assert.doesNotMatch(rendered, /###|```/);
  assert.match(rendered, /<heading><bold>Explicit use<\/bold><\/heading>/);
  assert.match(rendered, /  <hl>model: "kimi-coding\/k3"<\/hl>/);
  assert.doesNotMatch(rendered, /<border>/);
});
