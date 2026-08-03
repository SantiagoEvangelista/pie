import { execFile } from "node:child_process";
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
	type FrameHighlightRange,
	type FrameLinkSpan,
	type FrameSnapshot,
	type TUI,
} from "@earendil-works/pi-tui";

const MOUSE_EVENT = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const MOUSE_EVENTS = /\x1b\[<\d+;\d+;\d+[Mm]/g;
const INCOMPLETE_MOUSE_SUFFIX = /\x1b\[<\d*(?:;\d*){0,2}$/;
const DRAG_THRESHOLD = 2;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SELECT_START = "\x1b[7m";
const SELECT_END = "\x1b[27m";

type Position = { line: number; col: number };
type FramePosition = { row: number; col: number };
type VisualLine = { logicalLine: number; startCol: number; length: number };
export type MouseEvent = {
	rawCode: number;
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
	setCursorCol(col: number): void;
}

interface TuiInternals {
	focusedComponent: unknown;
	hardwareCursorRow: number;
	previousViewportTop: number;
}

export interface MouseSelectionDependencies {
	copy(text: string): Promise<void>;
	open(href: string): Promise<void>;
}

interface ActiveGesture {
	readonly snapshot: FrameSnapshot;
	readonly anchor: FramePosition;
	readonly pressX: number;
	readonly pressY: number;
	readonly link?: FrameLinkSpan;
	focus: FramePosition;
	dragged: boolean;
	clickCancelled: boolean;
}

function parseMouseEvent(data: string): MouseEvent | undefined {
	const match = data.match(MOUSE_EVENT);
	if (!match) return undefined;

	const code = Number(match[1]);
	return {
		rawCode: code,
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

function columnToStringIndex(text: string, visualColumn: number): number {
	if (visualColumn <= 0) return 0;
	let width = 0;
	for (const { segment, index } of graphemeSegmenter.segment(text)) {
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
	let text = markerIndex >= 0
		? line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length)
		: line;
	// Base editor draws a fake inverse cursor immediately after marker. Selection
	// supplies its own inverse range; retaining both makes ANSI slicing carry the
	// cursor style across all right-side padding.
	if (markerIndex >= 0 && text.startsWith(SELECT_START, markerIndex)) {
		text = text.slice(0, markerIndex) + text.slice(markerIndex + SELECT_START.length);
	}
	const width = visibleWidth(text);
	let before = sliceByColumn(text, 0, start, true);
	let selected = sliceByColumn(text, start, end - start, true).replaceAll(
		"\x1b[0m",
		`\x1b[0m${SELECT_START}`,
	);
	let after = sliceByColumn(text, end, Math.max(0, width - end), true);
	if (markerColumn !== undefined) {
		const insertMarker = (segment: string, column: number): string => {
			const segmentWidth = visibleWidth(segment);
			const offset = Math.max(0, Math.min(segmentWidth, column));
			return (
				sliceByColumn(segment, 0, offset, true) +
				CURSOR_MARKER +
				sliceByColumn(segment, offset, segmentWidth - offset, true)
			);
		};
		if (markerColumn <= start) before = insertMarker(before, markerColumn);
		else if (markerColumn < end) selected = insertMarker(selected, markerColumn - start);
		else after = insertMarker(after, markerColumn - end);
	}
	return `${before}${SELECT_START}${selected}${SELECT_END}${after}${SELECT_END}`;
}

function isPrimary(event: MouseEvent): boolean {
	return !event.wheel && (event.rawCode === 0 || event.rawCode === 32);
}

function visibleTranscriptRows(snapshot: FrameSnapshot): number[] {
	return snapshot.transcriptRows
		.map(({ row }) => row)
		.filter((row) => row >= snapshot.viewportTop && row < snapshot.viewportBottom && row < snapshot.lines.length)
		.sort((a, b) => a - b);
}

function framePosition(snapshot: FrameSnapshot, event: MouseEvent, clamp: boolean): FramePosition | undefined {
	const rows = visibleTranscriptRows(snapshot);
	if (rows.length === 0) return undefined;

	const requestedRow = snapshot.viewportTop + event.y;
	let row = requestedRow;
	if (!rows.includes(row)) {
		if (!clamp) return undefined;
		row = rows.reduce((nearest, candidate) =>
			Math.abs(candidate - requestedRow) < Math.abs(nearest - requestedRow) ? candidate : nearest,
		);
	}
	const width = visibleWidth(snapshot.lines[row] ?? "");
	return { row, col: Math.max(0, Math.min(width, event.x)) };
}

function linkAt(snapshot: FrameSnapshot, event: MouseEvent): FrameLinkSpan | undefined {
	const position = framePosition(snapshot, event, false);
	if (!position) return undefined;
	return snapshot.linkSpans.find(
		(span) => span.row === position.row && position.col >= span.startColumn && position.col < span.endColumn,
	);
}

function sameLink(a: FrameLinkSpan | undefined, b: FrameLinkSpan | undefined): a is FrameLinkSpan {
	return Boolean(
		a && b && a.row === b.row && a.startColumn === b.startColumn && a.endColumn === b.endColumn && a.href === b.href,
	);
}

function snapRangeToGraphemes(line: string, start: number, end: number): [number, number] {
	const plain = stripTerminalSequences(line);
	let snappedStart = start;
	let snappedEnd = end;
	let column = 0;
	for (const { segment } of graphemeSegmenter.segment(plain)) {
		const next = column + visibleWidth(segment);
		if (snappedStart > column && snappedStart < next) snappedStart = column;
		if (snappedEnd > column && snappedEnd < next) snappedEnd = next;
		column = next;
	}
	return [snappedStart, snappedEnd];
}

function subtractPadding(
	snapshot: FrameSnapshot,
	row: number,
	startColumn: number,
	endColumn: number,
): Array<{ startColumn: number; endColumn: number }> {
	let ranges = [{ startColumn, endColumn }];
	for (const padding of snapshot.generatedPadding.filter((entry) => entry.row === row)) {
		const next: typeof ranges = [];
		for (const range of ranges) {
			if (padding.endColumn <= range.startColumn || padding.startColumn >= range.endColumn) {
				next.push(range);
				continue;
			}
			if (padding.startColumn > range.startColumn) {
				next.push({ startColumn: range.startColumn, endColumn: Math.min(padding.startColumn, range.endColumn) });
			}
			if (padding.endColumn < range.endColumn) {
				next.push({ startColumn: Math.max(padding.endColumn, range.startColumn), endColumn: range.endColumn });
			}
		}
		ranges = next;
	}
	return ranges.filter((range) => range.endColumn > range.startColumn);
}

function selectionRanges(snapshot: FrameSnapshot, a: FramePosition, b: FramePosition): FrameHighlightRange[] {
	const [start, end] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
	const transcriptRows = visibleTranscriptRows(snapshot).filter((row) => row >= start.row && row <= end.row);
	const ranges: FrameHighlightRange[] = [];
	for (const row of transcriptRows) {
		const line = snapshot.lines[row] ?? "";
		const lineWidth = visibleWidth(line);
		const requestedStart = row === start.row ? start.col : 0;
		const requestedEnd = row === end.row ? end.col : lineWidth;
		const [rangeStart, rangeEnd] = snapRangeToGraphemes(line, requestedStart, requestedEnd);
		for (const range of subtractPadding(snapshot, row, rangeStart, rangeEnd)) {
			ranges.push({ row, ...range });
		}
	}
	return ranges;
}

function controlStringLength(value: string, index: number, allowBel: boolean): number {
	for (let cursor = index; cursor < value.length; cursor++) {
		const code = value.charCodeAt(cursor);
		if (allowBel && code === 0x07) return cursor + 1 - index;
		if (code === 0x9c) return cursor + 1 - index;
		if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c) return cursor + 2 - index;
	}
	return value.length - index;
}

function terminalSequenceLength(value: string, index: number): number {
	const code = value.charCodeAt(index);
	if (code === 0x1b) {
		const next = value.charCodeAt(index + 1);
		if (next === 0x5b) {
			let cursor = index + 2;
			while (cursor < value.length && !(value.charCodeAt(cursor) >= 0x40 && value.charCodeAt(cursor) <= 0x7e)) cursor++;
			return Math.min(value.length - index, cursor + 1 - index);
		}
		if (next === 0x5d) return Math.min(value.length - index, 2 + controlStringLength(value, index + 2, true));
		if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
			return Math.min(value.length - index, 2 + controlStringLength(value, index + 2, false));
		}
		return Math.min(2, value.length - index);
	}
	if (code === 0x9b) {
		let cursor = index + 1;
		while (cursor < value.length && !(value.charCodeAt(cursor) >= 0x40 && value.charCodeAt(cursor) <= 0x7e)) cursor++;
		return Math.min(value.length - index, cursor + 1 - index);
	}
	if (code === 0x9d) return 1 + controlStringLength(value, index + 1, true);
	if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
		return 1 + controlStringLength(value, index + 1, false);
	}
	return 0;
}

export function stripTerminalSequences(value: string): string {
	let output = "";
	for (let index = 0; index < value.length;) {
		const code = value.charCodeAt(index);
		const sequenceLength = terminalSequenceLength(value, index);
		if (sequenceLength > 0) {
			index += sequenceLength;
			continue;
		}
		if ((code >= 0 && code < 0x20) || (code >= 0x7f && code <= 0x9f)) {
			index++;
			continue;
		}
		output += value[index++];
	}
	return output;
}

function selectedText(
	snapshot: FrameSnapshot,
	ranges: readonly FrameHighlightRange[],
	a: FramePosition,
	b: FramePosition,
): string {
	const byRow = new Map<number, FrameHighlightRange[]>();
	for (const range of ranges) {
		const rowRanges = byRow.get(range.row) ?? [];
		rowRanges.push(range);
		byRow.set(range.row, rowRanges);
	}
	const [start, end] = a.row <= b.row ? [a, b] : [b, a];
	return visibleTranscriptRows(snapshot)
		.filter((row) => row >= start.row && row <= end.row)
		.map((row) => (byRow.get(row) ?? [])
			.sort((a, b) => a.startColumn - b.startColumn)
			.map((range) => stripTerminalSequences(
				sliceByColumn(snapshot.lines[row] ?? "", range.startColumn, range.endColumn - range.startColumn),
			))
			.join(""))
		.join("\n");
}

export function normalizeHttpHref(href: string): string | undefined {
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(href)) return undefined;
	try {
		if (/[\u0000-\u001f\u007f-\u009f]/u.test(decodeURIComponent(href))) return undefined;
		const parsed = new URL(href);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password
		) return undefined;
		return parsed.href;
	} catch {
		return undefined;
	}
}

