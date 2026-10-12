#!/usr/bin/env node
// node hooks/tab-wait.test.js — a dialog paints the Warp tab yellow, with the statusline's gates:
// only in Warp, only for a session with a phase label, only once the yellow folder is installed.
// It must also record what it sent in the statusline's cache, or the statusline (which skips
// unchanged colors) would never repaint the tab once the dialog closes.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, 'tab-wait.js');
const ID = 'test-session-1';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
const ctx = path.join(home, '.claude', 'session-context');
fs.mkdirSync(ctx, { recursive: true });
const tty = path.join(home, 'tty');                       // stands in for the claude process's tty
const cwd = path.join(home, 'my project#1');
const yellow = path.join(home, '.warp', 'tab-colors', 'yellow');
const mirror = path.join(yellow, cwd);
const osc7 = `\x1b]7;file://${os.hostname()}${mirror.split('/').map(encodeURIComponent).join('/')}\x07`;
const cache = path.join(ctx, `${ID}.tabcolor`);
const run = (env = {}) => {
  fs.writeFileSync(tty, '');
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: ID, cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
    encoding: 'utf8', env: { ...process.env, HOME: home, CCS_TTY: tty, TERM_PROGRAM: 'WarpTerminal', CLAUDE_PID: '4242', ...env },
  });
  assert.strictEqual(out, '', 'the hook printed something, which Claude Code could read as a decision');
  return fs.readFileSync(tty, 'utf8');
};

try {
  fs.writeFileSync(path.join(ctx, ID), 'Exec: build it\n');
  assert.strictEqual(run(), '', 'tab colored with no yellow folder installed');
  fs.mkdirSync(yellow, { recursive: true });
  assert.strictEqual(run({ TERM_PROGRAM: 'iTerm.app' }), '', 'tab colored outside Warp');
  fs.writeFileSync(path.join(ctx, ID), 'no label at all\n');
  assert.strictEqual(run(), '', 'a session without a phase label was colored');
  fs.writeFileSync(path.join(ctx, ID), 'Exec: build it\n');
  assert.strictEqual(run(), osc7, 'a dialog did not point the tab at the yellow mirror of the cwd');
  assert.ok(fs.statSync(mirror).isDirectory(), 'yellow mirror of the cwd not created');
  // keyed by the claude process, the way the statusline keys it
  assert.strictEqual(fs.readFileSync(cache, 'utf8'), `4242 ${mirror}`, 'the statusline cache does not record the yellow sent');
  console.log('ok — 6 assertions');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
