#!/usr/bin/env node
// node hooks/session-context-guard.test.js — the guard must block ONLY when the model can
// actually fix it. Every other path fails open; a block nobody can satisfy just burns a turn.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const GUARD = path.join(__dirname, 'session-context-guard.js');
const ID = 'test-session-1';

const run = (setup, input = {}, env = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-'));
  const dir = path.join(home, '.claude', 'session-context');
  fs.mkdirSync(dir, { recursive: true });
  setup(dir);
  try {
    const out = execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ session_id: ID, ...input }), encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_CODE_ENTRYPOINT: 'cli', ...env },
    }).trim();
    return { out, dir };
  } finally {
    try { fs.chmodSync(dir, 0o700); } catch {}       // the read-only case must not leak an unremovable dir
    fs.rmSync(home, { recursive: true, force: true });
  }
};
const blocked = r => r.out && JSON.parse(r.out).decision === 'block';
const nothing = () => {};
const write = s => dir => fs.writeFileSync(path.join(dir, ID), s);

// blocks: the file is genuinely missing or blank, and the store is writable
const missing = run(nothing);
assert.ok(blocked(missing), 'missing file must block');
assert.ok(JSON.parse(missing.out).reason.includes(path.join(missing.dir, ID)),
  'the reason must name the resolved path — an unexpanded $CLAUDE_CODE_SESSION_ID writes a literal file');
assert.ok(blocked(run(write('   \n'))), 'whitespace-only must block');

// fails open: satisfied, or the block would be unsatisfiable / unsafe
assert.ok(!blocked(run(write('Exec: thing'))), 'written file must not block');
assert.ok(!blocked(run(nothing, { stop_hook_active: true })), 'must never block twice in a turn');
assert.ok(!blocked(run(nothing, { session_id: '../escape' })), 'bad session id must not block');
assert.ok(!blocked(run(nothing, {}, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })), 'non-cli harness must not block');
assert.ok(!blocked(run(dir => fs.symlinkSync('/etc/hosts', path.join(dir, ID)))),
  'symlink must not block — the instructed `>` would clobber its target');
assert.ok(!blocked(run(dir => fs.mkdirSync(path.join(dir, ID)))), 'directory at the path must not block');
assert.ok(!blocked(run(dir => fs.chmodSync(dir, 0o500))), 'read-only store must not block — nothing can be written');

console.log('ok — 10 assertions');