function productionOpen(href: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/open", [href], { shell: false }, (error) => error ? reject(error) : resolve());
	});
}

export class TranscriptSelectionController {
	private active?: ActiveGesture;
	private highlightedRevision?: number;

	constructor(
		private readonly tui: TUI,
		private readonly dependencies: MouseSelectionDependencies,
	) {}

	private stopMotion(): void {
		this.tui.setMouseMotionTracking(false);
	}

	clear(): void {
		this.active = undefined;
		this.highlightedRevision = undefined;
		this.stopMotion();
		this.tui.clearFrameHighlights();
	}

	reconcile(available: boolean): void {
		const snapshot = this.tui.getFrameSnapshot();
		const revision = this.active?.snapshot.revision ?? this.highlightedRevision;
		if (
			!available || !snapshot || snapshot.width !== this.tui.terminal.columns || snapshot.height !== this.tui.terminal.rows ||
			(revision !== undefined && snapshot.revision !== revision)
		) this.clear();
	}

	handle(event: MouseEvent): boolean {
		if (event.wheel) {
			this.clear();
			return false;
		}

		const current = this.tui.getFrameSnapshot();
		if (
			!current || current.width !== this.tui.terminal.columns || current.height !== this.tui.terminal.rows ||
			(this.active && current.revision !== this.active.snapshot.revision)
		) {
			this.clear();
			return false;
		}

		if (!isPrimary(event)) {
			if (this.active || (!event.release && !event.drag)) this.clear();
			return false;
		}
		if (this.active && isPrimary(event) && !event.release && !event.drag) this.clear();
		if (this.active) return this.handleActive(event);
		if (event.release || event.drag) return false;

		this.clear();
		const anchor = framePosition(current, event, false);
		if (!anchor) return false;
		this.active = {
			snapshot: current,
			anchor,
			focus: anchor,
			pressX: event.x,
			pressY: event.y,
			link: linkAt(current, event),
			dragged: false,
			clickCancelled: false,
		};
		this.tui.setMouseMotionTracking(true);
		return true;
	}

