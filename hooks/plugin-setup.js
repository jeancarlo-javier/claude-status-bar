#!/usr/bin/env node
// SessionStart hook: finish the install that `claude plugin install` can't do itself —
// point statusLine at this plugin's renderer, and teach the phase rule in ~/.claude/CLAUDE.md.
// Idempotent and silent once both are in place; never clobbers a foreign status line.
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), '.claude');          // always ~/.claude, like the other scripts
const SETTINGS = path.join(HOME, 'settings.json');
const MEMORY = path.join(HOME, 'CLAUDE.md');
const NOTICED = path.join(HOME, '.claude-status-bar-noticed');
const RENDERER = path.join(ROOT, 'bin', 'claude-code-status.js');
const COMMAND = `node "${RENDERER}"`;
const MARK = 'claude-status-bar';
const HEADING = '# Status line session context';           // the rule's own title, for manual installs

// Ours only if the command points at bin/claude-code-status.js — a bare `claude-code-status`
// substring also matches unrelated tools like `not-claude-code-status-monitor.js`.
const isOurs = c => typeof c === 'string' && /bin[\\/]claude-code-status\.js/.test(c);

// ponytail: no file lock. Two sessions starting in the same instant can lose one update.
// The write window is first-run only and both runs write identical content; add locking
// only if that stops being true.
const writeAtomic = (p, s) => {
  const target = fs.existsSync(p) ? fs.realpathSync(p) : p; // follow symlinks, don't replace them
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.${process.pid}.tmp`;               // pid-scoped: concurrent runs can't interleave
  fs.writeFileSync(tmp, s, { mode });
  fs.chmodSync(tmp, mode);                                  // mode option is ignored if tmp already exists
  fs.renameSync(tmp, target);
};

const noticedOnce = () => {                                 // a notice repeated every session is just noise
  try { if (fs.existsSync(NOTICED)) return false; fs.writeFileSync(NOTICED, ''); } catch { return false; }
  return true;
};

const notes = [];

// ---- 1. statusLine ----
try {
  fs.mkdirSync(HOME, { recursive: true });
  const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
  const s = JSON.parse(raw || '{}');                        // corrupt settings.json throws → we touch nothing
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('settings root is not an object');
  const cur = s.statusLine?.command;
  if (!s.statusLine) {                                      // absent, or null/false/"" — nothing to preserve
    s.statusLine = { type: 'command', command: COMMAND };
    writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n');
    notes.push('claude-status-bar: status line configured — restart Claude Code to see it.');
  } else if (isOurs(cur)) {
    if (!cur.includes(RENDERER)) {                          // plugin updated → repoint at the new version
      s.statusLine.command = COMMAND;
      writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n');
    }
  } else if (noticedOnce()) {
    notes.push('claude-status-bar: you already have a different statusLine, so it was left alone. ' +
               'Run /claude-status-bar:init to switch to this one.');
  }
} catch { /* never break a session over config I/O */ }

// ---- 2. the phase rule ----
try {
  const existing = fs.existsSync(MEMORY) ? fs.readFileSync(MEMORY, 'utf8') : '';
  if (!existing.includes(`${MARK}:begin`) && !existing.includes(HEADING)) {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'global-claude-rule.md'), 'utf8');
    const rule = doc.match(/```markdown\n([\s\S]*?)\n```/)?.[1];
    if (rule) {
      const block = `<!-- ${MARK}:begin — delete this block to remove the rule -->\n${rule}\n<!-- ${MARK}:end -->\n`;
      const sep = !existing ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      writeAtomic(MEMORY, existing + sep + block);
      notes.push('claude-status-bar: phase rule added to ~/.claude/CLAUDE.md.');
    }
  }
} catch { /* same — a missing or unreadable CLAUDE.md is not worth a crash */ }

try { if (notes.length) process.stdout.write(notes.join(' ')); } catch { /* EPIPE */ }
