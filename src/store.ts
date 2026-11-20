import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync, type PathLike } from "node:fs";
import { join } from "node:path";

export const STATE_FILENAME = "skill-gates.json";

/** Filesystem operations for the state file. Tests replace `renameSync` to count the temp rename. */
export const files = {
	readFileSync(path: PathLike): string {
		return readFileSync(path, "utf8");
	},
	writeFileSync(path: PathLike, data: string): void {
		writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
	},
	renameSync,
	unlinkSync,
};

export function statePath(agentDir: string): string {
	return join(agentDir, STATE_FILENAME);
}

export type FileState =
	| { kind: "missing" }
	| { kind: "unreadable"; error: string }
	| { kind: "ok"; data: Record<string, unknown> };

export type CwdValue =
	| { kind: "missing" }
	| { kind: "invalid" }
	| { kind: "names"; names: string[] };

export interface GateState {
	file: FileState;
	cwdValue: CwdValue;
}

export type MutationResult =
	| { ok: true; wrote: boolean }
	| { ok: false; reason: "unreadable" | "write-failed"; error: string };

export function readGate(agentDir: string, cwd: string): GateState {
	const path = statePath(agentDir);
	let text: string;
	try {
		text = files.readFileSync(path);
	} catch (error) {
		if (isNotFound(error)) return { file: { kind: "missing" }, cwdValue: { kind: "missing" } };
		return { file: { kind: "unreadable", error: errorMessage(error) }, cwdValue: { kind: "missing" } };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { file: { kind: "unreadable", error: errorMessage(error) }, cwdValue: { kind: "missing" } };
	}
	if (!isRecord(parsed)) {
		return { file: { kind: "unreadable", error: "root is not an object" }, cwdValue: { kind: "missing" } };
	}
	return { file: { kind: "ok", data: parsed }, cwdValue: readCwdValue(parsed, cwd) };
}

/** Names to keep in the prompt, or undefined when this directory allows every skill. */
export function allowedNames(state: GateState): string[] | undefined {
	if (state.file.kind === "ok" && state.cwdValue.kind === "names") return state.cwdValue.names.slice();
	return undefined;
}

export function retainedNames(stored: readonly string[] | undefined, rowNames: readonly string[]): string[] {
	const rows = new Set(rowNames);
	return (stored ?? []).filter((name) => !rows.has(name));
}

export function mergeSavedNames(
	stored: readonly string[] | undefined,
	checkedNames: readonly string[],
	rowNames: readonly string[],
): string[] {
	return [...checkedNames, ...retainedNames(stored, rowNames)];
}

export function saveSelection(
	agentDir: string,
	cwd: string,
	checkedNames: readonly string[],
	rowNames: readonly string[],
): MutationResult {
	const state = readGate(agentDir, cwd);
	if (state.file.kind === "unreadable") {
		return { ok: false, reason: "unreadable", error: state.file.error };
	}
	const names = mergeSavedNames(allowedNames(state), checkedNames, rowNames);
	const data = state.file.kind === "ok" ? replaceKey(state.file.data, cwd, names) : { [cwd]: names };
	return writeData(agentDir, data);
}

export function resetCwd(agentDir: string, cwd: string): MutationResult {
	const state = readGate(agentDir, cwd);
	if (state.file.kind === "unreadable") {
		return { ok: false, reason: "unreadable", error: state.file.error };
	}
	if (state.file.kind === "missing" || !Object.hasOwn(state.file.data, cwd)) {
		return { ok: true, wrote: false };
	}
	const data = { ...state.file.data };
	delete data[cwd];
	return writeData(agentDir, data);
}

function writeData(agentDir: string, data: Record<string, unknown>): MutationResult {
	try {
		writeState(agentDir, data);
	} catch (error) {
		return { ok: false, reason: "write-failed", error: errorMessage(error) };
	}
	return { ok: true, wrote: true };
}

function writeState(agentDir: string, data: Record<string, unknown>): void {
	const dest = statePath(agentDir);
	const tmp = join(
		agentDir,
		`skill-gates.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
	);
	files.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	try {
		files.renameSync(tmp, dest);
	} catch (error) {
		try {
			files.unlinkSync(tmp);
		} catch {
			// The destination was not replaced. Keep the rename error if the temp file also remains.
		}
		throw error;
	}
}

function replaceKey(data: Record<string, unknown>, cwd: string, names: string[]): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	let replaced = false;
	for (const [key, value] of Object.entries(data)) {
		if (key === cwd) {
			next[key] = names;
			replaced = true;
		} else {
			next[key] = value;
		}
	}
	if (!replaced) next[cwd] = names;
	return next;
}

function readCwdValue(data: Record<string, unknown>, cwd: string): CwdValue {
	if (!Object.hasOwn(data, cwd)) return { kind: "missing" };
	const value = data[cwd];
	if (isStringArray(value)) return { kind: "names", names: value };
	return { kind: "invalid" };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
