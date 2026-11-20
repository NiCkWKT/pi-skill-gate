import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	getSelectPageIndex,
	Key,
	matchesKey,
	replaceControlCharacters,
	truncateToWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	allowedNames,
	readGate,
	resetCwd,
	retainedNames,
	saveSelection,
	statePath,
	type GateState,
	type MutationResult,
} from "./store.ts";

let warnedUnreadable = false;
let warnedInvalidValue = false;

interface SkillRow {
	name: string;
	scope: string;
	filePath: string;
	checked: boolean;
}

type ChecklistResult = { action: "cancel" } | { action: "save"; checkedNames: string[] };

export default function skillGate(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const state = readGate(getAgentDir(), ctx.cwd);
		const names = allowedNames(state);
		if (names) {
			event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) =>
				names.includes(skill.name),
			);
		}
		warnIfNeeded(ctx, state);
	});

	pi.registerCommand("skills", {
		description: "Choose which skill descriptions this directory shows",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim();
			const state = readGate(getAgentDir(), ctx.cwd);
			warnIfNeeded(ctx, state);

			if (command === "") {
				if (ctx.mode === "tui") {
					await openChecklist(ctx, state);
					return;
				}
				if (ctx.hasUI) notifyChoice(ctx, state);
				return;
			}

			if (command === "reset") {
				notifyMutation(ctx, resetCwd(getAgentDir(), ctx.cwd), "reset");
				return;
			}

			notify(ctx, "Usage: /skills or /skills reset", "info");
		},
	});
}

function warnIfNeeded(ctx: ExtensionContext, state: GateState): void {
	if (state.file.kind === "unreadable" && !warnedUnreadable) {
		const path = statePath(getAgentDir());
		if (
			notify(
				ctx,
				`Could not read ${path} (${state.file.error}). Showing every skill. The file was left unchanged.`,
				"warning",
			)
		) {
			warnedUnreadable = true;
		}
	}
	if (state.file.kind === "ok" && state.cwdValue.kind === "invalid" && !warnedInvalidValue) {
		if (
			notify(
				ctx,
				"skill-gates.json has a non-array value for this directory. Showing every skill.",
				"warning",
			)
		) {
			warnedInvalidValue = true;
		}
	}
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error",
): boolean {
	try {
		ctx.ui.notify(message, type);
		return true;
	} catch {
		// A notification failure must not skip the prompt filter or throw out of the handler.
		return false;
	}
}

function notifyChoice(ctx: ExtensionCommandContext, state: GateState): void {
	const names = allowedNames(state);
	if (!names) {
		notify(ctx, "Current choice: all skills", "info");
		return;
	}
	notify(ctx, names.length === 0 ? "Current choice: (no names)" : `Current choice: ${names.join(", ")}`, "info");
}

function notifyMutation(ctx: ExtensionCommandContext, result: MutationResult, action: "save" | "reset"): void {
	if (!result.ok) {
		notify(
			ctx,
			result.reason === "unreadable"
				? "skill-gates.json was left unchanged."
				: `Could not save skill-gates.json (${result.error}). The previous file was left in place.`,
			result.reason === "unreadable" ? "warning" : "error",
		);
		return;
	}
	if (action === "reset") {
		notify(ctx, "This directory shows every skill.", "info");
		return;
	}
	notify(
		ctx,
		"Saved. A new session records only the checked descriptions. This extension does not rewrite an open conversation.",
		"info",
	);
}

async function openChecklist(ctx: ExtensionCommandContext, state: GateState): Promise<void> {
	const skills = ctx.getSystemPromptOptions().skills ?? [];
	// Include hidden skills in the save list so Enter drops them instead of retaining them.
	const rowNames = skills.map((skill) => skill.name);
	const names = allowedNames(state);
	const rows: SkillRow[] = skills
		.filter((skill) => !skill.disableModelInvocation)
		.map((skill) => ({
			name: skill.name,
			scope: skill.sourceInfo.scope,
			filePath: skill.filePath,
			checked: names ? names.includes(skill.name) : true,
		}));
	const retained = retainedNames(names, rowNames).length;
	const notice = checklistNotice(state);

	const result = await ctx.ui.custom<ChecklistResult>(
		(tui, theme, keybindings, done) => createChecklist(tui, theme, keybindings, done, rows, retained, notice),
		{ blocked: { kind: "question", message: "Choose skills" } },
	);
	if (result?.action !== "save") return;

	notifyMutation(ctx, saveSelection(getAgentDir(), ctx.cwd, result.checkedNames, rowNames), "save");
}

