import {
	copyToClipboard,
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	matchesKey,
	sliceByColumn,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const ENABLE_DRAG_MOUSE = "\x1b[?1002h";
const DISABLE_DRAG_MOUSE = "\x1b[?1002l";
const MOUSE_EVENT = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const SELECT_START = "\x1b[7m";
const SELECT_END = "\x1b[27m";

type Position = { line: number; col: number };
type VisualLine = { logicalLine: number; startCol: number; length: number };
type MouseEvent = {
	button: number;
	x: number;
	y: number;
	release: boolean;
	drag: boolean;
	wheel: boolean;
};

interface EditorInternals {
	state: {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
	paddingX: number;
	lastWidth: number;
	scrollOffset: number;
	preferredVisualCol: number | null;
	snappedFromCursorCol: number | null;
	lastAction: string | null;
	buildVisualLineMap(width: number): VisualLine[];
	cancelAutocomplete(): void;
	exitHistoryBrowsing(): void;
	pushUndoSnapshot(): void;
	segment(text: string, mode: "grapheme"): Iterable<{ segment: string; index: number }>;
	setCursorCol(col: number): void;
}

interface TuiInternals {
	focusedComponent: unknown;
	hardwareCursorRow: number;
	previousViewportTop: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function parseMouseEvent(data: string): MouseEvent | undefined {
	const match = data.match(MOUSE_EVENT);
	if (!match) return undefined;

	const code = Number(match[1]);
	return {
		button: code & 3,
		x: Number(match[2]) - 1,
		y: Number(match[3]) - 1,
		release: match[4] === "m",
		drag: (code & 32) !== 0,
		wheel: (code & 64) !== 0,
	};
}

function comparePositions(a: Position, b: Position): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

function orderedPositions(a: Position, b: Position): [Position, Position] {
	return comparePositions(a, b) <= 0 ? [a, b] : [b, a];
}

function positionsEqual(a: Position | undefined, b: Position | undefined): boolean {
	return a !== undefined && b !== undefined && a.line === b.line && a.col === b.col;
}

function positionToOffset(lines: string[], position: Position): number {
	let offset = 0;
	for (let line = 0; line < position.line; line++) {
		offset += (lines[line]?.length ?? 0) + 1;
	}
	return offset + position.col;
}

function columnToStringIndex(
	text: string,
	visualColumn: number,
	segments: Iterable<{ segment: string; index: number }> = graphemeSegmenter.segment(text),
): number {
	if (visualColumn <= 0) return 0;

	let width = 0;
	for (const { segment, index } of segments) {
		const segmentWidth = visibleWidth(segment);
		if (visualColumn < width + segmentWidth) {
			return visualColumn - width >= segmentWidth / 2 ? index + segment.length : index;
		}
		width += segmentWidth;
	}
	return text.length;
}

function highlightColumns(line: string, start: number, end: number): string {
	if (end <= start) return line;

	const markerIndex = line.indexOf(CURSOR_MARKER);
	const markerColumn = markerIndex >= 0 ? visibleWidth(line.slice(0, markerIndex)) : undefined;
	const text = markerIndex >= 0
		? line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length)
		: line;
	const width = visibleWidth(text);
	const before = sliceByColumn(text, 0, start, true);
	let selected = sliceByColumn(text, start, end - start, true);
	const after = sliceByColumn(text, end, Math.max(0, width - end), true);

	// Base editor uses a full reset after its fake cursor. Reapply selection after it.
	selected = selected.replaceAll("\x1b[0m", `\x1b[0m${SELECT_START}`);
	const highlighted = `${before}${SELECT_START}${selected}${SELECT_END}${after}`;
	if (markerColumn === undefined) return highlighted;

	return (
		sliceByColumn(highlighted, 0, markerColumn, true) +
		CURSOR_MARKER +
		sliceByColumn(highlighted, markerColumn, Math.max(0, width - markerColumn), true)
	);
}

class MouseSelectionEditor extends CustomEditor {
	private anchor?: Position;
	private focus?: Position;
	private dragging = false;
	private lastCursorRenderRow = 1;
	private visibleTextLineCount = 1;
	private readonly appKeybindings: KeybindingsManager;
	private readonly onSelectionModeChange: (armed: boolean) => void;
	private selectionModeArmed = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		onSelectionModeChange: (armed: boolean) => void,
	) {
		super(tui, theme, keybindings);
		this.appKeybindings = keybindings;
		this.onSelectionModeChange = onSelectionModeChange;
	}

	private get internals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	private get selection(): [Position, Position] | undefined {
		if (!this.anchor || !this.focus || positionsEqual(this.anchor, this.focus)) return undefined;
		return orderedPositions(this.anchor, this.focus);
	}

	private clearSelection(): void {
		this.anchor = undefined;
		this.focus = undefined;
		this.dragging = false;
	}

	private setSelectionMode(armed: boolean): void {
		if (this.selectionModeArmed === armed) return;
		this.selectionModeArmed = armed;
		if (armed) enableMouse();
		else disableMouse();
		this.onSelectionModeChange(armed);
	}

	cancelMouseSelectionMode(): void {
		this.setSelectionMode(false);
	}

	isMouseSelectionModeArmed(): boolean {
		return this.selectionModeArmed;
	}

	private setCursorPosition(position: Position): void {
		const editor = this.internals;
		const line = Math.max(0, Math.min(position.line, editor.state.lines.length - 1));
		const col = Math.max(0, Math.min(position.col, editor.state.lines[line]?.length ?? 0));
		editor.state.cursorLine = line;
		editor.setCursorCol(col);
		editor.snappedFromCursorCol = null;
	}

	private positionFromMouse(event: MouseEvent): Position | undefined {
		const editor = this.internals;
		const tui = this.tui as unknown as TuiInternals;
		const cursorScreenRow = tui.hardwareCursorRow - tui.previousViewportTop;
		const editorTopRow = cursorScreenRow - this.lastCursorRenderRow;
		const localRow = event.y - editorTopRow;
		const visualLines = editor.buildVisualLineMap(editor.lastWidth);
		let visualLineIndex = editor.scrollOffset + localRow - 1;
		if (this.dragging && localRow < 1) visualLineIndex = editor.scrollOffset - 1;
		if (this.dragging && localRow > this.visibleTextLineCount) {
			visualLineIndex = editor.scrollOffset + this.visibleTextLineCount;
		}
		visualLineIndex = Math.max(0, Math.min(visualLineIndex, visualLines.length - 1));
		const visualLine = visualLines[visualLineIndex];

		if (!visualLine || (localRow < 1 && !this.dragging) || (localRow > this.visibleTextLineCount && !this.dragging)) {
			return undefined;
		}

		const logicalText = editor.state.lines[visualLine.logicalLine] ?? "";
		const visualText = logicalText.slice(visualLine.startCol, visualLine.startCol + visualLine.length);
		const textColumn = Math.max(0, event.x - editor.paddingX);
		return {
			line: visualLine.logicalLine,
			col:
				visualLine.startCol +
				columnToStringIndex(visualText, textColumn, editor.segment(visualText, "grapheme")),
		};
	}

	private handleMouse(event: MouseEvent): void {
		if (event.wheel) {
			this.setSelectionMode(false);
			return;
		}
		if (event.button !== 0 && !event.release) return;

		if (event.release) {
			if (this.dragging) {
				const position = this.positionFromMouse(event);
				if (position) {
					this.focus = position;
					this.setCursorPosition(position);
				}
				this.dragging = false;
				void this.copySelection();
			}
			this.setSelectionMode(false);
			return;
		}

		const position = this.positionFromMouse(event);
		if (!position) {
			this.clearSelection();
			this.setSelectionMode(false);
			return;
		}

		if (event.drag) {
			if (!this.dragging || !this.anchor) return;
			this.focus = position;
			this.setCursorPosition(position);
			return;
		}

		this.anchor = position;
		this.focus = position;
		this.dragging = true;
		this.setCursorPosition(position);
	}

	private selectedText(): string | undefined {
		const selection = this.selection;
		if (!selection) return undefined;

		const lines = this.internals.state.lines;
		const [start, end] = selection;
		const text = lines.join("\n");
		return text.slice(positionToOffset(lines, start), positionToOffset(lines, end));
	}

	private copySelection(): Promise<void> {
		const text = this.selectedText();
		if (!text) return Promise.resolve();
		return copyToClipboard(text).catch(() => undefined);
	}

	private deleteSelection(): boolean {
		const selection = this.selection;
		if (!selection) return false;

		const editor = this.internals;
		const [start, end] = selection;
		const text = editor.state.lines.join("\n");
		const startOffset = positionToOffset(editor.state.lines, start);
		const endOffset = positionToOffset(editor.state.lines, end);
		const nextText = text.slice(0, startOffset) + text.slice(endOffset);

		editor.pushUndoSnapshot();
		editor.cancelAutocomplete();
		editor.exitHistoryBrowsing();
		editor.state.lines = nextText.split("\n");
		editor.state.cursorLine = start.line;
		editor.setCursorCol(start.col);
		editor.lastAction = null;
		editor.preferredVisualCol = null;
		editor.snappedFromCursorCol = null;
		this.clearSelection();
		this.onChange?.(this.getText());
		return true;
	}

	private selectAll(): void {
		const lines = this.internals.state.lines;
		this.anchor = { line: 0, col: 0 };
		this.focus = { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 };
		this.setCursorPosition(this.focus);
	}

	private extendSelection(data: string): boolean {
		const movement = [
			["shift+left", "\x1b[D"],
			["shift+right", "\x1b[C"],
			["shift+up", "\x1b[A"],
			["shift+down", "\x1b[B"],
			["shift+home", "\x1b[H"],
			["shift+end", "\x1b[F"],
		] as const;

		for (const [modifiedKey, plainKey] of movement) {
			if (!matchesKey(data, modifiedKey)) continue;
			this.anchor ??= this.getCursor();
			super.handleInput(plainKey);
			this.focus = this.getCursor();
			return true;
		}
		return false;
	}

	private replacesSelection(data: string): boolean {
		if (data.includes("\x1b[200~")) return true;
		const printable = decodeKittyPrintable(data);
		return printable !== undefined || (data.length === 1 && data.charCodeAt(0) >= 32);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+a")) {
			this.setSelectionMode(!this.selectionModeArmed);
			return;
		}

		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (!this.selectionModeArmed) return;
			this.handleMouse(mouse);
			return;
		}

		if (this.selectionModeArmed) {
			this.setSelectionMode(false);
			if (matchesKey(data, "escape")) return;
		}

		if (matchesKey(data, "ctrl+c") || matchesKey(data, "super+c")) {
			if (this.selection) {
				void this.copySelection();
				return;
			}
		}

		if (matchesKey(data, "ctrl+a") || matchesKey(data, "super+a")) {
			this.selectAll();
			return;
		}

		if (this.extendSelection(data)) return;

		if (
			matchesKey(data, "backspace") ||
			matchesKey(data, "delete") ||
			matchesKey(data, "shift+backspace") ||
			matchesKey(data, "shift+delete") ||
			matchesKey(data, "ctrl+d")
		) {
			if (this.deleteSelection()) return;
		}

		if (this.selection && this.replacesSelection(data)) {
			this.deleteSelection();
		}

		const selection = this.selection;
		const movesWithoutExtending =
			matchesKey(data, "left") ||
			matchesKey(data, "right") ||
			matchesKey(data, "up") ||
			matchesKey(data, "down");
		if (selection && movesWithoutExtending) {
			const [start, end] = selection;
			this.setCursorPosition(matchesKey(data, "left") || matchesKey(data, "up") ? start : end);
			this.clearSelection();
			return;
		}

		if (this.appKeybindings.matches(data, "app.suspend") || this.appKeybindings.matches(data, "app.editor.external")) {
			this.setSelectionMode(false);
		}

		this.clearSelection();
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		if (cursorRow >= 0) this.lastCursorRenderRow = cursorRow;

		const editor = this.internals;
		const visualLines = editor.buildVisualLineMap(editor.lastWidth);
		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		this.visibleTextLineCount = Math.max(
			1,
			Math.min(visualLines.length - editor.scrollOffset, maxVisibleLines),
		);
		const selection = this.selection;
		if (!selection) return lines;

		const [start, end] = selection;
		for (let visibleRow = 0; visibleRow < this.visibleTextLineCount; visibleRow++) {
			const visualLine = visualLines[editor.scrollOffset + visibleRow];
			if (!visualLine) continue;

			const segmentStart = { line: visualLine.logicalLine, col: visualLine.startCol };
			const segmentEnd = { line: visualLine.logicalLine, col: visualLine.startCol + visualLine.length };
			if (comparePositions(end, segmentStart) <= 0 || comparePositions(start, segmentEnd) >= 0) continue;

			const logicalText = editor.state.lines[visualLine.logicalLine] ?? "";
			const selectedStart = Math.max(
				visualLine.startCol,
				start.line === visualLine.logicalLine ? start.col : visualLine.startCol,
			);
			const selectedEnd = Math.min(
				visualLine.startCol + visualLine.length,
				end.line === visualLine.logicalLine ? end.col : visualLine.startCol + visualLine.length,
			);
			const startColumn = editor.paddingX + visibleWidth(logicalText.slice(visualLine.startCol, selectedStart));
			const endColumn = editor.paddingX + visibleWidth(logicalText.slice(visualLine.startCol, selectedEnd));
			lines[visibleRow + 1] = highlightColumns(lines[visibleRow + 1] ?? "", startColumn, endColumn);
		}
		return lines;
	}
}

