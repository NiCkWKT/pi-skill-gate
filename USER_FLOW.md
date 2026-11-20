# User flow

You open Pi in a project directory. You use `/skills` to choose which skill descriptions the model sees for that directory.

## First use

The state file has no record for this directory. The model sees every skill description, as it does today.

You run `/skills`. Every skill in the list is checked. A row marked command-only is already hidden from the model. Clearing it does not change the descriptions. Space clears a check. Enter saves. Escape does not save, and nothing changes.

## After you save

A new conversation in this directory includes only the checked skill descriptions. The model does not see the descriptions you cleared, so it does not open those skills on its own.

`/skill:name` still opens a skill you cleared. The slash menu still lists every skill.

## A conversation that is already open

Saving does not rewrite the descriptions already stored at the start of the conversation. Pi may send a later update on the next request. This extension does not shorten that conversation. Open a new session in this directory to replace the leading descriptions. `/new` keeps the same selection.

## Other directories

A directory with no record still shows every skill. The selection is in `~/.pi/agent/skill-gates.json` on your machine. It is not written into the project, and it does not travel with the repository.

If that file is present but unreadable, this directory still shows every skill, and `/skills` does not save over it.

## Skills you install later

After you have saved once, a newly installed skill stays out of the prompt. Open `/skills` and check it to include it.

## Turn the filter off

Run `/skills reset`. This directory shows every skill again.
