---
name: init
description: Finish installing claude-status-bar - wires the status line renderer into settings.json and appends the phase rule to the user's global CLAUDE.md. Run once after installing the plugin.
---

# Finish the claude-status-bar install

The plugin's two hooks are already wired by Claude Code. Two things it cannot do for you
remain: the status line command, and the CLAUDE.md rule that teaches the phase format.
Do both, then stop.

The **plugin root** is the directory containing this skill's grandparent — the folder holding
`bin/`, `hooks/` and `docs/`. Resolve it to an absolute path before writing any config, and use
that absolute path in `settings.json`. Do not write `${CLAUDE_PLUGIN_ROOT}` into settings.json;
that variable is only substituted for plugin-owned files, not for user settings.

## 1. Wire the status line

Read `~/.claude/settings.json` (create it as `{}` if missing) and set:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<PLUGIN_ROOT>/bin/claude-code-status.js\""
  }
}
```

Preserve every other key in the file. If a `statusLine` already exists, show the user what it is
and ask before replacing it — do not silently overwrite someone's existing status line.

## 2. Teach the phase format

Read `docs/global-claude-rule.md` from the plugin root and append its contents to
`~/.claude/CLAUDE.md`, creating that file if it does not exist.

First check whether the rule is already there — grep for `session-context` in `~/.claude/CLAUDE.md`.
If it matches, skip this step and say so rather than appending a duplicate.

## 3. Report

Tell the user:

- which files you changed
- that the status line appears after restarting Claude Code
- that the phase file lives at `~/.claude/session-context/<session_id>`, one plain-text file per
  session, and `rm ~/.claude/session-context/*` clears it

Then stop. Do not write a phase file yourself as a demonstration — the rule takes effect on the
next session.