function checklistNotice(state: GateState): { text: string; tone: "warning" | "muted" } | undefined {
	if (state.file.kind === "unreadable") return { text: "Enter will not change the file.", tone: "warning" };
	if (!allowedNames(state)) {
		return { text: "Enter saves this list. Skills installed later stay out until checked.", tone: "muted" };
	}
	return undefined;
}

function createChecklist(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: ChecklistResult) => void,
	rows: SkillRow[],
	retained: number,
	notice: { text: string; tone: "warning" | "muted" } | undefined,
): Component {
	let cursor = 0;
	let scroll = 0;
	let closed = false;

	const finish = (result: ChecklistResult) => {
		if (closed) return;
		closed = true;
		done(result);
	};

	const visibleCount = () => visibleSkillRows(tui.terminal.rows, rows.length, notice === undefined ? 0 : 1);

	const reveal = () => {
		const visible = visibleCount();
		if (rows.length <= visible) {
			scroll = 0;
			return visible;
		}
		if (cursor < scroll) scroll = cursor;
		if (cursor >= scroll + visible) scroll = cursor - visible + 1;
		scroll = Math.max(0, Math.min(scroll, rows.length - visible));
		return visible;
	};

	const moveCursor = (next: number) => {
		if (rows.length === 0) return;
		cursor = Math.max(0, Math.min(rows.length - 1, next));
		tui.requestRender();
	};

	return {
		capturesViewportInput: true,
		invalidate() {},
		render(width: number) {
			const visible = reveal();
			const end = Math.min(rows.length, scroll + visible);
			const lines = [
				theme.fg("accent", "Skills"),
				theme.fg("muted", `Keeping ${retained} saved ${retained === 1 ? "name" : "names"} not in this list.`),
			];
			if (notice) lines.push(theme.fg(notice.tone, notice.text));
			let cursorLine = -1;
			if (rows.length === 0) {
				cursorLine = lines.length;
				lines.push(theme.fg("dim", "(no skills)"));
			} else {
				for (let index = scroll; index < end; index++) {
					if (index === cursor) cursorLine = lines.length;
					lines.push(renderRow(theme, rows[index]!, index === cursor));
				}
				if (rows.length > visible) {
					lines.push(theme.fg("dim", `${scroll + 1}-${end} of ${rows.length}`));
				}
			}
			lines.push(theme.fg("dim", hintLine(keybindings)));
			return lines.map((line, index) => {
				const clipped = truncateToWidth(line, width);
				// The editor dock clips this component and only follows CURSOR_MARKER.
				return index === cursorLine ? CURSOR_MARKER + clipped : clipped;
			});
		},
		handleInput(data: string) {
			if (closed) return;
			if (keybindings.matches(data, "tui.select.up")) {
				moveCursor(cursor - 1);
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				moveCursor(cursor + 1);
				return;
			}
			const pageIndex = getSelectPageIndex(keybindings, data, cursor, rows.length, visibleCount());
			if (pageIndex !== undefined && rows.length > 0) {
				moveCursor(pageIndex);
				return;
			}
			if (matchesKey(data, Key.space)) {
				const row = rows[cursor];
				if (!row) return;
				row.checked = !row.checked;
				tui.requestRender();
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				finish({
					action: "save",
					checkedNames: rows.filter((row) => row.checked).map((row) => row.name),
				});
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) finish({ action: "cancel" });
		},
	};
}

function visibleSkillRows(terminalRows: number, rowCount: number, extraLines: number): number {
	if (rowCount === 0) return 1;
	// Title, retained count, the range line, and the hint sit outside the rows.
	// Leave a row for Pi's footer. A short dock still clips; the cursor marker covers that.
	const chrome = 4 + extraLines;
	const room = Math.max(1, Math.floor(terminalRows) - chrome - 1);
	return Math.min(rowCount, 8, room);
}

function renderRow(theme: Theme, row: SkillRow, selected: boolean): string {
	const mark = row.checked ? "[x]" : "[ ]";
	const text = replaceControlCharacters(
		`${selected ? ">" : " "} ${mark} ${row.name}  ${row.scope}  ${row.filePath}`,
	);
	if (selected) return theme.fg("accent", text);
	if (!row.checked) return theme.fg("dim", text);
	return text;
}

function hintLine(keybindings: KeybindingsManager): string {
	const up = keys(keybindings, "tui.select.up");
	const down = keys(keybindings, "tui.select.down");
	const confirm = keys(keybindings, "tui.select.confirm");
	const cancel = keys(keybindings, "tui.select.cancel");
	return `${up}/${down} move  space toggle  ${confirm} save  ${cancel} close`;
}

function keys(keybindings: KeybindingsManager, id: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string {
	const bound = keybindings.getKeys(id);
	return bound.length > 0 ? bound.join("/") : id;
}
