#!/usr/bin/env node
// UserPromptSubmit: echo the current session-context back to the model each turn
// so the "Phase: subject" file stays fresh across phase transitions.
const fs = require('fs'), os = require('os'), path = require('path');
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const id = JSON.parse(s).session_id;
    if (!id || !/^[\w-]+$/.test(id)) return;
    const f = path.join(os.homedir(), '.claude', 'session-context', id);
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs < 10 * 60_000) return; // fresh — stay silent, zero tokens
      const t = fs.readFileSync(f, 'utf8').trim().split('\n')[0].slice(0, 120);
      console.log(`session-context (status line) still shows "${t}" — stale. If the phase/subject changed, you MUST update now: echo "Phase: subject" > ~/.claude/session-context/$CLAUDE_CODE_SESSION_ID (any short phase label: Plan, Exec, Q&A, Verify, Focus, ...). If still accurate, touch the file.`);
    } catch {
      console.log('session-context (status line) is EMPTY. Required, same turn — once the session\'s focus is clear: echo "Phase: subject ≤6 words" > ~/.claude/session-context/$CLAUDE_CODE_SESSION_ID (e.g. "Focus: Fix Eventrid client header"). Do not wait to be asked.');
    }
  } catch {}
});