let mouseEnabled = false;

function enableMouse(): void {
	if (mouseEnabled || !process.stdout.isTTY) return;
	process.stdout.write(process.env.PI_FIXED_LAYOUT_ACTIVE === "1" ? ENABLE_DRAG_MOUSE : ENABLE_MOUSE);
	mouseEnabled = true;
}

function disableMouse(): void {
	if (!mouseEnabled || !process.stdout.isTTY) return;
	process.stdout.write(process.env.PI_FIXED_LAYOUT_ACTIVE === "1" ? DISABLE_DRAG_MOUSE : DISABLE_MOUSE);
	mouseEnabled = false;
}

export default function mouseTextSelection(pi: ExtensionAPI): void {
	let editor: MouseSelectionEditor | undefined;
	let editorTui: TUI | undefined;
	let unsubscribeInput: (() => void) | undefined;
	const onExit = (): void => disableMouse();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editorTui = tui;
			editor = new MouseSelectionEditor(tui, theme, keybindings, (armed) => {
				ctx.ui.setStatus("mouse-selection", armed ? "mouse selection: drag once (Esc cancels)" : undefined);
			});
			return editor;
		});

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!MOUSE_EVENT.test(data)) return undefined;
			const mouse = parseMouseEvent(data);
			if (mouse?.wheel) {
				editor?.cancelMouseSelectionMode();
				return undefined;
			}
			const focused = editor && editorTui
				? (editorTui as unknown as TuiInternals).focusedComponent === editor
				: false;
			if (!focused) editor?.cancelMouseSelectionMode();
			return focused && editor?.isMouseSelectionModeArmed() ? undefined : { consume: true };
		});

		process.once("exit", onExit);
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		process.off("exit", onExit);
		disableMouse();
		editor = undefined;
		editorTui = undefined;
	});
}
