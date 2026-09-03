#!/usr/bin/env node
// claude-code-status — Jeancarlo's Claude Code statusline
// | = section, · = inline stat

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(input);
    const model = (d.model?.display_name || 'Claude').replace(/\s*\([^)]*\)\s*$/, ''); // "Opus 5 (1M context)" -> "Opus 5"
    const cwd = d.workspace?.current_dir || process.cwd();
    const session = d.session_id || '';

    // One-cell fill gauge plus its number. The old 8-block bar only resolved to 12.5% steps, so a
    // single glyph off the same ramp is the same signal at a twelfth of the width, and the digits
    // carry the precision. Colour now wraps both: with one cell of fill left, the number has to
    // carry the urgency too.
    const gauge = (pct) => {
      const g = '▁▁▂▃▄▅▆▇█'[Math.max(0, Math.min(8, Math.round(pct / 12.5)))];
      let c = '\x1b[32m';
      if (pct >= 95)      c = '\x1b[5;31m';
      else if (pct >= 80) c = '\x1b[31m';
      else if (pct >= 60) c = '\x1b[38;5;208m';
      else if (pct >= 40) c = '\x1b[33m';
      return `${c}${g} ${pct}%\x1b[0m`;
    };

    // "2d3h" / "4h20m" / "35m" — time-in-phase
    const dur = (min) => {
      const h = Math.floor(min / 60), m = min % 60;
      if (h >= 24) {
        const dys = Math.floor(h / 24), hh = h % 24;
        return `${dys}d${hh ? hh + 'h' : ''}`;
      }
      return h > 0 ? `${h}h${m ? m + 'm' : ''}` : `${m}m`;
    };

    const minsLeft = (epoch) => (epoch ? Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000)) : null);

    // Ultra-compact rate-limit reset: "~2d" (>=24h), "~3h" (>=1h), "~45m" (<1h)
    const reset = (min) => {
      if (min == null) return '';
      if (min < 60) return `~${min}m`;
      if (min >= 1440) return `~${Math.round(min / 1440)}d`;
      const h = Math.round(min / 60);
      return h >= 24 ? '~1d' : `~${h}h`;
    };

    // The countdown's meaning flips with pace: 88% used is reassuring with 40m left and a warning
    // with 3h left. Colour carries that at zero extra width. The window's own elapsed share is the
    // burn rate — no history needed — so amber means "this pace hits the cap before it resets".
    // Under 50% the projection is noise (a spiky first hour would paint the whole session amber),
    // and past 95% the countdown stops being a warning and becomes the ETA back to work.
    const RESET_GREY = '\x1b[38;5;245m';
    const resetTone = (pct, min, windowMin) => {
      if (pct >= 95) return '\x1b[1;38;5;203m';
      const elapsed = windowMin - min;
      if (pct >= 50 && elapsed >= windowMin * 0.2 && (pct * windowMin) / elapsed >= 100) return '\x1b[33m';
      return RESET_GREY;
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

    // Cost color thresholds: cheap ($0–$3), moderate ($3–$6), expensive (> $6)
    const costColor = (cost) => {
      if (cost < 3.00) return '\x1b[32m';   // green: cheap ($0–$3)
      if (cost <= 6.00) return '\x1b[33m';  // yellow: moderate ($3–$6)
      return '\x1b[31m';                    // red: expensive (> $6)
    };

    // one cap, one ellipsis, both lines: real branch names and openspec change ids both top out
    // around 29-31 chars ("feat/deliver-the-gated-review", "inherit-global-roles-in-overlay").
    const trunc = (str, n = 32) => (str.length > n ? str.slice(0, n - 1) + '…' : str);

    const branch = (() => {
      try {
        const b = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 500, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        if (!b || b === 'HEAD') return '';
        let name = trunc(b);
        try {
          const [ahead, behind] = execSync('git rev-list --left-right --count HEAD...@{u}', { cwd, timeout: 500, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim().split(/\s+/).map(Number);
          if (ahead) name += ` \x1b[32m↑${ahead}\x1b[0m`;
          if (behind) name += ` \x1b[31m↓${behind}\x1b[0m`;
        } catch {}
        return name;
      } catch { return ''; }
    })();

    // session focus "Phase: subject" (e.g. "Exec: DB User Schema migration"), written by Claude per CLAUDE.md rule.
    // Read once: the phase chip renders it, and the change picker below reads the subject to tell which
    // of several open changes is the one actually being worked.
    const focusFile = session ? path.join(os.homedir(), '.claude', 'session-context', session) : '';
    const focus = (() => {
      if (!focusFile) return '';
      try {
        const buf = fs.readFileSync(focusFile);
        // FF FE = UTF-16LE BOM (PowerShell 5.1 `>`); trailing quotes = cmd.exe `echo "…"`
        return (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8'))
          .trim().split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '').replace(/^"(.*)"$/, '$1');
      } catch { return ''; }
    })();
    const sessionCtx = (() => {
      if (!focus) return '';
      try {
        const f = focusFile;
        const t = trunc(focus, 48);
        // semantic palette: blue=think, gold=working, orange=question, cyan=check, green=done, red=trouble, yellow=waiting on user
        const PHASE = { research: 176, explore: 176, analysis: 176, plan: 111, 'review-plan': 141, exec: 220,
                        'q&a': 208, review: 208, 'review-execution': 208, critique: 208, verify: 80, done: 114,
                        debug: 203, fix: 203, focus: 213, chat: 117, docs: 109,
                        'necesita-revisión': 226, 'necesita-revision': 226, 'needs-review': 226, confirma: 226, revisa: 226 };
        const m = t.match(/^([\p{L}\d&-]+):\s*(.*)/u);
        if (!m) return t;
        const c = PHASE[m[1].toLowerCase()] || 250; // unknown phase labels allowed (dynamic pipelines) — bold grey
        // Measured across 38 real sessions (median 134min, 4 phase writes): the label is >15min out
        // of date 57% of the wall clock, because the subject survives a whole pipeline and the phase
        // does not. So the file's mtime is shown once the label has stood a while — the same number
        // answers "is this still true?" and "has it been stuck on this?" — and the label dims once it
        // is old enough to be a guess. The subject keeps full brightness: it is the half that holds.
        // Time in phase has to survive an acknowledgement. Both hooks tell the model to `touch` a
        // label that is still right, which resets mtime — so mtime alone would restart this clock
        // every time the nudge fires and the age would never reach the 20-minute floor. Track when
        // the text last *changed*; mtime is only the seed the first time a label is seen.
        let since = fs.statSync(f).mtimeMs;
        const seen = path.join(os.tmpdir(), `ccs-phase-${session.replace(/[^\w.-]+/g, '_')}.json`);
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(seen, 'utf8')); } catch {}
        // a touch bumps mtime without changing the label, so the older of the two is the honest start
        if (prev && prev.text === t) since = Math.min(prev.since, since);
        if (!prev || prev.text !== t || prev.since !== since) {
          try { fs.writeFileSync(seen, JSON.stringify({ text: t, since })); } catch {}
        }
        const mins = Math.round((Date.now() - since) / 60000);
        const style = `\x1b[${mins >= 90 ? 2 : 1};${c === 226 ? '7;' : ''}38;5;${c}m`; // 226 = waiting on the user: a chip you can spot from another tab
        const age = mins >= 20 ? ` ${dur(mins)}` : '';
        return `${style}${m[1]}\x1b[0;38;5;245m${age}:\x1b[0m ${m[2]}`; // 0; first: the chip's reverse-video must not bleed onto the age

      } catch { return ''; }
    })();

    // A selection is remembered without discarding the one before it. `/opsx:propose new-id` is
    // recorded before it creates its directory, and dropping the change you were on the moment that
    // unresolvable id arrives would leave the bar showing an unrelated one for the whole proposal.
    const keep = (st, id) => { st.hist = [id, ...st.hist.filter(x => x !== id)].slice(0, 3); st.pro = ''; };
    const last = (s, re) => {           // last match wins: a later selection supersedes an earlier one
      let hit = '';
      for (const m of s.matchAll(re)) { const id = m[1] || m[2]; if (id && id !== 'archive') hit = id; }
      return hit;
    };
    // An instruction naming a change. ["'\\]* rather than "?: a quoted argument reaches here through
    // JSON.stringify, so what precedes the id is `\"`, not `"`.
    const cmdChange = s => last(s, /--change[\s=]+["'\\]*([a-z0-9][\w.-]*)|\/opsx:\w+\s+["'\\]*([a-z0-9][\w.-]*)/gi);
    // A file inside the change's own directory.
    const pathChange = s => last(s, /openspec\/changes\/([a-z0-9][\w.-]*)\//gi);
    // Prose naming a change ("sigo con landing-tracking-parity"). Only when the message names
    // exactly one candidate — "apply landing-tracking-parity, fix-phpstan is still blocked" names
    // two, and there the last one mentioned is precisely the wrong answer.
    const soleChange = s => {
      const seen = new Set();
      for (const m of s.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)) if (m[0] !== 'archive') seen.add(m[0]);
      return seen.size === 1 ? [...seen][0] : '';
    };

    // One incremental pass over the transcript, answering two things: how many output tokens this
    // session has produced (rendered as tok/s below), and which OpenSpec change it is actually
    // working — the only signal that says which change is *being worked* rather than which one
    // looks furthest along or was written to last by anything at all.
    //
    // Records are parsed, not pattern-matched over the raw line, because one line carries several
    // content blocks and the difference between them is the entire point: a path in a tool_use
    // input is the model deliberately opening that change, while the identical path in a
    // tool_result is an `ls` listing every change there is — which handed the bar whichever id
    // happened to sort last. Parsing a whole 16.7MB transcript costs 12ms against 5ms for a regex,
    // and only on the first render of a resumed session; every later render sees ~2KB.
    const scan = (() => {
      const st = { off: 0, sum: 0, last: '', hist: [], pro: '' };
      if (!d.transcript_path) return st;
      try {
        // The transcript is append-only and reaches tens of MB, so re-reading all of it every few
        // seconds was by far the most expensive thing here (33ms of an 80ms render on a 12MB file).
        // Keep a sidecar with the running totals and the byte offset already counted, and read only
        // the bytes appended since.
        const size = fs.statSync(d.transcript_path).size;
        const cache = path.join(os.tmpdir(), `ccs-tps-${(session || d.transcript_path).replace(/[^\w.-]+/g, '_')}.json`);
        try {
          const prev = JSON.parse(fs.readFileSync(cache, 'utf8'));
          if (prev.off <= size) Object.assign(st, prev);  // file shrank: a different transcript, so recount
        } catch {}
        if (size > st.off) {
          const fd = fs.openSync(d.transcript_path, 'r');
          const buf = Buffer.allocUnsafe(size - st.off);
          fs.readSync(fd, buf, 0, buf.length, st.off);
          fs.closeSync(fd);
          const text = buf.toString('utf8');
          const cut = text.lastIndexOf('\n') + 1;  // never consume a half-written trailing line
          for (const line of text.slice(0, cut).split('\n')) {
            const out = line.match(/"output_tokens":(\d+)/); // "output_tokens_details" can't match: it is followed by {
            if (out) {
              // Every content block of one request repeats that request's cumulative usage, and a
              // request's blocks are contiguous, so the previous id is all we need to dedupe.
              const rid = line.match(/"requestId":"([^"]+)"/)?.[1];
              if (!rid || rid !== st.last) { if (rid) st.last = rid; st.sum += Number(out[1]); }
            }
            let o;
            try { o = JSON.parse(line); } catch { continue; }
            // isMeta is the harness talking to the model (hook output, reminders); isSidechain is a
            // subagent. Neither one is you choosing a change to work on.
            if (o.isMeta || o.isSidechain || !o.message) continue;
            const c = o.message.content;
            const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
            // Deliberate inputs only. A tool_result is command *output* — that is where a listing of
            // every open change lives — and assistant prose names changes while merely discussing
            // them, the way this comment does. Neither may move the pin.
            if (o.message.role === 'user') {
              // Judge the message, not each block: a turn arrives as the prompt plus whatever
              // system-reminders rode along with it, and reading those separately would let a
              // reminder with no id in it wipe the id the prompt just gave.
              const t = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
              if (!t) continue;                              // tool results only — not a turn of yours
              const cmd = cmdChange(t);
              // A command names the change to work on and holds until superseded. Naming one any
              // other way is softer than that: a path pasted out of a stack trace, or a change
              // mentioned in passing ("blocked-one is still waiting on them"), is worth following
              // for now but must not outlive the aside. So it is dropped by the next thing you say
              // that names nothing — which is what the unconditional assignment below does.
              if (cmd) keep(st, cmd); else st.pro = pathChange(t) || soleChange(t);
            } else {
              for (const b of blocks) {
                if (b.type !== 'tool_use') continue;
                const s = JSON.stringify(b.input ?? '');
                const id = cmdChange(s) || pathChange(s);     // the model actually opened it or ran it
                if (id) keep(st, id);
              }
            }
            // Ids are kept without checking that the directory exists: `/opsx:propose new-id` is
            // scanned before the directory it creates, and these bytes are never read twice.
            // Whether one is real is settled where the change is picked, on every render.
          }
          if (cut) {
            st.off += cut;
            try { fs.writeFileSync(cache, JSON.stringify(st)); } catch {}
          }
        }
      } catch {}
      return st;
    })();

    // active OpenSpec change (the /opsx:propose → apply → archive loop). Several can be open at once —
    // the one whose tasks.md was touched last is the one being worked. No tasks.md = proposal not expanded yet.
    const change = (() => {
      try {
        let root = cwd;
        while (!fs.existsSync(path.join(root, 'openspec', 'changes'))) {
          const up = path.dirname(root);
          if (up === root || root === os.homedir()) return '';
          root = up;
        }
        const dir = path.join(root, 'openspec', 'changes');
        // The change you are furthest through is not always the change you are on: one that is blocked
        // on someone else sits at 32/34 forever and keeps out-ranking the one you switched to. Two
        // signals say which one you actually mean, strongest first.
        const fw = new Set(focus.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
        const score = (id, sel) => {
          // 1. this session selected it — opened one of its files, handed its id to an openspec or
          // /opsx command, or you named it in a prompt. Evidence, not a guess. The soft pin, when
          // one is standing, is by construction the more recent of the two. Checking either against
          // the directories that exist right now is also what makes it safe to record an id before
          // its directory is there: an id that never becomes real simply never scores.
          if (id && id === sel) return 100;
          // 2. the focus line names it. Word overlap, not equality — survives the id's dashes, any
          // word order, and a subject that paraphrases ("Exec: landing tracking parity"). Two words
          // minimum, so a shared "fix" or "add" cannot hijack the pick. Only a fallback: the phase
          // subject moves with the task at hand and often has nothing to do with any change id.
          const n = id.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && fw.has(w)).length;
          return n > 1 ? n : 0;
        };
        const open = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name !== 'archive')  // /opsx:archive moves the dir under archive/, so it drops off here on its own
          .map(({ name: c }) => {
            const f = path.join(dir, c, 'tasks.md');
            try {
              const md = fs.readFileSync(f, 'utf8');
              const done = (md.match(/^\s*-\s*\[x\]/gim) || []).length;
              const total = done + (md.match(/^\s*-\s*\[ \]/gm) || []).length;
              return { c, done, total, t: fs.statSync(f).mtimeMs };
            } catch {
              // no tasks.md yet: proposed but not expanded. Still worth showing — otherwise a fresh
              // /opsx:propose leaves the bar empty and the open change is invisible.
              return { c, done: 0, total: 0, t: fs.statSync(path.join(dir, c)).mtimeMs };
            }
          })
          // The change the focus line names wins outright. Failing that, a change you have started
          // outranks an expanded one, which outranks a bare proposal, so /opsx:propose can't steal the
          // bar from the change you are mid-way through. Then most-recently-worked wins, which is the
          // same order `openspec list` uses.
          ;
        // Resolving against the directories that exist right now is what makes it safe to have
        // recorded an id before its directory was there: an id that is not real yet is skipped,
        // and the selection before it still stands until it becomes real.
        const ids = new Set(open.map(c => c.c));
        const sel = (scan.pro && ids.has(scan.pro)) ? scan.pro : scan.hist.find(id => ids.has(id)) || '';
        const all = open
          .map(c => ({ ...c, f: score(c.c, sel) }))
          .sort((a, b) => b.f - a.f || Number(b.done > 0) - Number(a.done > 0) || Number(b.total > 0) - Number(a.total > 0) || b.t - a.t);
        const best = all[0];
        if (!best) return '';
        const name = trunc(best.c);
        // other open changes. Space-separated and "o"-suffixed so it can't read as arithmetic on the task count.
        const more = all.length > 1 ? ` \x1b[38;5;245m+${all.length - 1}o\x1b[0m` : '';
        if (!best.total) return `chg ${name} \x1b[38;5;245m·\x1b[0m${more}`;  // proposal not expanded yet
        if (best.done === best.total) return `chg ${name} \x1b[1;32m✓\x1b[0m${more}`;  // ready to /opsx:archive
        const pct = Math.round(100 * best.done / best.total);
        const c = pct >= 75 ? '\x1b[38;5;114m' : pct >= 25 ? '\x1b[33m' : '\x1b[38;5;250m';
        return `chg ${name} ${c}${best.done}/${best.total}\x1b[0m${more}`;
      } catch { return ''; }
    })();

    // output speed: session output tokens ÷ API wait time (cost.total_api_duration_ms excludes tool/user time).
    // The transcript writes one line per content block, all repeating the request's cumulative usage —
    // deduped by requestId in the scan above, which is where the reading and counting happens.
    const tps = (() => {
      const apiMs = d.cost?.total_api_duration_ms;
      if (!apiMs || !scan.sum) return '';
      const v = scan.sum / (apiMs / 1000);
      const valStr = v >= 100 || v % 1 === 0 ? Math.round(v) : v.toFixed(1);
      const c = v >= 60 ? '\x1b[32m' : v >= 30 ? '\x1b[33m' : '\x1b[31m';
      return `${c}${valStr} tok/s\x1b[0m`;
    })();

    // ---- Intelligence score lookup and coloring ----
    const colorIntelligence = (score) => {
      if (score == null || !Number.isFinite(score)) return '';
      const s = Math.round(score);
      let c = '\x1b[38;5;245m'; // < 20: Economy / fast (muted slate grey)
      if (s >= 60)      c = '\x1b[38;5;201m'; // >= 60: Next-Gen Reasoning (Magenta)
      else if (s >= 50) c = '\x1b[38;5;51m';  // 50-59: Cutting-Edge Frontier (Electric Cyan)
      else if (s >= 35) c = '\x1b[38;5;114m'; // 35-49: Flagship Reasoning (Emerald Green)
      else if (s >= 20) c = '\x1b[38;5;220m'; // 20-34: Balanced Mid-tier (Amber Gold)
      return `${c}${s}\x1b[0m`;
    };

    const getModelIntelligence = (modelId, modelName) => {
      const dbPath = path.join(os.homedir(), '.omp', 'agent', 'models.db');
      const cachePath = path.join(os.tmpdir(), 'claude-model-int-cache.json');
      let map = null;

      if (fs.existsSync(cachePath)) {
        try {
          const cacheMtime = fs.statSync(cachePath).mtimeMs;
          const dbMtime = fs.existsSync(dbPath) ? fs.statSync(dbPath).mtimeMs : 0;
          if (cacheMtime >= dbMtime) {
            map = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          }
        } catch {}
      }

      if (!map && fs.existsSync(dbPath)) {
        map = {};
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(dbPath, { readOnly: true });
          const rows = db.prepare('SELECT models FROM model_cache').all();
          for (const r of rows) {
            try {
              const list = JSON.parse(r.models);
              for (const m of list) {
                if (typeof m.int === 'number' && Number.isFinite(m.int)) {
                  const bareId = m.id.includes('/') ? m.id.split('/').pop() : m.id;
                  const cleanId = bareId.replace(/\[.*?\]/g, '').replace(/:thinking.*?$/g, '').trim().toLowerCase();
                  map[m.id.toLowerCase()] = m.int;
                  map[bareId.toLowerCase()] = m.int;
                  map[cleanId] = m.int;
                  if (m.name) {
                    map[m.name.toLowerCase()] = m.int;
                    map[m.name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '')] = m.int;
                  }
                }
              }
            } catch {}
          }
          db.close();
          try { fs.writeFileSync(cachePath, JSON.stringify(map)); } catch {}
        } catch {}
      }

      if (!map) return null;

      const clean = (s) => (s || '').replace(/\[.*?\]/g, '').replace(/:thinking.*?$/g, '').replace(/^.*?\//, '').trim().toLowerCase();
      if (modelId) {
        const val = map[modelId.toLowerCase()] ?? map[clean(modelId)];
        if (val !== undefined) return val;
      }
      if (modelName) {
        const val = map[modelName.toLowerCase()] ?? map[clean(modelName)];
        if (val !== undefined) return val;
      }
      return null;
    };

    // ---- Line 1 (sections joined by |) ----
    const rawEffort = (typeof d.effort === 'string' ? d.effort : d.effort?.level || '').toLowerCase();
    const effortDisplayMap = {
      minimal: 'minimal',
      min: 'minimal',
      lo: 'low',
      low: 'low',
      med: 'med',
      medium: 'med',
      mid: 'med',
      hi: 'high',
      high: 'high',
      xhi: 'xhigh',
      xhigh: 'xhigh',
      'extra-high': 'xhigh',
      max: 'max',
      maximum: 'max',
      auto: 'auto',
    };
    const effortColorMap = {
      minimal: '\x1b[38;5;245m',
      low: '\x1b[38;2;245;195;68m',                 // #F5C344 amber yellow
      med: '\x1b[38;2;108;184;110m',                 // #6CB86E emerald green
      high: '\x1b[38;2;179;185;244m',               // #B3B9F4 lavender
      xhigh: '\x1b[38;2;179;136;244m',              // #B388F4 lavender purple
    };
    const effortShort = effortDisplayMap[rawEffort] || rawEffort;
    const effortStr = effortShort
      ? (effortShort === 'max'
          ? rainbow('max')
          : `${effortColorMap[effortShort] || '\x1b[38;5;245m'}${effortShort}\x1b[0m`)
      : '';

    const intScore = getModelIntelligence(d.model?.id, d.model?.display_name || model);
    const intStr = intScore != null ? colorIntelligence(intScore) : '';

    const ob = '\x1b[38;5;245m[\x1b[0m';
    const cb = '\x1b[38;5;245m]\x1b[0m';
    const dot = '\x1b[38;5;245m·\x1b[0m';

    let tag = '';
    if (effortStr && intStr) {
      tag = `${ob}${effortStr}${dot}${intStr}${cb}`;
    } else if (intStr) {
      tag = `${ob}${intStr}${cb}`;
    } else if (effortStr) {
      tag = `${ob}${effortStr}${cb}`;
    }

    const modelIndicator = tag ? `${model} ${tag}` : model;

    const dir = path.basename(cwd);
    const L1 = [modelIndicator, branch ? `${dir}\x1b[38;5;245m@\x1b[0m${branch}` : dir];
    if (d.cost?.total_cost_usd != null && d.cost.total_cost_usd > 0) {
      L1.push(`${costColor(d.cost.total_cost_usd)}$${d.cost.total_cost_usd.toFixed(2)}\x1b[0m`);
    }
    if (d.cost?.total_duration_ms != null) {
      const mins = Math.round(d.cost.total_duration_ms / 60000);
      L1.push(`${timeColor(mins)}${mins}m\x1b[0m`);
    }
    // The phase is the headline feature, so it leads instead of trailing five ambient segments.
    if (sessionCtx) L1.unshift(sessionCtx);

    // ---- Line 2 (stats joined by |) ----
    const L2 = [];
    if (change) L2.push(change);
    const rl = d.rate_limits;
    // "5h~3h ▅ 62%" — the countdown rides its own label, so the two numbers that share a unit stay
    // together ("5h window, 3h left") and the meter keeps the row's right edge for the percentages.
    const limitStat = (label, w, windowMin) => {
      if (w?.used_percentage == null) return;
      const p = Math.round(w.used_percentage);
      const left = minsLeft(w.resets_at);
      const r = reset(left);
      L2.push(`${label}${r ? `${resetTone(p, left, windowMin)}${r}\x1b[0m` : ''} ${gauge(p)}`);
    };
    const rem = d.context_window?.remaining_percentage;
    if (rem != null) {
      // true share of the window, matching /context — auto-compact at 80% is signalled by gauge() turning red
      const u = Math.round(Math.max(0, Math.min(100, 100 - rem)));
      L2.push(`ctx ${gauge(u)}`);
    }
    limitStat('5h', rl?.five_hour, 300);
    limitStat('wk', rl?.seven_day, 10080);
    if (tps) L2.push(tps);

    process.stdout.write(`${L1.join(' | ')}\n${L2.join(' | ')}`);
  } catch (e) {}
});
