#!/usr/bin/env node
// Two events, both for bin/subagent-status.js:
//
// PreToolUse (no matcher): the one place Claude Code reports a subagent's *own* effort. Fired
// inside the subagent, the input carries agent_id and effort.level "after any silent downgrade
// for the selected model" — the level it actually runs at, which neither the agent panel
// payload (configured value only) nor CLAUDE_EFFORT (absent there) can tell. Recorded per agent.
//
// SubagentStart: tells the subagent where its phase file lives (`<session>.<agent_id>.phase`),
// since a subagent has no agent id of its own in the environment — CLAUDE_CODE_SESSION_ID there
// is the parent's. The panel row then shows the phase the subagent writes instead of the task
// description.
//
// Silent; never blocks anything.
const fs = require('fs'), os = require('os'), path = require('path');
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const inp = JSON.parse(s);
    const { session_id: sid, agent_id: aid } = inp;
    if (!aid || ![sid, aid].every(v => typeof v === 'string' && /^[\w-]+$/.test(v))) return; // main thread
    const dir = path.join(os.homedir(), '.claude', 'session-context');
    const effort = inp.effort?.level;                            // absent on models without the parameter (Haiku 4.5)
    if (effort) {
      const f = path.join(dir, `${sid}.${aid}.agent.json`);
      const next = JSON.stringify({ effort });
      let prev = ''; try { prev = fs.readFileSync(f, 'utf8'); } catch {}
      if (prev !== next) {                                      // one write per change, not per tool call
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(f, next, { mode: 0o600 });
      }
    }
    if (inp.hook_event_name !== 'SubagentStart') return;
    const phase = path.join(dir, `${sid}.${aid}.phase`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext:
      `Keep ${phase} holding your current workflow phase + subject, format \`Phase: subject\` (subject ≤6 words), ` +
      'e.g. `Exec: port auth to JWT`, `Verify: auth tests`. Rewrite it at every phase transition: ' +
      `echo "Exec: port auth to JWT" > ${phase} — it renders in the user's agent panel; just write it, never mention it.` } }));
  } catch {}
});
