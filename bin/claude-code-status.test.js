#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-test-'));
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
process.env.HOME = home;

const BIN = path.join(__dirname, 'claude-code-status.js');

// two content-block lines share one requestId (1000 tokens counted once), plus a second request of 200
const transcript = path.join(home, 'transcript.jsonl');
fs.writeFileSync(transcript, [
  '{"requestId":"req_a","message":{"usage":{"input_tokens":5,"output_tokens":1000,"output_tokens_details":{"thinking_tokens":10}}}}',
  '{"requestId":"req_a","message":{"usage":{"input_tokens":5,"output_tokens":1000,"output_tokens_details":{"thinking_tokens":10}}}}',
  '{"requestId":"req_b","message":{"usage":{"input_tokens":5,"output_tokens":200}}}',
].join('\n') + '\n');

// two changes open; the newer tasks.md is the one being worked
const chg = path.join(home, 'openspec', 'changes');
fs.mkdirSync(path.join(chg, 'stale-change'), { recursive: true });
fs.mkdirSync(path.join(chg, 'live-change'), { recursive: true });
fs.mkdirSync(path.join(chg, 'archive'), { recursive: true });
fs.writeFileSync(path.join(chg, 'stale-change', 'tasks.md'), '- [ ] a\n- [ ] b\n');
fs.utimesSync(path.join(chg, 'stale-change', 'tasks.md'), new Date(0), new Date(0));
fs.writeFileSync(path.join(chg, 'live-change', 'tasks.md'), '- [x] a\n- [X] b\n- [ ] c\n');
// newest of all, but untouched — a fresh /opsx:propose must not steal the bar
fs.mkdirSync(path.join(chg, 'just-proposed-change'), { recursive: true });
fs.writeFileSync(path.join(chg, 'just-proposed-change', 'tasks.md'), '- [ ] a\n- [ ] b\n');

// proposal written, tasks.md not yet — must stay visible in the "+N others" count, but rank last
fs.mkdirSync(path.join(chg, 'bare-proposal'), { recursive: true });
fs.writeFileSync(path.join(chg, 'bare-proposal', 'proposal.md'), '# p\n');

// the phase segment reads ~/.claude/session-context/<session_id>, and its mtime is the age shown
const SESSION = 'sess-test';
const phaseFile = path.join(home, '.claude', 'session-context', SESSION);
fs.mkdirSync(path.dirname(phaseFile), { recursive: true });
const setPhase = (text, minutesAgo = 0) => {
  fs.writeFileSync(phaseFile, text + '\n');
  const t = new Date(Date.now() - minutesAgo * 60000);
  fs.utimesSync(phaseFile, t, t);
};
setPhase('Exec: Compact the status bar');

const STDIN_JSON = JSON.stringify({
  session_id: SESSION,
  model: { display_name: 'M (1M context)' },
  workspace: { current_dir: home },
  context_window: { remaining_percentage: 50 },
  transcript_path: transcript,
  cost: { total_duration_ms: 600000, total_api_duration_ms: 20000 },
});

function render() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, HOME: home },
      cwd: home,
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(STDIN_JSON);
  });
}

