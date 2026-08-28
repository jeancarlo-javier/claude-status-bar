#!/usr/bin/env node
// node hooks/session-context-nudge.test.js — the nudge deletes files, so the rules it deletes by
// are worth pinning: old ones go, recent ones stay, this session's own file is never a candidate,
// and nothing but a regular file is ever removed. Pruning runs only on the branch that fires at
// the start of a session, so an ordinary turn must leave the store alone.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const NUDGE = path.join(__dirname, 'session-context-nudge.js');
const ID = 'test-session-1';
const days = n => new Date(Date.now() - n * 86400_000);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scn-'));
const dir = path.join(home, '.claude', 'session-context');
fs.mkdirSync(dir, { recursive: true });
const at = (name, age) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'Exec: thing');
  fs.utimesSync(f, days(age), days(age));
  return f;
};
const run = () => execFileSync(process.execPath, [NUDGE], {
  input: JSON.stringify({ session_id: ID }), encoding: 'utf8',
  env: { ...process.env, HOME: home },
}).trim();

// a new session: no phase file of its own, so the nudge asks for one — and prunes while it is here
at('ancient', 90);
at('old', 31);
at('recent', 29);
fs.mkdirSync(path.join(dir, 'a-directory'));   // never rmSync something that is not a file
assert.ok(run().includes('EMPTY'), 'a session with no phase file must be asked for one');
assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a-directory', 'recent'], 'wrong files pruned');

// same branch, reached because the file is unreadable rather than missing: its own file must survive
const own = at(ID, 400);
fs.chmodSync(own, 0o000);
at('old-again', 31);
try { run(); } finally { fs.chmodSync(own, 0o600); }
assert.ok(fs.existsSync(own), "the nudge pruned this session's own phase file");
assert.ok(!fs.existsSync(path.join(dir, 'old-again')), 'an unreadable phase file skipped the prune');

// an ordinary turn, phase file present and readable: the store is not walked at all
at('old-once-more', 31);
at(ID, 0);
run();
assert.ok(fs.existsSync(path.join(dir, 'old-once-more')), 'pruned on a turn that should stay silent');

fs.rmSync(home, { recursive: true, force: true });
console.log('ok — 6 assertions');
