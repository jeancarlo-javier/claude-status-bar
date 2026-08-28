#!/usr/bin/env node
// Stop hook: block the turn if ~/.claude/session-context/<session_id> was never written.
// Deterministic enforcement — reminders (CLAUDE.md rule + UserPromptSubmit nudge) proved
// skippable when the model is deep in a skill flow (/daily-focus case, twice).
// Fails OPEN everywhere: a block the model cannot satisfy (read-only HOME, sandboxed FS,
// something odd at the store path) only burns a turn, so anything unexpected ends normally.
const fs = require('fs'), os = require('os'), path = require('path');
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const d = JSON.parse(s);
    if (d.stop_hook_active) return; // already blocked once this turn — never loop
    const ep = process.env.CLAUDE_CODE_ENTRYPOINT;
    if (ep && ep !== 'cli') return; // sdk/mcp/action harnesses: no human is watching a status line
    const id = d.session_id;
    if (!id || !/^[\w-]+$/.test(id)) return;
    const dir = path.join(os.homedir(), '.claude', 'session-context');
    const f = path.join(dir, id);
    try {
      if (!fs.lstatSync(f).isFile()) return;         // symlink/dir/fifo — never aim a `>` at it
      if (fs.readFileSync(f, 'utf8').trim()) return; // written; empty/whitespace doesn't count
    } catch (e) {
      if (e.code !== 'ENOENT') return;               // unreadable ≠ unwritten, and blocking can't fix it
    }
    try { fs.accessSync(fs.existsSync(dir) ? dir : path.dirname(dir), fs.constants.W_OK); }
    catch { return; }                                // nowhere to write → the block is unsatisfiable
    console.log(JSON.stringify({
      decision: 'block',
      reason: `session-context (status line) was never written this session. Before finishing, run: echo "<Phase>: <subject ≤6 words>" > "${f}" — e.g. "Exec: Fix the client header"; phase is any short label (Focus, Plan, Exec, Q&A, Verify, Done, Needs-Review, ...). If the session is just conversation with no task, use "Chat: <topic>". Then finish your response normally.`
    }));
  } catch {}
});
