#!/usr/bin/env node
// bin/claude-code-status.test.js — plain node + assert, no framework.
// Setup order matters: HOME is pinned before requiring the bin (HEALTH_STATE_PATH is computed
// at load time) and before any spawn.
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
const STATE = path.join(home, '.claude', 'health-reminders.json');
const SIDECAR = STATE + '.activity';

const health = require('./claude-code-status.js'); // pure helpers only — module.exports
const { normalizeState, dueList, deriveHealth, activityResume, HEALTH_REMINDERS } = health;
const EYES = HEALTH_REMINDERS.eyes.icon, WATER = HEALTH_REMINDERS.water.icon,
      MOVEMENT = HEALTH_REMINDERS.movement.icon, SUNLIGHT = HEALTH_REMINDERS.sunlight.icon;

const STDIN_JSON = JSON.stringify({
  model: { display_name: 'M' },
  workspace: { current_dir: home },
  context_window: { remaining_percentage: 50 },
});

function seedV2(overrides) {
  const now = Date.now();
  const s = {
    version: 2, startedAt: now,
    lastDone: { eyes: now, water: now, movement: now, sunlight: now },
    lastAckAt: 0, done: {},
    ...overrides,
  };
  fs.writeFileSync(STATE, JSON.stringify(s));
  return s;
}

function seedV1(overrides) {
  const now = Date.now();
  const s = {
    version: 1, startedAt: now, lastActivityAt: now,
    lastShown: { eyes: now, water: now, movement: now }, current: null,
    ...overrides,
  };
  fs.writeFileSync(STATE, JSON.stringify(s));
  return s;
}

function seedSidecar(content, mtimeMs) {
  fs.writeFileSync(SIDECAR, String(content));
  const t = mtimeMs / 1000;
  fs.utimesSync(SIDECAR, t, t);
}

function rmSidecar() { try { fs.unlinkSync(SIDECAR); } catch {} }

function render() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env: { ...process.env, HOME: home }, cwd: home });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(STDIN_JSON);
  });
}

function ack() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'done'], { env: { ...process.env, HOME: home }, cwd: home });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

// health is always the last segment on line 2 — presence check folded into every call.
function seg(out) {
  const line2 = out.split('\n')[1] || '';
  const m = line2.match(/health: (.*)$/);
  assert.ok(m, `no health segment found in output: ${JSON.stringify(out)}`);
  return m[1];
}