	private handleActive(event: MouseEvent): boolean {
		const gesture = this.active;
		if (!gesture || !isPrimary(event) || (!event.drag && !event.release)) return false;

		if (event.drag) gesture.clickCancelled = true;
		const distance = Math.max(Math.abs(event.x - gesture.pressX), Math.abs(event.y - gesture.pressY));
		if (distance >= DRAG_THRESHOLD) gesture.dragged = true;
		if (gesture.dragged) {
			const focus = framePosition(gesture.snapshot, event, true);
			if (focus) gesture.focus = focus;
			const ranges = selectionRanges(gesture.snapshot, gesture.anchor, gesture.focus);
			if (!this.tui.setFrameHighlights(gesture.snapshot.revision, ranges)) {
				this.clear();
				return true;
			}
			this.highlightedRevision = gesture.snapshot.revision;
		}

		if (!event.release) return true;
		try {
			this.active = undefined;
			if (gesture.dragged) {
				const ranges = selectionRanges(gesture.snapshot, gesture.anchor, gesture.focus);
				const text = selectedText(gesture.snapshot, ranges, gesture.anchor, gesture.focus);
				if (text.length > 0) void this.dependencies.copy(text).catch(() => undefined);
			} else {
				this.highlightedRevision = undefined;
				this.tui.clearFrameHighlights();
				if (!gesture.clickCancelled) {
					const releasedLink = linkAt(gesture.snapshot, event);
					if (sameLink(gesture.link, releasedLink)) {
						const href = normalizeHttpHref(gesture.link.href);
						if (href) void this.dependencies.open(href).catch(() => undefined);
					}
				}
			}
		} finally {
			this.stopMotion();
		}
		return true;
	}
}

