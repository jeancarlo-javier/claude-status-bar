---
name: init
description: Repair or force the claude-status-bar install - re-point the statusLine at this plugin, or replace an existing status line it refused to overwrite. Not needed for a normal install, which configures itself on first session start.
---

# Repair the claude-status-bar install

Installing the plugin already configures everything on the next session start, via the
`SessionStart` hook in `hooks/plugin-setup.js`. Run this skill only to fix the two cases that
hook deliberately leaves alone.

The **plugin root** is this skill's grandparent directory — the folder holding `bin/`, `hooks/`
and `docs/`. Resolve it to an absolute path first and write that absolute path into settings,
never the literal `${CLAUDE_PLUGIN_ROOT}`, which is only substituted for plugin-owned files.

## Case 1 — a different status line is already configured

The setup hook never overwrites a status line it did not install. If the user wants to switch,
show them the current `statusLine.command` from `~/.claude/settings.json`, confirm they want it
replaced, and only then set:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<PLUGIN_ROOT>/bin/claude-code-status.js\""
  }
}
```

Preserve every other key in the file.

## Case 2 — the phase rule is missing or was edited away

Check `~/.claude/CLAUDE.md` for `claude-status-bar:begin`. If absent, append the fenced
`markdown` block from `docs/global-claude-rule.md` in the plugin root, wrapped in the same
markers the hook uses:

```
<!-- claude-status-bar:begin — delete this block to remove the rule -->
…rule…
<!-- claude-status-bar:end -->
```

## Then

Say which files changed and that the status line appears after restarting Claude Code. If both
cases were already fine, say so instead of changing anything.
