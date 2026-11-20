# pi-skill-gate

A [Pi](https://github.com/earendil-works/pi) extension that chooses which skill descriptions the model sees in a directory.

Pi normally puts every installed skill description in the system prompt, so the model can open those skills on its own. This extension keeps an allow-list per working directory. Skills you clear stay out of that prompt. `/skill:name` and the slash menu still list every skill.

The choice is stored on your machine, not in the project, and it does not travel with the repository.

Tested with `@earendil-works/pi-coding-agent` 1.6.0.

## Installation

This is the important part. Pi does not load this project if you copy only `src/index.ts`.

The repository root has a `package.json` with:

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

Pi discovers that manifest one directory below `extensions/`. It does not walk further. The entry point also imports `./store.ts`, so the linked directory has to be this repository, not a single file.

No `npm install` is required to use it. Pi loads the TypeScript and supplies its own packages.

### Requirements

- Pi 1.6.0 or a later release that still loads extensions from `package.json` `pi.extensions`
- A normal interactive Pi session for the checklist. Print and JSON mode can report the current choice, but they cannot open the editor.

If you set `PI_CODING_AGENT_DIR`, use that directory instead of `~/.pi/agent` in the commands below.

### Install for every project

Clone the repository somewhere stable, then symlink that directory into Pi's extension directory:

```bash
git clone <repository-url> ~/src/pi-skill-gate
mkdir -p ~/.pi/agent/extensions
ln -s ~/src/pi-skill-gate ~/.pi/agent/extensions/skill-gate
```

The link name can be anything. `skill-gate` is only a label. The link must point at the repository root, the directory that contains `package.json`.

Do not add an `extensions` or `packages` entry to `settings.json` for this install. The symlink is enough, and `/reload` can see it.

Restart Pi, or run `/reload` in a session that is already open. Then run `/skills`. You should get a checklist, not Pi's "unknown command" message.

### Try it without installing

Point Pi at the repository for one process:

```bash
pi -e ~/src/pi-skill-gate
```

That does not survive the next launch. Use the symlink above if you want it every time.

### Install for one project

Use this only when you want the extension in a single trusted project. The saved choice is still global state, keyed by directory.

```bash
mkdir -p .pi/extensions
ln -s ~/src/pi-skill-gate .pi/extensions/skill-gate
```

Pi loads project extensions after you trust the project. Other directories will not load this copy.

### Uninstall

Remove the symlink. That does not delete the clone or the saved choices.

```bash
rm ~/.pi/agent/extensions/skill-gate
```

To also forget every directory's selection, remove the state file:

```bash
rm ~/.pi/agent/skill-gates.json
```

## Usage

Open Pi in the project whose skills you want to filter, then run:

```text
/skills
```

The first time, every skill is checked, which is the same as today's prompt. A row marked `command-only` is already hidden from the model. Clearing that row does not change the descriptions.

| Key | Action |
| --- | --- |
| Up / Down | Move |
| Page Up / Page Down | Move by a page |
| Space | Toggle the current row |
| Enter | Save and close |
| Escape | Close without saving |

After Enter, start a new session in that directory. The new session records only the checked descriptions. `/new` keeps the selection you just saved.

Saving does not rewrite a conversation that is already open. Pi may send a later skills update on the next request. This extension does not shorten that conversation.

Turn the filter off for the current directory:

```text
/skills reset
```

The directory shows every skill again. Another directory's selection is left alone.

In print or JSON mode, `/skills` does not open the checklist. If a notification UI exists, it reports the current choice. `/skills reset` still works.

Anything other than an empty argument or `reset` prints the usage and writes nothing.

## What is saved

Choices live in `~/.pi/agent/skill-gates.json`, or `$PI_CODING_AGENT_DIR/skill-gates.json` if that variable is set.

```json
{
  "/absolute/work/directory": ["github-work", "code-review"]
}
```

The key is the session directory string Pi gives the extension. It is absolute, and it is not resolved through symlinks. Opening the same files through a different path is a different key.

| Record | What the model sees |
| --- | --- |
| No file, or no key for this directory | Every skill description |
| A list of names, including `[]` | Only those names |
| File present but unreadable | Every skill description, and `/skills` will not overwrite the file |

A name that is not installed stays in the list. After you save once, a skill you install later stays out of the prompt until you open `/skills` and check it.

Enter with every box cleared saves `[]`. That is a real choice, not "no record".

## Development

```bash
npm test
```

The tests cover the state file. They need Node with `--experimental-strip-types` support, which current Node provides. They do not open the checklist.
