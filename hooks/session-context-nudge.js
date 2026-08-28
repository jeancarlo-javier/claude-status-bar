#!/usr/bin/env node
// UserPromptSubmit: echo the current session-context back to the model each turn
// so the "Phase: subject" file stays fresh across phase transitions.
const fs = require('fs'), os = require('os'), path = require('path');
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const inp = JSON.parse(s);
    const id = inp.session_id;
    if (!id || !/^[\w-]+$/.test(id)) return;
    const dir = path.join(os.homedir(), '.claude', 'session-context');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // the model's `echo > …` fails if the store doesn't exist yet
    const f = path.join(dir, id);
    // the resolved path, not $CLAUDE_CODE_SESSION_ID: a literal-named file has already appeared
    // in a real store, so an unexpanded var here costs a whole session's status line
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile()) return;                          // symlink/dir — don't read it into context, don't aim a `>` at it
      if (Date.now() - st.mtimeMs < 10 * 60_000) return; // fresh — stay silent, zero tokens
      const t = fs.readFileSync(f, 'utf8').trim().split('\n')[0].slice(0, 120);
      console.log(`session-context (status line) still shows "${t}" — stale. If the phase/subject changed, you MUST update now: echo "<Phase>: <subject>" > "${f}" (any short phase label: Plan, Exec, Q&A, Verify, Focus, ...). If still accurate, touch the file.`);
    } catch {
      // One file per session and nothing ever removes them: 13 a day, 470 after 35 days, each
      // holding 34 bytes in a 4KB block. Prune here — this branch runs on the first turn of a
      // session, not on every turn — and never touch this session's own file.
      const CUTOFF = 30 * 86400_000;
      try {
        for (const n of fs.readdirSync(dir)) {
          if (n === id) continue;
          try {
            const st = fs.lstatSync(path.join(dir, n));
            if (st.isFile() && Date.now() - st.mtimeMs > CUTOFF) fs.rmSync(path.join(dir, n));
          } catch {}
        }
      } catch {}
      console.log(`session-context (status line) is EMPTY. Required, same turn — once the session's focus is clear: echo "<Phase>: <subject ≤6 words>" > "${f}" (e.g. "Focus: Fix Eventrid client header"). Do not wait to be asked.`);
    }
  } catch {}
});
