#!/usr/bin/env node
// Stop hook: block the turn if ~/.claude/session-context/<session_id> was never written.
// Deterministic enforcement — reminders (CLAUDE.md rule + UserPromptSubmit nudge) proved
// skippable when the model is deep in a skill flow (/daily-focus case, twice).
const fs = require('fs'), os = require('os'), path = require('path');
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const d = JSON.parse(s);
    if (d.stop_hook_active) return; // already blocked once this turn — never loop
    const id = d.session_id;
    if (!id || !/^[\w-]+$/.test(id)) return;
    try { if (fs.readFileSync(path.join(os.homedir(), '.claude', 'session-context', id), 'utf8').trim()) return; } catch {} // empty/whitespace file doesn't count as written
    console.log(JSON.stringify({
      decision: 'block',
      reason: 'session-context (status line) was never written this session. Before finishing, run: echo "Phase: subject ≤6 words" > ~/.claude/session-context/$CLAUDE_CODE_SESSION_ID — phase is any short label (Focus, Plan, Exec, Q&A, Verify, Done, Needs-Review, ...). If the session is just conversation with no task, use "Chat: <topic>". Then finish your response normally.'
    }));
  } catch {}
});
