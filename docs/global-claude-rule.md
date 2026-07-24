# Global CLAUDE.md rule (layer 1: teach)

This section lives in `~/.claude/CLAUDE.md` and is the canonical instruction that teaches
every Claude Code session the phase-file contract. If you edit it there, mirror it here.

```markdown
# Status line session context

- Keep `~/.claude/session-context/$CLAUDE_CODE_SESSION_ID` holding the session's current
  workflow phase + subject, format `Phase: subject` (subject ≤6 words):
  `Plan: Migrate buttons to ShadCN` · `Exec: DB User Schema migration` ·
  `Q&A: auth feature review` · `Verify: auth feature`
- Phases are DYNAMIC — use whatever short label fits the current workflow. Common examples:
  `Research | Plan | Review-Plan | Exec | Review-Execution | Q&A | Verify | Done | Debug | Focus | Recover`.
- When you stop because you need the user's confirmation, review, or a reply (a question, a
  plan awaiting approval, a blocking decision), set `Needs-Review: <what you await>` —
  renders yellow so it's visible at a glance that the session is waiting on the user.
  Pipelines vary (e.g. plan → review-plan → exec → q&a → verify); the subject stays stable
  across a pipeline, only the phase prefix advances.
- Rewrite the file at EVERY phase transition (entering/exiting plan mode, starting
  implementation, starting review, starting verification, switching to debugging), when the
  subject changes, and when a skill flow establishes the session's focus (e.g. /daily-focus
  picking today's task → `Focus: <task>` immediately, same turn):
  `echo "Exec: DB User Schema migration" > ~/.claude/session-context/$CLAUDE_CODE_SESSION_ID`
  It renders in the status line — no announcement needed, just write it.

```
