#!/usr/bin/env node
// claude-code-status — Jeancarlo's Claude Code statusline
// | = section, · = inline stat

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HEALTH_STATE_PATH = path.join(os.homedir(), '.claude', 'health-reminders.json');
const HEALTH_ACTIVITY_PATH = HEALTH_STATE_PATH + '.activity'; // mtime = a bar rendered; content = last resume boundary
const HEALTH_IDLE_MS = 90 * 60_000;
const HEALTH_ACK_FLASH_MS = 60_000;
const HEALTH_TOUCH_MS = 60_000;
// as a prompt; the UserPromptSubmit hook checks the reminder off. \x1b[39m = default fg, then back to the segment's cyan
const ACK_HINT = " \x1b[39m(send '-hd')\x1b[36m";
const HEALTH_REMINDERS = {
  eyes:     { icon: '👀', interval: 20 * 60_000, phrases: ['look far for 20s', 'rest your eyes'] }, // 20-20-20 rule
  water:    { icon: '💧', interval: 45 * 60_000, phrases: ['drink water', 'take a water sip'] },
  movement: { icon: '🚶', interval: 50 * 60_000, phrases: ['stand and move', 'check posture, roll shoulders'] },  // offset from water to avoid ties
  sunlight: { icon: '☀️', interval: 180 * 60_000, hours: [10, 17], phrases: ['get some sunlight', 'step outside 5 min'] },
};

const atomicWrite = (file, str) => {
  const tmp = `${file}.${process.pid}.tmp`; // pid-scoped: concurrent writers can't interleave
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);
};
const writeHealthState = (s) => atomicWrite(HEALTH_STATE_PATH, JSON.stringify(s));

// one normalizer for v1, v2, partial, hand-edited, and corrupt-with-mtime-baseline reads.
// `now` is injected so fixed-clock tests are deterministic; callers on the render/ack path
// thread their own `now` through. Post-condition (precondition: finite `now`; ANY `base`):
// startedAt finite ≤ now; lastDone has all 4 categories finite; done and every done[day]
// are NON-ARRAY objects holding only finite counts > 0; lastAckAt finite (else 0).
// deriveHealth/ackDone rely on exactly this.
const normalizeState = (raw, base, now = Date.now()) => {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}; // [] passes typeof-object
  if (!Number.isFinite(base)) base = now; // R3-1: a NaN/±Infinity baseline must never become startedAt
  let startedAt = Number(src.startedAt);
  if (!Number.isFinite(startedAt) || startedAt > now) startedAt = Math.min(base, now); // future mtime never becomes startedAt
  const from = (src.version === 2 ? src.lastDone : src.lastShown) || {}; // v1 lastShown ≈ last satisfied
  const lastDone = {};
  for (const cat of Object.keys(HEALTH_REMINDERS)) {
    const t = Number(from[cat]);
    lastDone[cat] = Number.isFinite(t) ? t : startedAt; // v1 files lack sunlight → seeded here
  }
  const done = {};
  if (src.done && typeof src.done === 'object' && !Array.isArray(src.done))
    for (const [day, rec] of Object.entries(src.done)) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue; // JSON.stringify([]) drops keys → tally would vanish
      const clean = {};
      for (const [c, v] of Object.entries(rec)) { const k = Number(v); if (Number.isFinite(k) && k > 0) clean[c] = k; }
      if (Object.keys(clean).length) done[day] = clean;
    }
  const ack = Number(src.lastAckAt);
  return { version: 2, startedAt, lastDone, done,
           lastAckAt: Number.isFinite(ack) ? ack : 0, // Infinity must not pin ✅ forever
           legacyActivityAt: Number(src.lastActivityAt) || 0 }; // transient: seeds a missing sidecar; never persisted
};

