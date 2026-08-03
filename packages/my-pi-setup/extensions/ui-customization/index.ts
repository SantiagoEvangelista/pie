import { homedir } from "node:os";
import { relative } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorComponent,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  OPEN_DASHBOARD_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";
import {
  FooterActionSelection,
  type FooterAction,
  type FooterNavigationIntent,
} from "./footer-navigation.ts";
import {
  applyPersistentBackground,
  renderFocusedActionLabel,
} from "./theme-rendering.ts";

type Rgb = [number, number, number];
interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

interface BoundaryAwareEditor extends EditorComponent {
  isAtVisualBottomBoundary?(): boolean;
}

type DashboardTheme = ExtensionContext["ui"]["theme"];

class DashboardFooter implements Component, Focusable {
  private readonly selection = new FooterActionSelection();
  private editor?: EditorComponent;
  private keybindings?: KeybindingsManager;
  private isFocused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: DashboardTheme,
    private readonly renderContent: (width: number) => string[],
    private readonly openDashboard: (action: FooterAction) => void,
  ) {}

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
  }

  bindEditor(editor: EditorComponent, keybindings: KeybindingsManager): void {
    this.editor = editor;
    this.keybindings = keybindings;
  }

  focusFromEditor(): void {
    this.tui.setFocus(this);
    this.tui.requestRender();
  }

  private focusEditor(): void {
    if (!this.editor) return;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const keybindings = this.keybindings;
    if (!keybindings) return;

    let intent: FooterNavigationIntent | undefined;
    if (keybindings.matches(data, "tui.editor.cursorLeft")) {
      intent = "left";
    } else if (keybindings.matches(data, "tui.editor.cursorRight")) {
      intent = "right";
    } else if (keybindings.matches(data, "tui.editor.cursorUp")) {
      intent = "up";
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      intent = "cancel";
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      intent = "confirm";
    }

    if (!intent) return;
    const result = this.selection.handle(intent);
    if (result.returnToEditor) this.focusEditor();
    if (result.action) this.openDashboard(result.action);
    if (result.returnToEditor) return;
    this.tui.requestRender();
  }

  private actionLabel(action: FooterAction): string {
    const text = action === "workflows" ? "Workflows" : "Subagents";
    if (!this.focused || this.selection.current() !== action) {
      return this.theme.fg("accent", text);
    }
    return renderFocusedActionLabel(this.theme, text);
  }

  private renderActions(width: number): string {
    const marker = this.focused
      ? this.theme.fg("accent", "❯ ")
      : this.theme.fg("dim", "↓ ");
    const separator = this.theme.fg("dim", "  ·  ");
    const all = `${marker}${this.actionLabel("workflows")}${separator}${this.actionLabel("subagents")}`;
    if (visibleWidth(all) <= width) return all;

    const selected = `${marker}${this.actionLabel(this.selection.current())}`;
    return truncateToWidth(selected, width, "");
  }

  render(width: number): string[] {
    return [...this.renderContent(width), this.renderActions(width)];
  }

  invalidate(): void {}
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [198, 97, 63],
  [217, 119, 87],
  [235, 159, 127],
  [244, 174, 148],
  [235, 159, 127],
  [217, 119, 87],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let activeFooter: DashboardFooter | undefined;
  let previousEditorFactory: ReturnType<
    ExtensionContext["ui"]["getEditorComponent"]
  >;
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function scheduleThemeRemoval(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      themeRemovalTimers.push(
        setTimeout(() => {
          if (hideThemesSection(tui)) tui.requestRender(true);
        }, delay),
      );
    }
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleThemeRemoval(tui);

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      activeFooter = new DashboardFooter(
        tui,
        theme,
        (width) => {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
          let git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`
            : "";

          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            git += ` · ${linkedPr}`;
          }

          const contextPercent =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}`;
          const contextWindow =
            modelInfo.contextWindow > 0
              ? formatTokens(modelInfo.contextWindow)
              : "?";
          const tps =
            modelInfo.tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
          const usage = `${contextPercent}%/${contextWindow} · ${tps}`;
          const model = modelInfo.provider
            ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
            : modelInfo.modelId;

          const lines = [
            columns(directory, theme.fg("muted", model), width),
            columns(theme.fg("muted", usage), theme.fg("muted", git), width),
          ];

          // Extension statuses render after the two dashboard lines, one per row.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines) {
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
        (action) => pi.events.emit(OPEN_DASHBOARD_CHANNEL, action),
      );
      return activeFooter;
    });

    previousEditorFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const selectedText = (text: string) =>
        ctx.ui.theme.bg(
          "selectedBg",
          ctx.ui.theme.bold(ctx.ui.theme.fg("text", text)),
        );
      const themedEditor: EditorTheme = {
        ...editorTheme,
        selectList: {
          ...editorTheme.selectList,
          selectedPrefix: selectedText,
          selectedText,
        },
      };
      const editor = (
        previousEditorFactory?.(
          tui,
          themedEditor,
          keybindings,
        ) ?? new CustomEditor(tui, themedEditor, keybindings)
      ) as BoundaryAwareEditor;
      const render = editor.render.bind(editor);
      editor.render = (width: number) => {
        const background = ctx.ui.theme.getBgAnsi("customMessageBg");
        return applyPersistentBackground(render(width), background);
      };
      const handleInput = editor.handleInput.bind(editor);

      editor.handleInput = (data: string) => {
        if (
          keybindings.matches(data, "tui.editor.cursorDown") &&
          editor.isAtVisualBottomBoundary?.() === true
        ) {
          activeFooter?.focusFromEditor();
          return;
        }
        handleInput(data);
      };
      activeFooter?.bindEditor(editor, keybindings);
      return editor;
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx);
  });

  pi.on("resources_discover", () => {
    if (activeTui) scheduleThemeRemoval(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent(previousEditorFactory);
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
    activeFooter = undefined;
    previousEditorFactory = undefined;
  });
}
