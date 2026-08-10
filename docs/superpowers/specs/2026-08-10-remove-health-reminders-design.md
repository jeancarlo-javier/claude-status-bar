# Remove health reminder system

## Goal

Remove the health-reminder feature from the status bar because its current UX is distracting and unreliable. The status bar must keep its existing context, rate-limit, task, git, cost, duration, and phase information without rendering a health segment.

## Scope

- Remove health state loading, normalization, scheduling, sidecar activity tracking, tallying, acknowledgement, and rendering from `bin/claude-code-status.js`.
- Remove the `done` CLI path and the `-hd` acknowledgement interception from `hooks/session-context-nudge.js`.
- Keep the session-context nudge and stop guard unchanged apart from removing the health-only branch and dependency.
- Replace health-specific renderer tests with a small CLI smoke test covering the remaining statusline output and the absence of the removed segment.
- Remove health examples, instructions, table entries, and privacy notes from `README.md`.

## Behavior after removal

- Line 2 contains only the context-window and available rate-limit segments supplied by Claude Code.
- The renderer never reads or writes `~/.claude/health-reminders.json` or its `.activity` sidecar.
- `-hd` is no longer a control token; it follows the normal prompt path.
- Existing health files in a user's home directory are left untouched and ignored.
- No plugin hook registration, installation flow, phase-file format, or version number changes.

## Verification

1. Run `node bin/claude-code-status.test.js`.
2. Exercise the renderer with representative JSON input and confirm the output retains the context segment and contains no `h:`, health icons, or `-hd` acknowledgement hint.
3. Confirm the nudge hook still emits the existing stale/missing phase behavior for ordinary prompts.
