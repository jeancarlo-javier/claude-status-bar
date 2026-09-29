#!/usr/bin/env node
// ccs-find — resolve the "#a3f9" the status line shows back to its full session id.
//
//   node bin/ccs-find.js a3f9          -> prints the session id on stdout, details on stderr
//   claude --resume "$(node bin/ccs-find.js a3f9)"
//
// The tag is the session id's own prefix and transcripts are named <session_id>.jsonl, so the
// file names are the whole index: nothing is stored, nothing can go stale. Four hex digits do
// collide over weeks of sessions, so the match with the most recent activity (transcript mtime)
// wins — the tag you just read on a bar is almost always that one — and the rest are counted.

process.removeAllListeners('warning');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (process.argv[2] || '').replace(/^#/, '').toLowerCase();
// Hex and dashes only: the prefix is spliced into a file-name match, never a glob or a path.
if (!/^[0-9a-f][0-9a-f-]{3,35}$/.test(arg)) {
  process.stderr.write('usage: ccs-find <hex prefix of a session id, at least 4 chars, e.g. a3f9>\n');
  process.exit(2);
}

// Transcripts follow the config dir; the phase store is always ~/.claude (see README).
const roots = [...new Set([
  process.env.CLAUDE_CONFIG_DIR,
  path.join(os.homedir(), '.claude'),
].filter(Boolean).map(r => path.join(r, 'projects')))];

const hits = [];
for (const root of roots) {
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { continue; }
  for (const p of projects) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, p.name)); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith(arg) || !f.endsWith('.jsonl')) continue;
      const file = path.join(root, p.name, f);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) hits.push({ id: f.slice(0, -6), file, t: st.mtimeMs });
      } catch {}
    }
  }
}

if (!hits.length) {
  process.stderr.write(`no session starts with ${arg}\n`);
  process.exit(1);
}
hits.sort((a, b) => b.t - a.t);
const best = hits[0];

// The project is the transcript's last recorded cwd: the directory name encodes it lossily.
let project = '';
try {
  const fd = fs.openSync(best.file, 'r');
  const size = fs.fstatSync(fd).size, n = Math.min(size, 65536);
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, size - n);
  fs.closeSync(fd);
  const all = [...buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)];
  if (all.length) project = path.basename(JSON.parse(`"${all[all.length - 1][1]}"`));
} catch {}

let phase = '';
try {
  phase = fs.readFileSync(path.join(os.homedir(), '.claude', 'session-context', best.id), 'utf8')
    .split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80);
} catch {}

const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const more = hits.length > 1 ? `  (+${hits.length - 1} older)` : '';
process.stderr.write([project, phase, ago(best.t)].filter(Boolean).join('  ·  ') + more + '\n');
process.stdout.write(best.id + '\n');
