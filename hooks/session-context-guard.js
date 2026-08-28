#!/usr/bin/env node
// Stop hook: block the turn if ~/.claude/session-context/<session_id> was never written,
// or has stood unchanged for over STALE_MIN minutes.
// Deterministic enforcement — reminders (CLAUDE.md rule + UserPromptSubmit nudge) proved
// skippable when the model is deep in a skill flow (/daily-focus case, twice).
// Existence alone was too weak a test: written once at minute 3, a session satisfied this
// forever, and across 38 measured sessions the label was >15min out of date 57% of the wall
// clock. A turn boundary is where the phase has usually just changed, so that is where to ask.
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
    // 30 minutes, measured over 33 sessions: fires on ~10% of turn boundaries, a median of once
    // per session. 15 doubles that for little gain; 45 barely differs and lets a phase rot longer.
    const STALE_MIN = 30;
    let shown = '';
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile()) return;                      // symlink/dir/fifo — never aim a `>` at it
      shown = fs.readFileSync(f, 'utf8').trim().split('\n')[0].slice(0, 120);
      // the instructions pasted verbatim — three files on disk read exactly "Phase: subject".
      // Treat the template as unwritten, or `touch` preserves a placeholder forever.
      if (/^<?phase>?\s*:\s*<?subject/i.test(shown)) shown = '';
      if (shown && Date.now() - st.mtimeMs < STALE_MIN * 60_000) return; // written and still believable
    } catch (e) {
      if (e.code !== 'ENOENT') return;               // unreadable ≠ unwritten, and blocking can't fix it
    }
    try {
      fs.mkdirSync(dir, { recursive: true });        // `echo > …/<id>` fails outright if the store is missing
      // the file's own mode, not the store's: a read-only phase file in a writable directory
      // defeats both `echo >` and `touch`, so the block would be unsatisfiable there too
      fs.accessSync(fs.existsSync(f) ? f : dir, fs.constants.W_OK);
    } catch { return; }                              // nowhere to write → the block is unsatisfiable
    // The cheap way out has to be the honest one: when the line is still right, `touch` is less
    // work than inventing a label, so the guard cannot be bought off with a made-up phase.
    const reason = shown
      ? `session-context (status line) still shows "${shown}" and has not changed in over ${STALE_MIN} minutes. Before finishing, say where the session actually is now: echo "<Phase>: <subject ≤6 words>" > "${f}". If that exact line is still right, do NOT invent a new one — just refresh it: touch "${f}". Then finish your response normally.`
      : `session-context (status line) was never written this session. Before finishing, run: echo "<Phase>: <subject ≤6 words>" > "${f}" — e.g. "Exec: Fix the client header"; phase is any short label (Focus, Plan, Exec, Q&A, Verify, Done, Needs-Review, ...). If the session is just conversation with no task, use "Chat: <topic>". Then finish your response normally.`;
    console.log(JSON.stringify({ decision: 'block', reason }));
  } catch {}
});