async function main() {
  // 1. Multi-bar agreement (the user's literal verification).
  {
    const now = Date.now();
    seedV2({
      startedAt: now - 30 * 60_000,
      lastDone: { eyes: now - 60 * 60_000, water: now - 60 * 60_000, movement: now - 60 * 60_000, sunlight: now },
      lastAckAt: 0, done: {},
    });
    seedSidecar('0', now);
    const outs = await Promise.all(Array.from({ length: 8 }, () => render()));
    const segs = outs.map(seg);
    const first = segs[0];
    for (const s of segs) assert.strictEqual(s, first, 'test1: segments not byte-identical');
    assert.ok(first.includes('☐ ' + EYES), 'test1: eyes not shown');
    assert.ok(first.includes("(send '-hd')"), 'test1: missing ack hint');
    assert.ok(first.includes('→ ' + WATER + MOVEMENT), 'test1: missing/wrong queue order');
    const iEyes = first.indexOf(EYES), iHint = first.indexOf("(send '-hd')"), iArrow = first.indexOf('→');
    assert.ok(iEyes < iHint && iHint < iArrow, 'test1: wrong element order');
    console.log('test 1 OK (multi-bar agreement)');
  }

  // 2. PROBE F reproduction, 30 rounds (floor 27 if wall time runs long).
  {
    const ROUNDS = 30, MIN_ROUNDS = 27, TIME_BUDGET_MS = 45_000;
    const t0 = Date.now();
    let round = 0;
    for (; round < ROUNDS; round++) {
      const now = Date.now();
      const seedEyes = now - 60 * 60_000;
      seedV2({
        startedAt: now - 30 * 60_000,
        lastDone: { eyes: seedEyes, water: now - 60 * 60_000, movement: now - 60 * 60_000, sunlight: now },
        lastAckAt: 0, done: {},
      });
      seedSidecar('0', now);

      const renderPromises = Array.from({ length: 8 }, () => render()); // renderers first...
      const ackPromise = ack();                                        // ...then the ack, same synchronous burst
      const [, ackOut] = await Promise.all([Promise.all(renderPromises), ackPromise]);

      assert.strictEqual(ackOut.trim(), `✅ ${EYES} done (1 today)`, `test2 round ${round}: ack mismatch: ${JSON.stringify(ackOut)}`);

      const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      assert.strictEqual(file.version, 2, `test2 round ${round}: not v2`);
      assert.ok(file.lastDone.eyes > seedEyes, `test2 round ${round}: lastDone.eyes not advanced`);
      const day = new Date(file.lastAckAt).toDateString();
      assert.strictEqual(file.done[day].eyes, 1, `test2 round ${round}: tally lost`);

      const postOuts = await Promise.all(Array.from({ length: 8 }, () => render()));
      const postSegs = postOuts.map(seg);
      const firstPost = postSegs[0];
      for (const s of postSegs) assert.strictEqual(s, firstPost, `test2 round ${round}: post-ack segments not identical`);
      assert.ok(firstPost.includes('☐ ' + WATER), `test2 round ${round}: post-ack top slot not water`);
      assert.ok(firstPost.includes('→ ' + MOVEMENT), `test2 round ${round}: post-ack queue missing movement`);
      assert.ok(firstPost.includes('· ' + EYES + ' 1'), `test2 round ${round}: post-ack tally missing`);

      if (round + 1 >= MIN_ROUNDS && Date.now() - t0 > TIME_BUDGET_MS) { round++; break; }
    }
    console.log(`test 2 OK (PROBE F, ${round} rounds)`);
  }

  // 3. PROBE E via the real CLI.
  {
    const now = Date.now();
    seedV1({
      lastActivityAt: now - 5 * 60_000,
      lastShown: { eyes: now - 25 * 60_000, water: now, movement: now },
      lastEndedAt: now - 2 * 60_000,
      current: null,
    });
    rmSidecar();
    const out = await render();
    const s = seg(out);
    assert.ok(s.includes('☐ ' + EYES), 'test3: pending eyes reminder rendered as nothing');
    const sidecarContent = fs.readFileSync(SIDECAR, 'utf8');
    assert.strictEqual(sidecarContent, '0', 'test3: sidecar not seeded from recent legacy activity');
    console.log('test 3 OK (PROBE E via CLI)');
  }

  // 4. v1 idle migration.
  {
    const now = Date.now();
    seedV1({
      lastActivityAt: now - 10 * 60 * 60_000,
      lastShown: { eyes: now - 10 * 60 * 60_000, water: now - 10 * 60 * 60_000, movement: now - 10 * 60 * 60_000 },
      current: null,
    });
    rmSidecar();
    const t0 = Date.now();
    const out = await render();
    const t1 = Date.now();
    const s = seg(out);
    assert.ok(s.includes('\x1b[2m✓'), 'test4: not dim after idle migration');
    const sidecarContent = Number(fs.readFileSync(SIDECAR, 'utf8'));
    assert.ok(sidecarContent >= t0 && sidecarContent <= t1, 'test4: sidecar not seeded within render window');
    console.log('test 4 OK (v1 idle migration)');
  }

  // 5. Sidecar deletion cannot resurrect.
  {
    const now = Date.now();
    seedV2({
      startedAt: now - 10 * 60 * 60_000,
      lastDone: { eyes: now - 10 * 60 * 60_000, water: now - 10 * 60 * 60_000, movement: now - 10 * 60 * 60_000, sunlight: now - 10 * 60 * 60_000 },
      lastAckAt: 0, done: {},
    });
    rmSidecar();
    const t0 = Date.now();
    const out = await render();
    const t1 = Date.now();
    const s = seg(out);
    assert.ok(s.includes('\x1b[2m✓'), 'test5: sidecar deletion resurrected the queue');
    const sidecarContent = Number(fs.readFileSync(SIDECAR, 'utf8'));
    assert.ok(sidecarContent >= t0 && sidecarContent <= t1, 'test5: sidecar not recreated within render window');
    console.log('test 5 OK (sidecar deletion)');
  }

  // 6. Corrupt JSON.
  {
    const now = Date.now();
    fs.writeFileSync(STATE, '{oops');
    const mt = (now - 30 * 60_000) / 1000;
    fs.utimesSync(STATE, mt, mt);
    seedSidecar('0', now);
    const out1 = await render();
    const out2 = await render();
    const s1 = seg(out1), s2 = seg(out2);
    assert.strictEqual(s1, s2, 'test6: renders over corrupt file not identical (mtime baseline unstable)');
    assert.ok(s1.includes('☐ ' + EYES), 'test6: corrupt-file mtime baseline did not make eyes due');
    const ackOut = await ack();
    assert.strictEqual(ackOut.trim(), `✅ ${EYES} done (1 today)`, 'test6: ack over corrupt file mismatch');
    const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    assert.strictEqual(file.version, 2, 'test6: corrupt file not repaired to clean v2');
    const day = new Date(file.lastAckAt).toDateString();
    assert.strictEqual(file.done[day].eyes, 1, 'test6: tally missing after repair');
    console.log('test 6 OK (corrupt JSON)');
  }

  // 7. Idle reset via CLI.
  {
    const now = Date.now();
    seedV2({
      startedAt: now - 10 * 60 * 60_000,
      lastDone: { eyes: now - 10 * 60 * 60_000, water: now - 10 * 60 * 60_000, movement: now - 10 * 60 * 60_000, sunlight: now - 10 * 60 * 60_000 },
      lastAckAt: 0, done: {},
    });
    seedSidecar('0', now - 100 * 60_000);
    const t0 = Date.now();
    const out = await render();
    const t1 = Date.now();
    const s = seg(out);
    assert.ok(s.includes('\x1b[2m✓'), 'test7: idle reset did not clear the queue');
    const sidecarContent = Number(fs.readFileSync(SIDECAR, 'utf8'));
    assert.ok(sidecarContent >= t0 && sidecarContent <= t1, 'test7: sidecar not reset within render window');
    console.log('test 7 OK (idle reset via CLI)');
  }

  // 8. Migration history.
  {
    const now = Date.now();
    const oldDone = {
      'Mon Jan 01 2024': { eyes: 3, water: 2 },
      'Tue Jan 02 2024': { movement: 1 },
    };
    seedV1({
      lastActivityAt: now,
      lastShown: { eyes: now - 25 * 60_000, water: now, movement: now },
      current: null,
      done: oldDone,
    });
    rmSidecar(); // fresh legacy activity (now) → sidecarSeed = 0, exercised via the missing-file path
    const ackOut = await ack();
    assert.strictEqual(ackOut.trim(), `✅ ${EYES} done (1 today)`, 'test8: ack mismatch');
    const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    assert.strictEqual(file.version, 2, 'test8: not migrated to v2');
    const day = new Date(file.lastAckAt).toDateString();
    assert.deepStrictEqual(file.done, { ...oldDone, [day]: { eyes: 1 } }, 'test8: done map mismatch after migration');
    console.log('test 8 OK (migration history)');
  }

  // 9. Deterministic schedule (pure deriveHealth/dueList, fixed T = local 12:00).
  {
    const d0 = new Date();
    const T = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 12).getTime();
    const today = new Date(T).toDateString();

    const build = (lastDoneOverrides, startedAt = T) => normalizeState({
      version: 2, startedAt,
      lastDone: { eyes: T, water: T, movement: T, sunlight: T, ...lastDoneOverrides },
      lastAckAt: 0, done: {},
    }, T, T);

    assert.ok(deriveHealth(build({ eyes: T - 19 * 60_000 }), T, 0).includes('\x1b[2m✓'), 'test9: eyes 19m should be dim');
    assert.ok(deriveHealth(build({ eyes: T - 20 * 60_000 }), T, 0).includes('☐ ' + EYES), 'test9: eyes 20m should be due');
    assert.ok(deriveHealth(build({ water: T - 44 * 60_000 }), T, 0).includes('\x1b[2m✓'), 'test9: water 44m should be dim');
    assert.ok(deriveHealth(build({ water: T - 45 * 60_000 }), T, 0).includes('☐ ' + WATER), 'test9: water 45m should be due');
    assert.ok(deriveHealth(build({ movement: T - 49 * 60_000 }), T, 0).includes('\x1b[2m✓'), 'test9: movement 49m should be dim');
    assert.ok(deriveHealth(build({ movement: T - 50 * 60_000 }), T, 0).includes('☐ ' + MOVEMENT), 'test9: movement 50m should be due');

    const s60 = build({ eyes: T - 60 * 60_000, water: T - 60 * 60_000, movement: T - 60 * 60_000 });
    const out60 = deriveHealth(s60, T, 0);
    assert.ok(out60.includes('☐ ' + EYES), 'test9: top slot should stay eyes-first when all overdue');
    assert.ok(out60.includes("(send '-hd')"), 'test9: ack hint missing');
    assert.ok(out60.includes('→ ' + WATER + MOVEMENT), 'test9: queue missing/wrong order');

    // chained acks
    let s = build({ eyes: T - 60 * 60_000, water: T - 60 * 60_000, movement: T - 60 * 60_000 });
    s.lastDone.eyes = T; s.done[today] = { eyes: 1 };
    let out = deriveHealth(s, T, 0);
    assert.ok(out.includes('☐ ' + WATER), 'test9 chained: water should be top after eyes ack');
    assert.ok(out.includes('→ ' + MOVEMENT), 'test9 chained: movement should be queued');

    s.lastDone.water = T; s.done[today].water = 1;
    out = deriveHealth(s, T, 0);
    assert.ok(out.includes('☐ ' + MOVEMENT), 'test9 chained: movement should be top after water ack');
    assert.ok(!out.includes('→'), 'test9 chained: unexpected queue with only movement due');

    s.lastDone.movement = T; s.done[today].movement = 1; s.lastAckAt = T;
    out = deriveHealth(s, T, 0);
    assert.ok(out.startsWith('✅'), 'test9 chained: should flash ✅ once nothing is due');
    assert.ok(out.includes(EYES + ' 1') && out.includes(WATER + ' 1') && out.includes(MOVEMENT + ' 1'), 'test9 chained: tally incomplete on flash');

    out = deriveHealth(s, T + 61_000, 0);
    assert.ok(out.includes('\x1b[2m✓'), 'test9 chained: should be dim past the ack-flash window');
    assert.ok(out.includes(EYES + ' 1') && out.includes(WATER + ' 1') && out.includes(MOVEMENT + ' 1'), 'test9 chained: tally lost past flash window');

    // 90-min resume
    const sOld = build({ eyes: T - 10 * 60 * 60_000, water: T - 10 * 60 * 60_000, movement: T - 10 * 60 * 60_000, sunlight: T - 10 * 60 * 60_000 }, T - 10 * 60 * 60_000);
    assert.ok(deriveHealth(sOld, T, T).includes('\x1b[2m✓'), 'test9: resumeAt boundary should clear an old queue');

    console.log('test 9 OK (deterministic schedule)');
  }

  // 10. Sunlight edges (pure, fixed local times).
  {
    const d0 = new Date();
    const atLocal = (h, m, dayOffset = 0) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + dayOffset, h, m, 0, 0).getTime();
    const midnight = atLocal(0, 0);

    const sunlightOnly = (now) => normalizeState({
      version: 2, startedAt: midnight,
      lastDone: { eyes: now, water: now, movement: now, sunlight: midnight },
      lastAckAt: 0, done: {},
    }, midnight, now);

    const t0959 = atLocal(9, 59), t1000 = atLocal(10, 0), t1659 = atLocal(16, 59), t1700 = atLocal(17, 0);
    assert.ok(deriveHealth(sunlightOnly(t0959), t0959, 0).includes('\x1b[2m✓'), 'test10: 09:59 should be dim (outside window)');
    assert.ok(deriveHealth(sunlightOnly(t1000), t1000, 0).includes('☐ ' + SUNLIGHT), 'test10: 10:00 sunlight should be due');
    assert.ok(deriveHealth(sunlightOnly(t1659), t1659, 0).includes('☐ ' + SUNLIGHT), 'test10: 16:59 sunlight should be due');
    assert.ok(deriveHealth(sunlightOnly(t1700), t1700, 0).includes('\x1b[2m✓'), 'test10: 17:00 sunlight should vanish (documented exemption)');

    // ack-across-17:00: sunlight overdue all day; water becomes due exactly at 17:00, not before
    const waterLastDone = atLocal(16, 15);
    const sCross = normalizeState({
      version: 2, startedAt: midnight,
      lastDone: { eyes: t1659, water: waterLastDone, movement: t1659, sunlight: midnight },
      lastAckAt: 0, done: {},
    }, midnight, t1700);
    assert.strictEqual(dueList(sCross, t1659, 0)[0], 'sunlight', 'test10: 16:59 top should be sunlight');
    assert.strictEqual(dueList(sCross, t1700, 0)[0], 'water', 'test10: 17:00 top should be water (sunlight excluded)');

    // midnight tally rollover
    const t2359 = atLocal(23, 59), t0001next = atLocal(0, 1, 1);
    const todayKey = new Date(t2359).toDateString();
    const sTally = normalizeState({
      version: 2, startedAt: midnight,
      lastDone: { eyes: t2359, water: t2359, movement: t2359, sunlight: t2359 },
      lastAckAt: 0, done: { [todayKey]: { eyes: 3 } },
    }, midnight, t2359);
    assert.ok(deriveHealth(sTally, t2359, 0).includes(EYES + ' 3'), 'test10: tally should show at 23:59');
    assert.ok(!deriveHealth(sTally, t0001next, 0).includes(EYES + ' 3'), 'test10: tally should be gone the next day');

    // next eligible window
    const sunlightDoneDay1 = atLocal(11, 0, 0), checkDay2 = atLocal(10, 30, 1);
    const sNextWindow = normalizeState({
      version: 2, startedAt: sunlightDoneDay1,
      lastDone: { eyes: checkDay2, water: checkDay2, movement: checkDay2, sunlight: sunlightDoneDay1 },
      lastAckAt: 0, done: {},
    }, sunlightDoneDay1, checkDay2);
    assert.ok(deriveHealth(sNextWindow, checkDay2, 0).includes('☐ ' + SUNLIGHT), 'test10: sunlight should be due again in the next window');

    console.log('test 10 OK (sunlight edges)');
  }

  // 11. Hostile-state never blanks (pure).
  {
    const d0 = new Date();
    const T = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 12).getTime();
    const today = new Date(T).toDateString();

    const hostileList = [
      {},
      { version: 2 },
      { version: 2, done: { [today]: { bogus: 3, eyes: 'x' } } },
      { version: 2, startedAt: T + 1e12 },
      [],
      { version: 1 },
    ];
    for (const X of hostileList) {
      const s = normalizeState(X, T, T);
      const out = deriveHealth(s, T, 0);
      assert.ok(out.length > 0, `test11: empty string for ${JSON.stringify(X)}`);
      assert.ok(!out.includes('undefined'), `test11: rendered "undefined" for ${JSON.stringify(X)}`);
    }

    const sFuture = normalizeState({ version: 2, startedAt: T + 1e12 }, T, T);
    assert.ok(sFuture.startedAt <= T, 'test11: future startedAt not clamped to ≤ now');

    const sMtime = normalizeState({}, T + 1e12, T);
    assert.ok(sMtime.startedAt <= T, 'test11: future mtime baseline not clamped');
    assert.ok(!deriveHealth(sMtime, T, 0).includes('undefined'), 'test11: undefined with future mtime baseline');

    const sAck = normalizeState({ version: 2, lastAckAt: Infinity, lastDone: { eyes: T, water: T, movement: T, sunlight: T } }, T, T);
    assert.strictEqual(sAck.lastAckAt, 0, 'test11: Infinity lastAckAt not normalized to 0');
    const outAck = deriveHealth(sAck, T, 0);
    assert.ok(outAck.includes('\x1b[2m✓'), 'test11: should render dim, not ✅, for a normalized lastAckAt');
    assert.ok(!outAck.startsWith('✅'), 'test11: should not render ✅ for Infinity lastAckAt');

    const sNaN = normalizeState({}, NaN, T);
    assert.strictEqual(sNaN.startedAt, T, 'test11: NaN base should fall back to now');
    const sInf = normalizeState({}, Infinity, T);
    assert.strictEqual(sInf.startedAt, T, 'test11: Infinity base should fall back to now');
    assert.ok(!deriveHealth(sNaN, T, 0).includes('undefined'), 'test11: undefined with NaN base');
    assert.ok(!deriveHealth(sInf, T, 0).includes('undefined'), 'test11: undefined with Infinity base');

    const sExtreme = normalizeState({ version: 2, startedAt: -Number.MAX_VALUE }, -Number.MAX_VALUE, Number.MAX_VALUE);
    const outExtreme = deriveHealth(sExtreme, Number.MAX_VALUE, 0);
    assert.ok(outExtreme.length > 0, 'test11: empty string for opposite-sign finite extremes');
    assert.ok(!outExtreme.includes('undefined'), 'test11: rendered "undefined" for opposite-sign finite extremes');

    console.log('test 11 OK (hostile state never blanks)');
  }

  // 12. Sidecar garbage repair via CLI.
  {
    const contents = ['', 'garbage', '-5', String(Date.now() + 1e9)];
    for (const content of contents) {
      const now = Date.now();
      seedV2({
        startedAt: now,
        lastDone: { eyes: now, water: now, movement: now, sunlight: now },
        lastAckAt: 0, done: {},
      });
      fs.writeFileSync(SIDECAR, content);
      const t = now / 1000;
      fs.utimesSync(SIDECAR, t, t);
      const t0 = Date.now();
      const out = await render();
      const t1 = Date.now();
      const s = seg(out);
      assert.ok(s.includes('\x1b[2m✓'), `test12: segment not present/dim for content=${JSON.stringify(content)}`);
      const repaired = Number(fs.readFileSync(SIDECAR, 'utf8'));
      assert.ok(repaired >= t0 && repaired <= t1, `test12: sidecar not repaired within render window for content=${JSON.stringify(content)}`);
    }
    console.log('test 12 OK (sidecar garbage repair)');
  }

  // 13. Hostile ack targets via CLI (the JSON.stringify([]) traps).
  {
    // a. done: []
    {
      const now = Date.now();
      seedV2({
        startedAt: now - 30 * 60_000,
        lastDone: { eyes: now - 25 * 60_000, water: now, movement: now, sunlight: now },
        lastAckAt: 0, done: [],
      });
      seedSidecar('0', now);
      const ackOut = await ack();
      assert.strictEqual(ackOut.trim(), `✅ ${EYES} done (1 today)`, 'test13a: ack mismatch');
      const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      assert.ok(file.done && typeof file.done === 'object' && !Array.isArray(file.done), 'test13a: done not a plain object');
      const day = new Date(file.lastAckAt).toDateString();
      assert.strictEqual(file.done[day].eyes, 1, 'test13a: tally lost to array-shaped done');
    }
    // b. done: { [today]: [] }
    {
      const now = Date.now();
      const day0 = new Date(now).toDateString();
      seedV2({
        startedAt: now - 30 * 60_000,
        lastDone: { eyes: now - 25 * 60_000, water: now, movement: now, sunlight: now },
        lastAckAt: 0, done: { [day0]: [] },
      });
      seedSidecar('0', now);
      const ackOut = await ack();
      assert.strictEqual(ackOut.trim(), `✅ ${EYES} done (1 today)`, 'test13b: ack mismatch');
      const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const day = new Date(file.lastAckAt).toDateString();
      assert.ok(!Array.isArray(file.done[day]), 'test13b: done[day] is array-shaped');
      assert.strictEqual(file.done[day].eyes, 1, 'test13b: tally lost to array-shaped done[day]');
    }
    // c. done: { [today]: { eyes: -2 } }
    {
      const now = Date.now();
      const day0 = new Date(now).toDateString();
      seedV2({
        startedAt: now - 30 * 60_000,
        lastDone: { eyes: now - 25 * 60_000, water: now, movement: now, sunlight: now },
        lastAckAt: 0, done: { [day0]: { eyes: -2 } },
      });
      seedSidecar('0', now);
      const ackOut = await ack();
      assert.strictEqual(ackOut.trim(), `✅ ${EYES} done (1 today)`, 'test13c: ack mismatch');
      const file = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const day = new Date(file.lastAckAt).toDateString();
      assert.strictEqual(file.done[day].eyes, 1, 'test13c: negative count not reset to 0 before increment');
    }
    console.log('test 13 OK (hostile ack targets)');
  }

  // 14. Unreadable ≠ corrupt (skip when running as root).
  if (process.getuid && process.getuid() === 0) {
    console.log('test 14 SKIPPED (running as root — chmod 000 has no effect)');
  } else {
    const now = Date.now();
    const day0 = new Date(now).toDateString();
    seedV2({
      startedAt: now - 30 * 60_000,
      lastDone: { eyes: now, water: now, movement: now, sunlight: now },
      lastAckAt: 0, done: { [day0]: { eyes: 5 } },
    });
    const originalBytes = fs.readFileSync(STATE, 'utf8');
    fs.chmodSync(STATE, 0o000);
    try {
      const out = await render();
      const s = seg(out);
      assert.ok(s.includes('\x1b[2m✓'), 'test14: unreadable file should degrade to dim ✓, not a fabricated reminder');
      const ackOut = await ack();
      assert.strictEqual(ackOut.trim(), 'could not update health state', 'test14: ack should refuse an unreadable state file');
    } finally {
      fs.chmodSync(STATE, 0o644);
    }
    const afterBytes = fs.readFileSync(STATE, 'utf8');
    assert.strictEqual(afterBytes, originalBytes, 'test14: unreadable file was modified by the ack attempt');
    console.log('test 14 OK (unreadable ≠ corrupt)');
  }

  // 15. Sidecar EEXIST loser reading empty content (deterministic, in-process).
  {
    rmSidecar();
    const T15 = Date.now();
    const origWriteFileSync = fs.writeFileSync;
    let armed = true;
    fs.writeFileSync = function (file, data, options) {
      if (armed && file === SIDECAR && options && options.flag === 'wx') {
        armed = false; // exactly once
        origWriteFileSync(file, ''); // simulate the wx winner's dir entry appearing before its content lands
        return origWriteFileSync(file, data, options); // now throws a genuine EEXIST
      }
      return origWriteFileSync.apply(fs, arguments);
    };
    try {
      const result = activityResume(T15, 0);
      assert.strictEqual(result, T15, 'test15: activityResume should return T after the validated repair');
      const repaired = fs.readFileSync(SIDECAR, 'utf8');
      assert.strictEqual(repaired, String(T15), 'test15: sidecar not atomically repaired to String(T)');
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }
    console.log('test 15 OK (sidecar EEXIST loser)');
  }

  console.log('ALL TESTS PASSED');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => fs.rmSync(home, { recursive: true, force: true }));