const readHealthState = (now = Date.now(), retried) => {
  let mt = 0; try { mt = fs.statSync(HEALTH_STATE_PATH).mtimeMs; } catch {}
  let bytes;
  try { bytes = fs.readFileSync(HEALTH_STATE_PATH, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT')
      // case UNREADABLE (EACCES, EISDIR, …): the file may be weeks of valid history we just
      // can't see. In-memory state seeded at now; `unreadable` makes ackDone refuse to write
      // over it. NOT the mtime baseline — no fabricated due reminders.
      return { ...normalizeState({ startedAt: now }, now, now), unreadable: true };
    // case MISSING (ENOENT): seed exactly once
    if (!retried) {
      try { fs.writeFileSync(HEALTH_STATE_PATH, JSON.stringify({ version: 2, startedAt: now,
            lastDone: { eyes: now, water: now, movement: now, sunlight: now }, lastAckAt: 0, done: {} }),
            { flag: 'wx' }); }
      catch (e2) { if (e2.code === 'EEXIST') return readHealthState(now, true); } // loser re-reads: SAME normalizer, SAME now
    }
    return normalizeState({ startedAt: now }, now, now); // read-only FS degrades to permanent dim ✓
  }
  // bytes read OK from here on — a throw below is CORRUPT JSON, not an I/O failure
  try { return normalizeState(JSON.parse(bytes), mt || now, now); } // Part B: normalizeState owns shape checks
  catch { return normalizeState({}, mt || now, now); } // case CORRUPT: mtime is a STABLE baseline — reminders
                                                       // still become due; the next ack atomically repairs the file
};

// due categories, most-overdue first — deterministic for a given (state, now, resumeAt)
const dueList = (s, now, resumeAt) => {
  const last = (cat) => Math.min(now, Math.max(s.lastDone[cat], resumeAt)); // clock-skew clamp; normalizer guarantees the key
  return Object.entries(HEALTH_REMINDERS)
    .filter(([cat, cfg]) => {
      if (cfg.hours) { const h = new Date(now).getHours(); if (h < cfg.hours[0] || h >= cfg.hours[1]) return false; }
      return now - last(cat) >= cfg.interval;
    })
    .sort((a, b) => (now - last(b[0]) - b[1].interval) - (now - last(a[0]) - a[1].interval))
    .map(([cat]) => cat);
};

const sidecarSeed = (s, now) => s.legacyActivityAt
  ? (now - s.legacyActivityAt > HEALTH_IDLE_MS ? now : 0) // v1 upgrade: honor the legacy idle gap
  : now; // v2/fresh/corrupt: a missing sidecar must not resurrect a cleared queue

// ponytail: sidecar = liveness (mtime) + resume boundary (content); every failure degrades to
// "no reset this render" and repairs next render — never throws; one bounded retry, no loop
const activityResume = (now, seed, retried) => {
  let st, raw;
  try { st = fs.statSync(HEALTH_ACTIVITY_PATH); raw = fs.readFileSync(HEALTH_ACTIVITY_PATH, 'utf8'); }
  catch {
    if (retried) return seed; // second read failure: give up for this render
    try { fs.writeFileSync(HEALTH_ACTIVITY_PATH, String(seed), { flag: 'wx' }); return seed; } // exactly-once seed
    catch (e) {
      if (e.code === 'EEXIST') return activityResume(now, seed, true); // a wx winner may expose the entry before its
                                                                       // write lands — re-read via the validation below
      return seed; // read-only FS: no reset tracking this render
    }
  }
  const r = Number(raw);
  const bad = raw.trim() === '' || !Number.isFinite(r) || r < 0 || r > now + 60_000;
  if (bad || now - st.mtimeMs > HEALTH_IDLE_MS) { // garbage/empty content → boundary unknown → repair to now;
    try { atomicWrite(HEALTH_ACTIVITY_PATH, String(now)); } catch {} // idle gap → new boundary. Atomic: no truncate window
    return now;
  }
  if (now - st.mtimeMs > HEALTH_TOUCH_MS) try { fs.utimesSync(HEALTH_ACTIVITY_PATH, now / 1000, now / 1000); } catch {}
  return r;
};

// pure: any process evaluating the same (state, now, resumeAt) derives the identical string.
// Invariant: given a normalizeState'd s, never throws, never returns '' for any finite now:
//  - done + every done[day] are non-array objects with finite counts > 0 (normalizer);
//    the typeof guard below is belt-and-braces only
//  - tally filters unknown categories: HEALTH_REMINDERS[c].icon cannot throw
//  - startedAt finite ≤ read-time now (normalizer); elapsed clamped ≥ 0 below (a render-now a
//    few ms behind the read-now), and the phrase index is pinned to 0|1 — even a subtraction
//    overflowing to Infinity at opposite-sign finite extremes (raw index NaN) renders
//    phrases[0], never phrases[NaN] (R3-1)
//  - lastAckAt finite (normalizer) → the ✅-flash comparison is well-defined
//  - dueList only returns keys of HEALTH_REMINDERS → cfg is always defined
const deriveHealth = (s, now, resumeAt) => {
  const today = s.done[new Date(now).toDateString()];
  const items = today && typeof today === 'object'
    ? Object.entries(today).filter(([c, n]) => HEALTH_REMINDERS[c] && n > 0)
        .map(([c, n]) => HEALTH_REMINDERS[c].icon + ' ' + n) : [];
  const tally = items.length ? ' · ' + items.join(' ') : '';
  const due = dueList(s, now, resumeAt);
  if (!due.length) {
    if (now - s.lastAckAt < HEALTH_ACK_FLASH_MS) return '✅' + tally;
    return '\x1b[2m✓' + tally + '\x1b[22m'; // always-present idle: line 2 never reshuffles
  }
  const cfg = HEALTH_REMINDERS[due[0]];
  const i = Math.floor(Math.max(0, now - s.startedAt) / cfg.interval) % 2; // NaN if elapsed overflowed to Infinity
  const phrase = '☐ ' + cfg.icon + ' ' + cfg.phrases[i === 1 ? 1 : 0];     // R3-1: index pinned to 0|1
  const q = due.slice(1).map(c => HEALTH_REMINDERS[c].icon).join('');
  return phrase + ACK_HINT + (q ? ' → ' + q : '') + tally;
};

const selectHealthPhrase = (now) => {
  // ponytail: renders never write the JSON — acks are the only writers, so a stale render
  // cannot clobber a concurrent ack; upgrade path: lockfile, if a second writer ever appears
  try { const s = readHealthState(now); return deriveHealth(s, now, activityResume(now, sidecarSeed(s, now))); }
  catch { return '\x1b[2m✓\x1b[22m'; } // last resort: the segment is still present
};

// `claude-code-status done` — check off what every bar is showing (top of the due list)
const ackDone = (now) => {
  try {
    const s = readHealthState(now);
    if (s.unreadable) return 'could not update health state'; // never overwrite a state file we couldn't read (R2-2)
    const cat = dueList(s, now, activityResume(now, sidecarSeed(s, now)))[0];
    if (!cat) return 'no active health reminder';
    s.lastDone[cat] = now;                        // safe: normalizer guarantees lastDone object
    const day = new Date(now).toDateString();
    if (!s.done[day]) s.done[day] = {};           // normalizer guarantees existing day entries are clean non-array objects
    const n = Number(s.done[day][cat]);
    s.done[day][cat] = (Number.isFinite(n) && n > 0 ? n : 0) + 1; // malformed/negative resets to 0 — never -2 → -1
    // ponytail: two simultaneous acks can lose one tally; per-category files if that ever matters
    writeHealthState({ version: 2, startedAt: s.startedAt, lastDone: s.lastDone, lastAckAt: now, done: s.done });
    return `✅ ${HEALTH_REMINDERS[cat].icon} done (${s.done[day][cat]} today)`;
  } catch { return 'could not update health state'; }
};

module.exports = { normalizeState, dueList, deriveHealth, activityResume, HEALTH_REMINDERS }; // pure helpers,
// plus activityResume so test 15 can force its EEXIST-loser path deterministically in-process (R3-2);
// the remaining impure paths (selectHealthPhrase, ackDone, readHealthState) are exercised via the CLI
if (require.main !== module) return; // required as a module (tests): skip argv/stdin below

if (process.argv[2] === 'done') { console.log(ackDone(Date.now())); process.exit(0); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(input);
    const model = d.model?.display_name || 'Claude';
    const cwd = d.workspace?.current_dir || process.cwd();
    const session = d.session_id || '';

    // Bar (8 segments for compactness)
    const bar = (pct) => {
      const f = Math.floor(pct / 12.5);
      const b = '█'.repeat(f) + '░'.repeat(8 - f);
      let c = '\x1b[32m';
      if (pct >= 95)      c = '\x1b[5;31m';
      else if (pct >= 80) c = '\x1b[31m';
      else if (pct >= 60) c = '\x1b[38;5;208m';
      else if (pct >= 40) c = '\x1b[33m';
      return `${c}${b}\x1b[0m`;
    };

    const reset = (epoch) => {
      if (!epoch) return '';
      const min = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
      const h = Math.floor(min / 60), m = min % 60;
      if (h >= 24) {
        const dys = Math.floor(h / 24), hh = h % 24;
        return `${dys}d${hh ? hh + 'h' : ''}`;
      }
      return h > 0 ? `${h}h${m ? m + 'm' : ''}` : `${m}m`;
    };

    // Animated rainbow (cycles each render)
    const rainbow = (text) => {
      const colors = [196, 208, 220, 82, 51, 99, 201];
      const off = Math.floor(Date.now() / 300) % colors.length;
      return text.split('').map((c, i) => `\x1b[38;5;${colors[(i + off) % colors.length]}m${c}\x1b[0m`).join('');
    };

    // Time color thresholds
    const timeColor = (mins) => {
      if (mins < 30) return '\x1b[32m';   // green: short
      if (mins <= 90) return '\x1b[33m';  // yellow: medium
      return '\x1b[31m';                   // red: long
    };

    const branch = (() => {
      try {
        const b = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 500, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        if (!b || b === 'HEAD') return '';
        let name = b.length > 22 ? b.slice(0, 20) + '..' : b;
        try {
          const [ahead, behind] = execSync('git rev-list --left-right --count HEAD...@{u}', { cwd, timeout: 500, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim().split(/\s+/).map(Number);
          if (ahead) name += ` \x1b[32m↑${ahead}\x1b[0m`;
          if (behind) name += ` \x1b[31m↓${behind}\x1b[0m`;
        } catch {}
        return name;
      } catch { return ''; }
    })();

    const task = (() => {
      const dir = path.join(os.homedir(), '.claude', 'todos');
      if (!session || !fs.existsSync(dir)) return '';
      try {
        const f = fs.readdirSync(dir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtime }))
          .sort((a, b) => b.t - a.t)[0];
        if (!f) return '';
        const t = JSON.parse(fs.readFileSync(path.join(dir, f.f), 'utf8')).find(t => t.status === 'in_progress');
        return t?.activeForm || '';
      } catch { return ''; }
    })();

    // session focus "Phase: subject" (e.g. "Exec: DB User Schema migration"), written by Claude per CLAUDE.md rule
    const sessionCtx = (() => {
      if (!session) return '';
      try {
        const buf = fs.readFileSync(path.join(os.homedir(), '.claude', 'session-context', session));
        // FF FE = UTF-16LE BOM (PowerShell 5.1 `>`); trailing quotes = cmd.exe `echo "…"`
        let t = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8'))
          .trim().split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '').replace(/^"(.*)"$/, '$1');
        if (t.length > 48) t = t.slice(0, 46) + '..';
        // semantic palette: blue=think, gold=working, orange=question, cyan=check, green=done, red=trouble, yellow=waiting on user
        const PHASE = { research: 176, plan: 111, 'review-plan': 141, exec: 220, 'q&a': 208, review: 208, 'review-execution': 208, verify: 80, done: 114, debug: 203, fix: 203, focus: 213,
                        'necesita-revisión': 226, 'necesita-revision': 226, 'needs-review': 226, confirma: 226, revisa: 226 };
        const m = t.match(/^([\p{L}\d&-]+):\s*(.*)/u);
        const c = m && (PHASE[m[1].toLowerCase()] || 250); // unknown phase labels allowed (dynamic pipelines) — bold grey
        return c ? `\x1b[1;38;5;${c}m${m[1]}:\x1b[0m ${m[2]}` : t;
      } catch { return ''; }
    })();

    // ---- Line 1 (sections joined by |) ----
    const effortVal = typeof d.effort === 'string' ? d.effort : d.effort?.level;
    const effortColorMap = {
      low: '\x1b[38;2;245;195;68m',                 // #F5C344 amber yellow
      medium: '\x1b[38;2;108;184;110m',             // #6CB86E emerald green
      high: '\x1b[38;2;179;185;244m',               // #B3B9F4 lavender
      xhigh: '\x1b[38;2;179;136;244m',              // #B388F4 lavender purple
    };
    const effortStr = effortVal
      ? (effortVal.toLowerCase() === 'max'
          ? rainbow(effortVal)
          : `${effortColorMap[effortVal.toLowerCase()] || ''}${effortVal}\x1b[0m`)
      : '';
    const dir = path.basename(cwd);
    const L1 = [effortStr ? `${model} · ${effortStr}` : model, branch ? `${dir} · ${branch}` : dir];
    if (task) L1.unshift(task);
    if (d.cost?.total_lines_added != null) L1.push(`\x1b[32m+${d.cost.total_lines_added}\x1b[0m\x1b[31m-${d.cost.total_lines_removed}\x1b[0m`);
    if (d.cost?.total_cost_usd != null && d.cost.total_cost_usd > 0) {
      L1.push(`\x1b[36m$${d.cost.total_cost_usd.toFixed(2)}\x1b[0m`);
    }
    if (d.cost?.total_duration_ms != null) {
      const mins = Math.round(d.cost.total_duration_ms / 60000);
      L1.push(`${timeColor(mins)}${mins}m\x1b[0m`);
    }
    if (sessionCtx) L1.push(sessionCtx);

    // ---- Line 2 (stats joined by |) ----
    const L2 = [];
    const rl = d.rate_limits;
    const limitStat = (label, w) => {
      if (w?.used_percentage == null) return;
      const p = Math.round(w.used_percentage);
      const r = reset(w.resets_at);
      L2.push(`${label} ${bar(p)} ${p}%${r ? ` (${r})` : ''}`);
    };
    const rem = d.context_window?.remaining_percentage;
    if (rem != null) {
      const u = Math.max(0, Math.min(100, 100 - rem));
      L2.push(`ctx ${bar(Math.min(100, Math.round(u / 80 * 100)))} ${Math.round(u / 80 * 100)}%`);
    }
    limitStat('5h', rl?.five_hour);
    limitStat('wk', rl?.seven_day);
    const hp = selectHealthPhrase(Date.now());
    if (hp) L2.push(`\x1b[36mhealth: ${hp}\x1b[0m`);

    process.stdout.write(`${L1.join(' | ')}\n${L2.join(' | ')}`);
  } catch (e) {}
});
