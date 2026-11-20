import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync, type PathLike } from "node:fs";
import { join } from "node:path";

export const STATE_FILENAME = "skill-gates.json";
export const LOCK_FILENAME = `${STATE_FILENAME}.lock`;

const LOCK_ATTEMPTS = 15;
const LOCK_WAIT_MS = 10;

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
	return runMutation(agentDir, () => {
		const state = readGate(agentDir, cwd);
		if (state.file.kind === "unreadable") {
			return { ok: false, reason: "unreadable", error: state.file.error };
		}
		const names = mergeSavedNames(allowedNames(state), checkedNames, rowNames);
		const data = state.file.kind === "ok" ? replaceKey(state.file.data, cwd, names) : { [cwd]: names };
		return writeData(agentDir, data);
	});
}

export function resetCwd(agentDir: string, cwd: string): MutationResult {
	return runMutation(agentDir, () => {
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
	});
}

/**
 * Hold a lock across the read and the rename. Two processes otherwise read the
 * same object, and the later rename drops the other directory's key. A lock
 * whose pid is gone is removed. A live lock is left in place.
 */
function runMutation(agentDir: string, mutate: () => MutationResult): MutationResult {
	try {
		acquireLock(agentDir);
	} catch (error) {
		// The agent directory is absent, so the state file is absent too. Let the
		// mutation report that instead of a lock error. It still does not write.
		if (isNotFound(error)) return mutate();
		return { ok: false, reason: "write-failed", error: errorMessage(error) };
	}
	try {
		return mutate();
	} finally {
		releaseLock(agentDir);
	}
}

function acquireLock(agentDir: string): void {
	const path = lockPath(agentDir);
	let waits = 0;
	let removed = 0;
	while (waits < LOCK_ATTEMPTS && removed <= LOCK_ATTEMPTS) {
		try {
			files.writeFileSync(path, `${process.pid}\n`);
			return;
		} catch (error) {
			if (!isExists(error)) throw error;
			// Retry immediately after removing a stale lock. Count those separately
			// so a lock that cannot be removed cannot spin forever.
			if (isStaleLock(path) && removeLock(path)) {
				removed++;
				continue;
			}
			waits++;
			if (waits < LOCK_ATTEMPTS) pause(LOCK_WAIT_MS);
		}
	}
	throw new Error("skill-gates.json is busy");
}

function removeLock(path: string): boolean {
	try {
		files.unlinkSync(path);
		return true;
	} catch (error) {
		return isNotFound(error);
	}
}

function releaseLock(agentDir: string): void {
	try {
		files.unlinkSync(lockPath(agentDir));
	} catch {
		// Already released. The state write already finished or never started.
	}
}

function isStaleLock(path: string): boolean {
	let text: string;
	try {
		text = files.readFileSync(path);
	} catch (error) {
		return isNotFound(error);
	}
	const pid = Number.parseInt(text, 10);
	// pid 0 signals the process group. Never treat it as a live owner.
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		const code = errorCode(error);
		return code === "ESRCH" || code === "EINVAL";
	}
}

function pause(ms: number): void {
	const gate = new Int32Array(new SharedArrayBuffer(4));
	try {
		Atomics.wait(gate, 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			// Atomics.wait is unavailable. A short spin is enough for the retry budget.
		}
	}
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
	try {
		files.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
		files.renameSync(tmp, dest);
	} catch (error) {
		try {
			files.unlinkSync(tmp);
		} catch {
			// The destination was not replaced. Keep the original error if the temp file also remains.
		}
		throw error;
	}
}

function lockPath(agentDir: string): string {
	return join(agentDir, LOCK_FILENAME);
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
	return errorCode(error) === "ENOENT";
}

function isExists(error: unknown): boolean {
	return errorCode(error) === "EEXIST";
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