export class MousePacketBuffer {
	private buffered = "";

	feed(data: string, handle: (event: MouseEvent) => boolean): string {
		const input = this.buffered + data;
		this.buffered = "";
		let output = "";
		let offset = 0;
		MOUSE_EVENTS.lastIndex = 0;
		for (let match = MOUSE_EVENTS.exec(input); match; match = MOUSE_EVENTS.exec(input)) {
			output += input.slice(offset, match.index);
			const event = parseMouseEvent(match[0]);
			if (!event || !handle(event)) output += match[0];
			offset = match.index + match[0].length;
		}
		output += input.slice(offset);

		const incomplete = output.match(INCOMPLETE_MOUSE_SUFFIX);
		if (incomplete?.index !== undefined && incomplete[0].length < 64) {
			this.buffered = incomplete[0];
			output = output.slice(0, incomplete.index);
		}
		return output;
	}

	clear(): void {
		this.buffered = "";
	}
}

export class MouseSelectionEditor extends CustomEditor {
	private anchor?: Position;
	private focus?: Position;
	private pointerDragging = false;
	private lastCursorRenderRow = 1;
	private visibleTextLineCount = 1;
	private readonly appKeybindings: KeybindingsManager;
	private readonly reconcilePointerSelection: () => void;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		reconcilePointerSelection: () => void,
	) {
		super(tui, theme, keybindings);
		this.appKeybindings = keybindings;
		this.reconcilePointerSelection = reconcilePointerSelection;
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
	}

	private positionFromMouse(event: MouseEvent): Position | undefined {
		const editor = this.internals;
		const tui = this.tui as unknown as TuiInternals;
		const cursorScreenRow = tui.hardwareCursorRow - tui.previousViewportTop;
		const editorTopRow = cursorScreenRow - this.lastCursorRenderRow;
		const localRow = event.y - editorTopRow;
		const visualLines = editor.buildVisualLineMap(editor.lastWidth);
		let visualLineIndex = editor.scrollOffset + localRow - 1;
		if (this.pointerDragging && localRow < 1) visualLineIndex = editor.scrollOffset - 1;
		if (this.pointerDragging && localRow > this.visibleTextLineCount) {
			visualLineIndex = editor.scrollOffset + this.visibleTextLineCount;
		}
		visualLineIndex = Math.max(0, Math.min(visualLineIndex, visualLines.length - 1));
		const visualLine = visualLines[visualLineIndex];
		if (
			!visualLine ||
			(localRow < 1 && !this.pointerDragging) ||
			(localRow > this.visibleTextLineCount && !this.pointerDragging)
		) return undefined;

		const logicalText = editor.state.lines[visualLine.logicalLine] ?? "";
		const visualText = logicalText.slice(visualLine.startCol, visualLine.startCol + visualLine.length);
		const textColumn = Math.max(0, event.x - editor.paddingX);
		return {
			line: visualLine.logicalLine,
			col: visualLine.startCol + columnToStringIndex(visualText, textColumn),
		};
	}

	handlePointerMouse(event: MouseEvent): boolean {
		if (event.wheel) {
			if (this.pointerDragging) this.cancelPointerGesture();
			return false;
		}
		if (!isPrimary(event)) return false;

		if (event.release) {
			if (!this.pointerDragging) return false;
			const position = this.positionFromMouse(event);
			if (position) {
				this.focus = position;
				this.setCursorPosition(position);
			}
			this.pointerDragging = false;
			this.tui.setMouseMotionTracking(false);
			void this.copySelection();
			return true;
		}

		if (event.drag) {
			if (!this.pointerDragging || !this.anchor) return false;
			const position = this.positionFromMouse(event);
			if (position) {
				this.focus = position;
				this.setCursorPosition(position);
			}
			return true;
		}

		const position = this.positionFromMouse(event);
		if (!position) return false;
		this.clearSelection();
		this.anchor = position;
		this.focus = position;
		this.pointerDragging = true;
		this.setCursorPosition(position);
		this.tui.setMouseMotionTracking(true);
		return true;
	}

	cancelPointerGesture(): void {
		this.pointerDragging = false;
		this.tui.setMouseMotionTracking(false);
	}

	private setCursorPosition(position: Position): void {
		const editor = this.internals;
		const line = Math.max(0, Math.min(position.line, editor.state.lines.length - 1));
		const col = Math.max(0, Math.min(position.col, editor.state.lines[line]?.length ?? 0));
		editor.state.cursorLine = line;
		editor.setCursorCol(col);
		editor.snappedFromCursorCol = null;
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
		editor.pushUndoSnapshot();
		editor.cancelAutocomplete();
		editor.exitHistoryBrowsing();
		editor.state.lines = (text.slice(0, startOffset) + text.slice(endOffset)).split("\n");
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
		if (this.pointerDragging) this.cancelPointerGesture();
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "super+c")) {
			if (this.selection) {
				void this.copySelection();
				return;
			}
		}
		if (matchesKey(data, "super+a")) {
			this.selectAll();
			return;
		}
		if (this.extendSelection(data)) return;
		if (
			matchesKey(data, "backspace") || matchesKey(data, "delete") ||
			matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete") || matchesKey(data, "ctrl+d")
		) {
			if (this.deleteSelection()) return;
		}
		if (this.selection && this.replacesSelection(data)) this.deleteSelection();
		const selection = this.selection;
		const movesWithoutExtending =
			matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "up") || matchesKey(data, "down");
		if (selection && movesWithoutExtending) {
			const [start, end] = selection;
			this.setCursorPosition(matchesKey(data, "left") || matchesKey(data, "up") ? start : end);
			this.clearSelection();
			return;
		}
		if (this.appKeybindings.matches(data, "app.suspend") || this.appKeybindings.matches(data, "app.editor.external")) {
			this.reconcilePointerSelection();
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
		this.visibleTextLineCount = Math.max(
			1,
			Math.min(
				visualLines.length - editor.scrollOffset,
				Math.max(5, Math.floor(this.tui.terminal.rows * 0.3)),
			),
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

export default function mouseTextSelection(pi: ExtensionAPI): void {
	let editor: MouseSelectionEditor | undefined;
	let editorTui: TUI | undefined;
	let controller: TranscriptSelectionController | undefined;
	let unsubscribeInput: (() => void) | undefined;
	const packets = new MousePacketBuffer();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editorTui = tui;
			controller = new TranscriptSelectionController(tui, {
				copy: copyToClipboard,
				open: productionOpen,
			});
			const reconcile = () => {
				const focused = (tui as unknown as TuiInternals).focusedComponent === editor;
				controller?.reconcile(focused && !tui.hasOverlay());
			};
			editor = new MouseSelectionEditor(tui, theme, keybindings, reconcile);
			return editor;
		});

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const focused = Boolean(
				editor && editorTui && (editorTui as unknown as TuiInternals).focusedComponent === editor && !editorTui.hasOverlay(),
			);
			controller?.reconcile(focused);
			const delegated = packets.feed(data, (event) => {
				if (!focused) return false;
				const handled = controller?.handle(event) ?? false;
				if (handled) return true;
				return editor?.handlePointerMouse(event) || !event.wheel;
			});
			MOUSE_EVENTS.lastIndex = 0;
			if (delegated.replace(MOUSE_EVENTS, "").length > 0) controller?.clear();
			if (delegated === data) return undefined;
			return delegated.length === 0 ? { consume: true } : { data: delegated };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		packets.clear();
		controller?.clear();
		editor?.cancelPointerGesture();
		controller = undefined;
		editor = undefined;
		editorTui = undefined;
	});
}
