#!/usr/bin/env node
'use strict';
process.removeAllListeners('warning');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, 'ccs-find.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-find-test-'));
const projects = path.join(home, '.claude', 'projects');
const ctx = path.join(home, '.claude', 'session-context');

const find = (...args) => {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
// a transcript whose last record says where it ran, last touched `minutesAgo`
const session = (project, id, cwd, minutesAgo) => {
  const dir = path.join(projects, project);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, `{"type":"user","cwd":"/old/place"}\n{"type":"assistant","cwd":${JSON.stringify(cwd)}}\n`);
  const t = new Date(Date.now() - minutesAgo * 60000);
  fs.utimesSync(f, t, t);
};

try {
  const OLD = 'a3f90000-0000-4000-8000-000000000001';
  const NEW = 'a3f9ffff-0000-4000-8000-000000000002';
  const OTHER = 'b7e10000-0000-4000-8000-000000000003';
  session('-work-alpha', OLD, '/work/alpha', 60 * 24 * 20);
  session('-work-beta', NEW, '/work/beta', 5);
  session('-work-beta', OTHER, '/work/beta', 1);
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, NEW), 'Exec: tag the session\x1b[31m\n');

  // two share the prefix: the most recently active wins, the other is counted, not hidden
  let r = find('a3f9');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, NEW, 'most recent match did not win');
  assert.ok(r.err.includes('beta') && !r.err.includes('place'), `project is not the last cwd: ${r.err}`);
  assert.ok(r.err.includes('Exec: tag the session') && !r.err.includes('\x1b'), `phase missing or unsanitised: ${JSON.stringify(r.err)}`);
  assert.ok(r.err.includes('(+1 older)'), `older match not reported: ${r.err}`);

  // the tag as the bar prints it, upper case, and a longer prefix that tells them apart
  assert.equal(find('#A3F9').out, NEW, '"#" or upper case not accepted');
  assert.equal(find('a3f90000').out, OLD, 'a longer prefix did not narrow the match');
  assert.ok(!find('a3f90000').err.includes('older'), 'a unique match claimed older ones');

  // the latest activity decides, not creation: resuming the old one makes it the answer
  const oldFile = path.join(projects, '-work-alpha', `${OLD}.jsonl`);
  fs.utimesSync(oldFile, new Date(), new Date());
  assert.equal(find('a3f9').out, OLD, 'a resumed session did not take the tag back');

  // nothing found, and anything that is not a hex prefix, is refused without touching the disk
  assert.equal(find('c0de').code, 1, 'a miss did not exit 1');
  for (const bad of ['', 'a3f', '../x', 'a3f9*', 'zzzz', 'a3f9/../../etc']) {
    const b = find(bad);
    assert.equal(b.code, 2, `accepted ${JSON.stringify(bad)}`);
    assert.equal(b.out, '', `printed an id for ${JSON.stringify(bad)}`);
  }

  // no projects directory at all is a miss, not a crash
  fs.rmSync(projects, { recursive: true });
  assert.equal(find('a3f9').code, 1, 'missing projects dir was not a clean miss');

  console.log('ok — ccs-find');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
