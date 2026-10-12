#!/usr/bin/env node
// PermissionRequest: a dialog is waiting on you (a tool approval, AskUserQuestion, a plan to
// approve), so the Warp tab goes yellow now. The statusline cannot do it: Claude Code does not run
// it while a dialog is open (measured: no render from the request until the answer, in default and
// bypass mode alike), so the tab would keep saying "working" the whole time. The answer brings the
// statusline straight back; it finds the color recorded below changed and repaints from the
// transcript. Same gates and folders as the statusline's tab color (README "Warp tab color").
// Silent, and never decides anything: it prints nothing, so the dialog is untouched.
const fs = require('fs'), os = require('os'), path = require('path');
const { execSync } = require('child_process');
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    if (process.env.TERM_PROGRAM !== 'WarpTerminal' || process.platform === 'win32') return;
    const { session_id: id, cwd } = JSON.parse(s);
    if (!id || !/^[\w-]+$/.test(id) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
    const ctx = path.join(os.homedir(), '.claude', 'session-context');
    // a session with no phase label is never colored, by the statusline or here
    if (!/^[\p{L}\d&-]+:/u.test(fs.readFileSync(path.join(ctx, id), 'utf8').trim())) return;
    const dir = path.join(os.homedir(), '.warp', 'tab-colors', 'yellow');
    if (!fs.existsSync(dir)) return;
    const want = path.join(dir, cwd);
    fs.mkdirSync(want, { recursive: true });
    // The claude process's tty, found as the statusline finds it (our parent is that process).
    let tty = process.env.CCS_TTY, pid = process.ppid;
    const ps = f => execSync(`ps -o ${f}= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    for (let i = 0; !tty && i < 6 && pid > 1; i++) {
      const t = ps('tty');
      if (t && t !== '??') tty = `/dev/${t}`;
      else pid = Number(ps('ppid'));
    }
    if (!tty) return;
    fs.appendFileSync(tty, `\x1b]7;file://${os.hostname()}${want.split('/').map(encodeURIComponent).join('/')}\x07`);
    // the statusline's cache: "<claude pid> <folder sent>"
    fs.writeFileSync(path.join(ctx, `${id}.tabcolor`), `${process.env.CLAUDE_PID || ''} ${want}`);
  } catch {}
});
