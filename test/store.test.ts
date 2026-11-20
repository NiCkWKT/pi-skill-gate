import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	allowedNames,
	files,
	mergeSavedNames,
	readGate,
	resetCwd,
	retainedNames,
	saveSelection,
	statePath,
} from "../src/store.ts";

const dirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "skill-gate-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		const state = statePath(dir);
		if (existsSync(state)) chmodSync(state, 0o644);
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeState(dir: string, value: unknown): void {
	writeFileSync(statePath(dir), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(dir: string): unknown {
	return JSON.parse(readFileSync(statePath(dir), "utf8"));
}

describe("skill gate store", { concurrency: 1 }, () => {
	it("treats a missing file as allow-all and writes nothing", () => {
		const dir = tempAgentDir();
		const state = readGate(dir, "/work");
		assert.equal(state.file.kind, "missing");
		assert.equal(state.cwdValue.kind, "missing");
		assert.equal(allowedNames(state), undefined);
		assert.equal(existsSync(statePath(dir)), false);
	});

	it("does not cache a later write", () => {
		const dir = tempAgentDir();
		assert.equal(readGate(dir, "/work").file.kind, "missing");
		writeState(dir, { "/work": ["github-work"] });
		assert.deepEqual(allowedNames(readGate(dir, "/work")), ["github-work"]);
	});

	it("reports invalid JSON and a non-object root as unreadable", () => {
		for (const raw of ["{", "", "   ", "[]", "null", "42", '"hello"', "true"]) {
			const dir = tempAgentDir();
			writeState(dir, raw);
			const state = readGate(dir, "/work");
			assert.equal(state.file.kind, "unreadable", raw);
			assert.equal(allowedNames(state), undefined);
			assert.equal(readFileSync(statePath(dir), "utf8"), raw);
		}
	});

	it("allows every skill when the cwd key is missing", () => {
		const dir = tempAgentDir();
		writeState(dir, { "/other": ["code-review"] });
		const state = readGate(dir, "/work");
		assert.equal(state.file.kind, "ok");
		assert.equal(state.cwdValue.kind, "missing");
		assert.equal(allowedNames(state), undefined);
		assert.deepEqual(allowedNames(readGate(dir, "/other")), ["code-review"]);
	});

	it("allows only the saved names, including an empty array", () => {
		const dir = tempAgentDir();
		writeState(dir, { "/work": ["github-work", "code-review"], "/none": [] });
		assert.deepEqual(allowedNames(readGate(dir, "/work")), ["github-work", "code-review"]);
		assert.deepEqual(allowedNames(readGate(dir, "/none")), []);
	});

	it("reports a non-array cwd value beside a valid key without dropping that key", () => {
		const dir = tempAgentDir();
		const data = {
			"/other": ["keep"],
			"/work": { bad: true },
			"/numbers": ["ok", 1],
			"/text": "github-work",
			"/null": null,
		};
		writeState(dir, data);
		for (const cwd of ["/work", "/numbers", "/text", "/null"]) {
			const state = readGate(dir, cwd);
			assert.equal(state.file.kind, "ok");
			assert.equal(state.cwdValue.kind, "invalid", cwd);
			assert.equal(allowedNames(state), undefined);
		}
		assert.deepEqual(allowedNames(readGate(dir, "/other")), ["keep"]);
		assert.deepEqual(readJson(dir), data);
	});

	it("reports an unreadable file", () => {
		const dir = tempAgentDir();
		const path = statePath(dir);
		writeFileSync(path, '{"/other":["keep"]}\n');
		chmodSync(path, 0);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			chmodSync(path, 0o644);
			rmSync(path);
			mkdirSync(path);
		}
		const state = readGate(dir, "/work");
		assert.equal(state.file.kind, "unreadable");
		assert.equal(allowedNames(state), undefined);
		assert.notEqual(state.file.kind === "unreadable" ? state.file.error : "", "");
	});

	it("filters with the prompt assignment and does not add or reorder skills", () => {
		const skills = [
			{ name: "a", filePath: "/a" },
			{ name: "b", filePath: "/b" },
			{ name: "c", filePath: "/c" },
		];
		const event = { systemPromptOptions: { skills } };
		const names = ["c", "a", "missing"];
		event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) =>
			names.includes(skill.name),
		);
		assert.deepEqual(event.systemPromptOptions.skills, [skills[0], skills[2]]);
		assert.deepEqual(skills.map((skill) => skill.name), ["a", "b", "c"]);

		const empty: string[] | undefined = [];
		const cleared = { systemPromptOptions: { skills } };
		if (empty) {
			cleared.systemPromptOptions.skills = cleared.systemPromptOptions.skills.filter((skill) =>
				empty.includes(skill.name),
			);
		}
		assert.deepEqual(cleared.systemPromptOptions.skills, []);

		const allowAll: string[] | undefined = undefined;
		const unchanged = { systemPromptOptions: { skills } };
		if (allowAll) {
			unchanged.systemPromptOptions.skills = unchanged.systemPromptOptions.skills.filter((skill) =>
				allowAll.includes(skill.name),
			);
		}
		assert.equal(unchanged.systemPromptOptions.skills, skills);
	});

	it("merges checked names with stored names that are not in the row list", () => {
		const stored = ["github-work", "gone", "code-review"];
		const rows = ["github-work", "code-review", "new-skill"];
		assert.deepEqual(retainedNames(stored, rows), ["gone"]);
		assert.deepEqual(mergeSavedNames(stored, ["code-review", "new-skill"], rows), [
			"code-review",
			"new-skill",
			"gone",
		]);
		assert.deepEqual(mergeSavedNames(undefined, [], rows), []);
		assert.deepEqual(mergeSavedNames(stored, [], rows), ["gone"]);
	});

	it("creates a missing file and preserves other keys when replacing a non-array value", () => {
		const dir = tempAgentDir();
		const created = saveSelection(dir, "/work", [], ["github-work"]);
		assert.deepEqual(created, { ok: true, wrote: true });
		assert.deepEqual(readJson(dir), { "/work": [] });
		assert.deepEqual(allowedNames(readGate(dir, "/work")), []);

		writeState(dir, { "/other": ["keep"], "/work": { bad: true }, "/later": ["later"] });
		const replaced = saveSelection(dir, "/work", ["github-work"], ["github-work", "code-review"]);
		assert.equal(replaced.ok, true);
		assert.deepEqual(readJson(dir), {
			"/other": ["keep"],
			"/work": ["github-work"],
			"/later": ["later"],
		});
	});

	it("keeps a name that is not in the current row list", () => {
		const dir = tempAgentDir();
		writeState(dir, { "/work": ["github-work", "gone"] });
		const saved = saveSelection(dir, "/work", ["code-review"], ["github-work", "code-review"]);
		assert.equal(saved.ok, true);
		assert.deepEqual(readJson(dir), { "/work": ["code-review", "gone"] });
	});

	it("refuses to replace an unreadable file", () => {
		const dir = tempAgentDir();
		const path = statePath(dir);
		const raw = '{"/other":["keep"]}\n';
		writeFileSync(path, raw);
		chmodSync(path, 0);
		const unreadableByMode = !canRead(path);
		if (!unreadableByMode) {
			chmodSync(path, 0o644);
			rmSync(path);
			mkdirSync(path);
		}

		const saved = saveSelection(dir, "/work", ["github-work"], ["github-work"]);
		const reset = resetCwd(dir, "/work");
		assert.equal(saved.ok, false);
		assert.equal(saved.ok === false && saved.reason, "unreadable");
		assert.equal(reset.ok, false);
		assert.equal(reset.ok === false && reset.reason, "unreadable");

		if (unreadableByMode) {
			chmodSync(path, 0o644);
			assert.equal(readFileSync(path, "utf8"), raw);
		} else {
			assert.equal(statSync(path).isDirectory(), true);
		}
	});

	it("refuses to replace invalid JSON or a non-object root", () => {
		for (const raw of ["{", "[]", "null"]) {
			const dir = tempAgentDir();
			writeState(dir, raw);
			assert.equal(saveSelection(dir, "/work", [], []).ok, false);
			assert.equal(resetCwd(dir, "/work").ok, false);
			assert.equal(readFileSync(statePath(dir), "utf8"), raw);
		}
	});

	it("deletes the cwd key on reset, including a non-array value, and writes nothing when the key is missing", () => {
		const dir = tempAgentDir();
		assert.deepEqual(resetCwd(dir, "/work"), { ok: true, wrote: false });
		assert.equal(existsSync(statePath(dir)), false);

		writeState(dir, { "/other": ["keep"], "/work": { bad: true } });
		const beforeMissing = readFileSync(statePath(dir), "utf8");
		assert.deepEqual(resetCwd(dir, "/absent"), { ok: true, wrote: false });
		assert.equal(readFileSync(statePath(dir), "utf8"), beforeMissing);

		assert.deepEqual(resetCwd(dir, "/work"), { ok: true, wrote: true });
		assert.deepEqual(readJson(dir), { "/other": ["keep"] });

		assert.deepEqual(resetCwd(dir, "/other"), { ok: true, wrote: true });
		assert.deepEqual(readJson(dir), {});
	});

	it("renames one temp file in the same directory over the state file", () => {
		const dir = tempAgentDir();
		const dest = statePath(dir);
		const original = files.renameSync;
		const calls: Array<{ from: string; to: string; body: string }> = [];
		files.renameSync = ((from, to) => {
			calls.push({ from: String(from), to: String(to), body: readFileSync(from, "utf8") });
			return original(from, to);
		}) as typeof files.renameSync;
		try {
			const saved = saveSelection(dir, "/work", ["github-work"], ["github-work"]);
			assert.deepEqual(saved, { ok: true, wrote: true });
			assert.equal(calls.length, 1);
			assert.equal(calls[0]?.to, dest);
			assert.equal(dirname(calls[0]?.from ?? ""), dir);
			assert.match(calls[0]?.from ?? "", /\.tmp$/);
			assert.equal(readFileSync(dest, "utf8"), calls[0]?.body);
			assert.equal(existsSync(calls[0]?.from ?? ""), false);
			assert.deepEqual(
				readdirSync(dir).filter((name) => name.endsWith(".tmp")),
				[],
			);
		} finally {
			files.renameSync = original;
		}
	});

	it("leaves the previous file in place when rename fails", () => {
		const dir = tempAgentDir();
		const dest = statePath(dir);
		writeState(dir, { "/work": ["keep"], "/other": ["other"] });
		const before = readFileSync(dest, "utf8");
		const original = files.renameSync;
		files.renameSync = (() => {
			throw new Error("rename failed");
		}) as typeof files.renameSync;
		try {
			const saved = saveSelection(dir, "/work", ["github-work"], ["github-work"]);
			assert.equal(saved.ok, false);
			assert.equal(saved.ok === false && saved.reason, "write-failed");
			assert.equal(readFileSync(dest, "utf8"), before);
			assert.deepEqual(
				readdirSync(dir).filter((name) => name.endsWith(".tmp")),
				[],
			);
		} finally {
			files.renameSync = original;
		}
	});
});

function canRead(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}