async function main() {
  const out = await render();
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const [line1, line2] = plain.split('\n');

  assert.ok(line1.includes('M'), `model missing: ${JSON.stringify(plain)}`);
  assert.ok(!plain.includes('+0-0') && !/[+]\d+-\d+/.test(plain), `line churn still rendered: ${JSON.stringify(plain)}`);
  assert.ok(line2.includes('ctx '), `context segment missing: ${JSON.stringify(plain)}`);
  // remaining_percentage 50 -> 50% used, the same number /context reports (no 80%-budget rescale),
  // behind the one-cell gauge glyph off the '▁▁▂▃▄▅▆▇█' ramp (50% -> index 4 -> '▄')
  assert.ok(line2.includes('ctx ▄ 50%'), `context gauge missing: ${JSON.stringify(plain)}`);
  assert.ok(!plain.includes('░'), `old 8-block bar still rendered: ${JSON.stringify(plain)}`);
  // newest tasks.md wins, "archive" skipped, [x] and [X] both counted
  assert.ok(line2.startsWith('chg live-change 2/3 +3o'), `openspec change missing, or others not counted: ${JSON.stringify(plain)}`);
  assert.ok(!plain.includes('stale-change'), `stale change won over the newer one: ${JSON.stringify(plain)}`);
  assert.ok(!plain.includes('just-proposed'), `fresh proposal stole the bar: ${JSON.stringify(plain)}`);
  assert.ok(!plain.includes('bare-proposal'), `a change with no tasks.md stole the bar: ${JSON.stringify(plain)}`);
  assert.ok(!plain.includes('…'), `change id was truncated: ${JSON.stringify(plain)}`);

  // a phase written just now is the label alone — no age until it has stood long enough to doubt
  assert.ok(line1.startsWith('Exec: Compact the status bar'), `phase segment missing or not leading: ${JSON.stringify(line1)}`);
  assert.ok(!/Exec \d/.test(line1), `age shown on a fresh phase: ${JSON.stringify(line1)}`);

  // past 20 minutes the mtime is shown, so a label nobody has confirmed reads as one
  setPhase('Exec: Compact the status bar', 40);
  assert.ok((await render()).replace(/\x1b\[[0-9;]*m/g, '').startsWith('Exec 40m: Compact the status bar'),
    'time-in-phase not shown on a 40-minute-old phase');

  // past 90 minutes the label itself dims (SGR 2) — the subject stays at full brightness
  setPhase('Exec: Compact the status bar', 200);
  const old = await render();
  assert.ok(old.startsWith('\x1b[2;'), `stale phase label not dimmed: ${JSON.stringify(old.slice(0, 30))}`);
  assert.ok(old.replace(/\x1b\[[0-9;]*m/g, '').startsWith('Exec 3h20m: '), `stale phase age wrong: ${JSON.stringify(old)}`);

  // waiting on the user is the one state that has to carry across tabs: reverse-video chip
  setPhase('Needs-Review: approve the plan');
  assert.ok((await render()).startsWith('\x1b[1;7;38;5;226mNeeds-Review'), 'Needs-Review is not rendered as a chip');
  setPhase('Exec: Compact the status bar');

  // model display name is stripped of its parenthetical ("Opus 5 (1M context)" -> "Opus 5")
  assert.ok(!line1.includes('('), `model parenthetical not stripped: ${JSON.stringify(plain)}`);

  // every task checked -> the archive-me tick, not "3/3"
  fs.writeFileSync(path.join(chg, 'live-change', 'tasks.md'), '- [x] a\n- [X] b\n- [x] c\n');
  const done = (await render()).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(done.startsWith('chg live-change ✓'), `completed change not flagged for archive: ${JSON.stringify(done)}`);

  // archived changes drop off on the next render, with no restart
  fs.renameSync(path.join(chg, 'live-change'), path.join(chg, 'archive', '2026-08-28-live-change'));
  const archived = (await render()).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(!archived.includes('live-change'), `archived change still rendered: ${JSON.stringify(archived)}`);

  // 1200 output tokens / 20s of API time = 60 tok/s, last stat on line 2
  assert.ok(line2.endsWith('60 tok/s'), `tok/s missing from end of line 2: ${JSON.stringify(plain)}`);

  // tok/s is counted incrementally: the next render must read only the appended bytes and still
  // reach 2000/20s = 100, proving the sidecar carries the running total rather than recounting.
  fs.appendFileSync(transcript, '{"requestId":"req_c","message":{"usage":{"output_tokens":800}}}\n');
  const grown = (await render()).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(grown.endsWith('100 tok/s'), `incremental tok/s did not pick up the append: ${JSON.stringify(grown)}`);

  for (const token of ['| h:', '💧', '👀', '🚶', '☀️', "-hd"]) {
    assert.ok(!plain.includes(token), `removed health token rendered: ${token}`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'health-reminders.json')),
    'health state file was created');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'health-reminders.json.activity')),
    'health activity sidecar was created');
  console.log('ALL TESTS PASSED');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => fs.rmSync(home, { recursive: true, force: true }));
