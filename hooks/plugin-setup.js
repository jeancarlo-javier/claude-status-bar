#!/usr/bin/env node
// SessionStart hook: finish the install that `claude plugin install` can't do itself —
// point statusLine at this plugin's renderer, and teach the phase rule in ~/.claude/CLAUDE.md.
// Idempotent and silent once both are in place; never clobbers a foreign status line.
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.homedir(), '.claude');          // always ~/.claude, like the other scripts
const SETTINGS = path.join(HOME, 'settings.json');
const MEMORY = path.join(HOME, 'CLAUDE.md');
const RENDERER = path.join(ROOT, 'bin', 'claude-code-status.js');
const COMMAND = `node "${RENDERER}"`;
const MARK = 'claude-status-bar';                          // idempotency marker in CLAUDE.md

const writeAtomic = (p, s) => { fs.writeFileSync(p + '.tmp', s); fs.renameSync(p + '.tmp', p); };
const notes = [];

// ---- 1. statusLine ----
try {
  fs.mkdirSync(HOME, { recursive: true });
  const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
  const s = JSON.parse(raw || '{}');                       // a corrupt settings.json throws → we touch nothing
  const cur = s.statusLine?.command;
  if (!s.statusLine) {
    s.statusLine = { type: 'command', command: COMMAND };
    writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n');
    notes.push('claude-status-bar: status line configured — restart Claude Code to see it.');
  } else if (typeof cur === 'string' && cur.includes('claude-code-status') && !cur.includes(RENDERER)) {
    s.statusLine.command = COMMAND;                        // plugin updated → repoint at the new version
    writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  } else if (typeof cur === 'string' && !cur.includes('claude-code-status')) {
    notes.push('claude-status-bar: you already have a different statusLine, so it was left alone. ' +
               'Run /claude-status-bar:init to switch to this one.');
  }
} catch { /* never break a session over config I/O */ }

// ---- 2. the phase rule ----
try {
  const existing = fs.existsSync(MEMORY) ? fs.readFileSync(MEMORY, 'utf8') : '';
  if (!existing.includes(MARK) && !existing.includes('session-context/$CLAUDE_CODE_SESSION_ID')) {
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

if (notes.length) process.stdout.write(notes.join(' '));   // silent on every later session
