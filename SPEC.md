# SPEC

Implement `USER_FLOW.md`. That file decides what the user sees. This file decides how the extension does it.

Verified on `@earendil-works/pi-coding-agent` 1.6.0. The flow is feasible. Do not change Pi, and do not write `settings.json`.

## What is already true in Pi

- `before_agent_start` receives one `systemPromptOptions` object. Pi copies `skills` before the handler runs. Assign a new array to `event.systemPromptOptions.skills`. That changes this run only.
- Pi builds the `skills` prompt section from that array. A new session has no leading system message until the first prompt. That prompt runs `before_agent_start` first, then records the filtered section.
- An open session already has a leading section. The handler still filters, and Pi appends a later `skills` patch. Do not rewrite that leading message. `/compact` may replay the current sections into a new leading message. Do not do that yourself.
- A model with `supportsMidConvoSystemMessages` keeps the old leading section and also receives `Updated system prompt section "skills"`. That request is not shorter. A model without the flag receives the replayed sections as its leading prompt, so the next request is shorter and misses the cache. The flag is per model, not per provider. Many Claude and OpenAI models in the 1.6.0 catalog do not set it. Leave that behavior alone. A new session is how the leading section is replaced.
- `/skill:name` reads `resourceLoader.getSkills()`, not the prompt list. Do not intercept `input`.
- The interactive slash menu is built from built-in commands, prompt templates, extension commands, and `resourceLoader.getSkills()` when skill commands are enabled. `getCommands()` is a separate list and also includes every skill. An extension cannot remove those skill entries.
- `formatSkillsForPrompt` already omits `disableModelInvocation` skills from the prompt text. They still appear in `skills` and still have `/skill:name`. A check on those rows does not change today's prompt and does not hide `/skill:name`.
- No built-in command is named `skills`.
- A symlink at `~/.pi/agent/extensions/skill-gate` loads when this repo has `package.json` `pi.extensions`. Discovery does not recurse past that manifest.
- `ctx.cwd` is the session directory after `path.resolve`. It does not resolve symlinks. Use that string as the state key.

## Files

```
package.json          pi.extensions: ["./src/index.ts"]
src/store.ts          state file rules, no Pi imports
src/index.ts          command, checklist, before_agent_start
test/store.test.ts    node:test
```

`package.json` is private, `"type": "module"`, and has no dependencies. Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at load time. The test script is `node --experimental-strip-types --test test/store.test.ts`.

## State file

Path: `join(getAgentDir(), "skill-gates.json")`.

```json
{
  "/absolute/work/directory": ["github-work", "code-review"]
}
```

Read it on every `before_agent_start` and every `/skills` invocation. Use `ctx.cwd` from that call. Do not cache the parsed file. Do not capture `cwd` in the factory.

| File state | Meaning |
|---|---|
| File missing | Allow every skill. Write nothing. |
| JSON invalid, or the root is not an object | Allow every skill. The store reports it. `index.ts` warns once per process. Do not throw. Write nothing. |
| cwd key missing | Allow every skill. |
| cwd value is a string array, including `[]` | Allow those names only. Every element is a string. |
| cwd value is not a string array | Allow every skill for this cwd. The store reports it. Warn once per process. Other cwd keys stay valid. A non-string element makes the value invalid. |

A name that is not installed stays in the array. `reset` deletes the cwd key, including a value that is not a string array. It does not write `[]`. If the key is already missing, write nothing. When a delete leaves the object empty, write `{}`.

If the JSON is invalid, or the root is not an object, Enter and `reset` notify and write nothing. Do not replace that file with a fresh object. A missing file is not this case: Enter creates it.

A non-array cwd value contributes no stored names. Enter may replace that key and must preserve every other key.

Write only from Enter in the checklist and from `/skills reset`. Do not write when an existing file could not be parsed. Write a uniquely named temp file in the same directory, then `rename` it over the state file. A failed write notifies the user and leaves the previous file in place.

## Filter

In `before_agent_start`, when the cwd value is a string array, assign:

```ts
event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) =>
  names.includes(skill.name),
);
```

Return nothing from the handler. A returned `systemPrompt` replaces the whole prompt and is the wrong mechanism.

Keep Pi's skill order. Do not add skills that Pi did not put in the array.

## `/skills`

Register one command, `skills`. Trim `args`.

| Input | Result |
|---|---|
| empty, `ctx.mode === "tui"` | Open the checklist. |
| empty, any other mode | Do not open the checklist. Write nothing. If `ctx.hasUI`, notify the current choice. Otherwise produce no output. |
| `reset` | If the JSON is invalid or the root is not an object, notify that the file was left unchanged. Otherwise delete this cwd key when it exists, and notify that this directory shows every skill. |
| anything else | Notify the usage. Write nothing. |

The reported choice says either "all skills" or the saved names. It is the non-TUI substitute, not a second editor. `ctx.ui.notify` is a no-op in print and JSON mode. Do not use `console.log`.

### Checklist

Build the rows from `ctx.getSystemPromptOptions().skills`. That list is the prompt input and includes `disableModelInvocation`, `sourceInfo.scope`, and `filePath`. Do not use `getCommands()` as the list. Skill commands can be turned off, and command entries do not carry `disableModelInvocation`.

No cwd key, or a non-array value: every row starts checked. A string array: a row is checked when its name is in the array.

Each row shows the check, the name, the scope, and the path. A `disableModelInvocation` row also says `command-only`. That mark is a label, not a second switch. The check is saved with the other names, but it does not change today's prompt and does not remove `/skill:name`.

The list scrolls. Keep the cursor row visible. Clip each row to the width. Do not wrap.

Keys, through the injected `keybindings`:

- `tui.select.up` / `tui.select.down` move the cursor.
- `tui.select.pageUp` / `tui.select.pageDown` move by a page.
- Space toggles the cursor row.
- `tui.select.confirm` saves and closes.
- `tui.select.cancel` closes and writes nothing.

Enter saves the checked names, plus stored names that are not in the current row list. A missing key or a non-array value contributes no stored names. Show that retained count in the checklist before save. Then notify that the choice is saved, that a new session records only the checked descriptions, and that this extension does not rewrite an open conversation.

If the JSON is invalid or the root is not an object, Enter notifies, closes, and writes nothing.

Enter with every box cleared saves `[]`, including when the file is missing. That is a real choice, not a missing key. Do not save `[]` over a file that could not be parsed.

## Tests

`test/store.test.ts` covers the state table, including an unreadable file and a non-array cwd value beside a valid key, the filter assignment's pure equivalent, save merging, `reset`, the refusal to replace an unreadable file, and one temp-file rename. Pass a temp directory into the store functions. Do not test the checklist.

## Install

After the tests pass, link this repo:

```bash
ln -s /Users/nickwkt/Documents/personal/pi-skill-gate ~/.pi/agent/extensions/skill-gate
```

Reload Pi. Do not add an `extensions` or `packages` entry.

## Out of scope

No `/skills on`, `/skills off`, `/skills list`, footer status, or startup notice. No changelog. No edit to the slash menu. No attempt to rewrite the leading system message of an open conversation. No special case for `supportsMidConvoSystemMessages`.

## Done

- `npm test` passes.
- A missing state file leaves the prompt skills unchanged.
- Enter in `/skills` creates the cwd key. The next new session in that directory receives only the checked descriptions.
- Escape leaves the file unchanged.
- An unreadable state file is left unchanged by Enter and by `/skills reset`.
- A non-array value for this directory does not change another directory's key.
- `/skills reset` removes the key, and the next new session receives every description.
- `/skill:name` still expands a skill that is not checked.
- Another directory with no key is unchanged.
