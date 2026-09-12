#!/usr/bin/env node
// claude-code-status — Jeancarlo's Claude Code statusline
// | = section, · = inline stat

process.removeAllListeners('warning');
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

    // A selection is remembered without discarding the one before it. `/opsx:propose new-id` is
    // recorded before it creates its directory, and dropping the change you were on the moment that
    // unresolvable id arrives would leave the bar showing an unrelated one for the whole proposal.
    const DUMMY_IDS = new Set(['add-auth', 'other', 'name', 'slug', 'change-id', 'id', 'the-id', 'archive']);
    const keep = (st, id, dir) => {
      st.hist = [id, ...st.hist.filter(x => x !== id)].slice(0, 3);
      st.pro = '';
      if (dir && !st.dirs.includes(dir)) st.dirs.unshift(dir);
    };
    const last = (s, re) => {           // last match wins: a later selection supersedes an earlier one
      let hit = '';
      for (const m of s.matchAll(re)) {
        const id = m[1] || m[2];
        if (id && !DUMMY_IDS.has(id.toLowerCase())) hit = id;
      }
      return hit;
    };
    // An instruction naming a change. ["'\\]* rather than "?: a quoted argument reaches here through
    // JSON.stringify, so what precedes the id is `\"`, not `"`.
    const cmdChange = s => last(s, /--change[\s=]+["'\\]*([a-z0-9][\w.-]*)|\/opsx:\w+\s+["'\\]*([a-z0-9][\w.-]*)/gi);
    // A file inside the change's own directory.
    const pathChange = s => {
      let hit = { id: '', dir: '' };
      for (const m of s.matchAll(/(?:^|["'\s])([^\s"']*[\\/])?openspec[\\/]changes[\\/]([a-z0-9][\w.-]*)/gi)) {
        const dirPrefix = m[1] || '';
        const id = m[2];
        if (id && !DUMMY_IDS.has(id.toLowerCase())) hit = { id, dir: dirPrefix };
      }
      return hit;
    };
    // Prose naming a change ("sigo con landing-tracking-parity"). Only when the message names
    // exactly one candidate — "apply landing-tracking-parity, fix-phpstan is still blocked" names
    // two, and there the last one mentioned is precisely the wrong answer.
    const soleChange = s => {
      const seen = new Set();
      for (const m of s.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)) if (!DUMMY_IDS.has(m[0].toLowerCase())) seen.add(m[0]);
      return seen.size === 1 ? [...seen][0] : '';
    };
    // The two canonical steps of `/opsx:propose` that name the slug it just chose: creating the
    // change, or asking an existing one for its artifact order. Anchored at the start of the
    // command the tool actually runs, so a wrapper (`npx openspec …`), a `cd … &&`, an `echo`, or
    // an option carrying a quoted example can never be mistaken for a run.
    const FIRE_NEW = /^\s*openspec\s+new\s+change\s+(["']?)([a-z0-9][\w.-]*)\1(?=\s|$)/i;
    const FIRE_STATUS = /^\s*openspec\s+status\s+--change[\s=]+(["']?)([a-z0-9][\w.-]*)\1(?=\s|$)/i;
    const fireSlug = s => {
      if (typeof s !== 'string') return '';
      const m = FIRE_NEW.exec(s) || FIRE_STATUS.exec(s);
      const id = m?.[2] || '';
      return id && !DUMMY_IDS.has(id.toLowerCase()) ? id : '';
    };
    const CANCELLED = /^(cancel|cancela|abort|never\s*mind|nevermind|olv[ií]dalo)\b/i;
    // The slash-command envelope Claude Code writes as a record of its own, anchored at its start:
    // a paste or a doc that merely quotes `<command-name>` somewhere in its body is not a command.
    const INVOKED = /^<command-message>[^<]*<\/command-message>\s*<command-name>\s*\/(opsx:[\w-]+)\s*<\/command-name>/i;
    // An event's own clock, and only when it is honest: a timestamp in the future would outrank a
    // label you write before it comes round, so a replay could then overwrite your phase.
    const eventAt = ts => {
      const at = Date.parse(ts);
      return at > 0 && at <= Date.now() + 60000 ? at : 0;
    };
    // The one phase this tool writes itself: `/opsx:propose` is the only transition with a
    // machine-readable trigger. Every other label is the model's, so the write is guarded by the
    // file's own mtime — an event older than what is on disk is a replay (a swept sidecar, a
    // resumed session) and must lose, while proposing again, even the same slug, is a newer event
    // and wins. Returns false only when the write itself failed, which is what makes it retried.
    const activate = pend => {
      try {
        if (fs.statSync(focusFile).mtimeMs >= pend.at) return true;
      } catch {}                                     // no phase file yet — this is the first label
      try {
        fs.mkdirSync(path.dirname(focusFile), { recursive: true });
        fs.writeFileSync(focusFile, `Planification: ${pend.slug}\n`);
        return true;
      } catch { return false; }
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
      // `v` is the counting contract, not the file format: bump it whenever the arithmetic below
      // changes. A sidecar holds a byte offset already counted, so a sidecar written by older
      // arithmetic can never be corrected incrementally — it has to be recounted from zero, and
      // nothing in its numbers reveals which rule produced them. That is how a mid-session change
      // once left a 517k session reading 1.1k forever.
      const st = { v: 4, off: 0, sum: 0, total: 0, last: '', hist: [], pro: '', dirs: [], arm: false, pend: null };
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
          // off > size: the file shrank, so it is a different transcript. v mismatch: older arithmetic.
          if (prev.v === st.v && prev.off <= size) Object.assign(st, prev);
        } catch {}
        let dirty = false;
        if (size > st.off) {
          const fd = fs.openSync(d.transcript_path, 'r');
          const buf = Buffer.allocUnsafe(size - st.off);
          fs.readSync(fd, buf, 0, buf.length, st.off);
          fs.closeSync(fd);
          const text = buf.toString('utf8');
          const cut = text.lastIndexOf('\n') + 1;  // never consume a half-written trailing line
          for (const line of text.slice(0, cut).split('\n')) {
            const out = line.match(/"output_tokens":(\d+)/); // "output_tokens_details" can't match: it is followed by {
            const inp = line.match(/"input_tokens":(\d+)/);
            const cc = line.match(/"cache_creation_input_tokens":(\d+)/);
            if (out || inp || cc) {
              // Every content block of one request repeats that request's cumulative usage, and a
              // request's blocks are contiguous, so the previous id is all we need to dedupe.
              const rid = line.match(/"requestId":"([^"]+)"/)?.[1];
              if (!rid || rid !== st.last) {
                if (rid) st.last = rid;
                const outN = out ? Number(out[1]) : 0;
                const inpN = inp ? Number(inp[1]) : 0;
                const ccN = cc ? Number(cc[1]) : 0;
                st.sum += outN;
                st.total += inpN + ccN + outN;
              }
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
              // Tags out first: a slash command never reaches the transcript the way it was typed —
              // it arrives as `<command-name>/opsx:apply</command-name>\n<command-args>the-id</command-args>`,
              // so the command and the id it was handed are never adjacent, and the tag names are
              // themselves hyphenated words that make every command look like it names two changes.
              const raw = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
              const t = raw.replace(/<\/?[a-z-]+>/gi, ' ');
              if (!t) continue;                              // tool results only — not a turn of yours
              // Which workflow is running, by identity and not by mention: the envelope is what
              // Claude Code writes for a slash command, so prose or documentation quoting
              // `/opsx:propose` can neither start a proposal nor end one. Anything that is not a
              // command leaves the arm alone — a proposal legitimately asks for scope first, and
              // the reply to that question is often the slug itself. What does end it: another
              // workflow, an explicit cancellation, or you running the OpenSpec command yourself.
              const invoked = raw.trimStart().match(INVOKED);
              if (invoked) st.arm = invoked[1].toLowerCase() === 'opsx:propose';
              else if (CANCELLED.test(raw.trimStart()) || fireSlug(raw)) st.arm = false;
              const pc = pathChange(t);
              const cmd = cmdChange(t);
              const dir = pc.dir ? path.resolve(cwd, pc.dir, 'openspec', 'changes') : '';
              if (cmd) keep(st, cmd, dir);
              else if (pc.id) keep(st, pc.id, dir);
              else st.pro = soleChange(t);
            } else {
              for (const b of blocks) {
                if (b.type !== 'tool_use') continue;
                const s = JSON.stringify(b.input ?? '');
                const pc = pathChange(s);
                const cmd = cmdChange(s);
                const id = cmd || pc.id;
                const dir = pc.dir ? path.resolve(cwd, pc.dir, 'openspec', 'changes') : '';
                if (id) keep(st, id, dir);
                // The slug is committed the moment an armed proposal runs one of its two canonical
                // OpenSpec commands. The command string only: a docs example sitting in a `read`
                // path or a grep pattern is text, not a run.
                if (st.arm && /^(bash|shell)$/i.test(b.name || '')) {
                  const slug = fireSlug(b.input?.command);
                  if (slug) {
                    st.arm = false;
                    const when = eventAt(o.timestamp);
                    st.pend = when ? { slug, at: when } : null;   // no honest clock, no activation
                  }
                }
              }
            }
            // Ids are kept without checking that the directory exists: `/opsx:propose new-id` is
            // scanned before the directory it creates, and these bytes are never read twice.
            // Whether one is real is settled where the change is picked, on every render.
          }
          if (cut) { st.off += cut; dirty = true; }
        }
        // Activation sits outside the "new bytes" branch on purpose: a failed write keeps `pend`,
        // so its retry has to land on a later render that has nothing new to read.
        if (st.pend && focusFile && activate(st.pend)) { st.pend = null; dirty = true; }
        if (dirty) try { fs.writeFileSync(cache, JSON.stringify(st)); } catch {}
      } catch {}
      return st;
    })();

    // Read after the scan: activating Planification above is what this render then displays.
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
        const PHASE = { research: 176, explore: 176, analysis: 176, plan: 111, planification: 111, 'review-plan': 141, exec: 220,
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

    // active OpenSpec change (the /opsx:propose → apply → archive loop). Several can be open at once —
    // the one whose tasks.md was touched last is the one being worked. No tasks.md = proposal not expanded yet.
    let changeId = '';
    const change = (() => {
      try {
        const candidateDirs = [];
        if (scan.dirs) {
          for (const d of scan.dirs) {
            if (fs.existsSync(d) && (d.startsWith(cwd) || cwd.startsWith(d)) && !candidateDirs.includes(d)) candidateDirs.push(d);
          }
        }
        const direct = path.join(cwd, 'openspec', 'changes');
        if (fs.existsSync(direct) && !candidateDirs.includes(direct)) candidateDirs.push(direct);

        try {
          for (const ent of fs.readdirSync(cwd, { withFileTypes: true })) {
            if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
              const sub = path.join(cwd, ent.name, 'openspec', 'changes');
              if (fs.existsSync(sub) && !candidateDirs.includes(sub)) candidateDirs.push(sub);
            }
          }
        } catch {}

        let parent = path.dirname(cwd);
        while (parent !== cwd && parent !== '/' && parent !== os.homedir()) {
          const up = path.join(parent, 'openspec', 'changes');
          if (fs.existsSync(up) && !candidateDirs.includes(up)) candidateDirs.push(up);
          parent = path.dirname(parent);
        }

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
        const seen = new Set();
        const open = [];
        for (const dir of candidateDirs) {
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === 'archive' || seen.has(entry.name)) continue;
            seen.add(entry.name);
            const f = path.join(dir, entry.name, 'tasks.md');
            try {
              const md = fs.readFileSync(f, 'utf8');
              const done = (md.match(/^\s*-\s*\[x\]/gim) || []).length;
              const total = done + (md.match(/^\s*-\s*\[ \]/gm) || []).length;
              open.push({ c: entry.name, done, total, t: fs.statSync(f).mtimeMs });
            } catch {
              open.push({ c: entry.name, done: 0, total: 0, t: fs.statSync(path.join(dir, entry.name)).mtimeMs });
            }
          }
        }
        if (!open.length) return '';
        // recorded an id before its directory was there: an id that is not real yet is skipped,
        // and the selection before it still stands until it becomes real.
        const ids = new Set(open.map(c => c.c));
        const sel = (scan.pro && ids.has(scan.pro)) ? scan.pro : scan.hist.find(id => ids.has(id)) || '';
        const all = open
          .map(c => ({ ...c, f: score(c.c, sel) }))
          .sort((a, b) => b.f - a.f || Number(b.done > 0) - Number(a.done > 0) || Number(b.total > 0) - Number(a.total > 0) || b.t - a.t);
        const best = all[0];
        if (!best) return '';
        const isSelected = best.f > 0;
        if (isSelected) changeId = best.c;
        // Two dimensions, two channels, no extra width: the hue is where the change is in its own
        // lifecycle — blue proposing (no tasks.md yet, same blue as the Planification phase), cyan
        // being applied, green every box ticked — and the weight is whether this session chose it
        // (bold `chg`) or the bar is recommending it (dim `df`).
        const stage = !best.total ? 111 : best.done === best.total ? 114 : 75;
        const tag = `\x1b[${isSelected ? 1 : 2};38;5;${stage}m${isSelected ? 'chg' : 'df'}\x1b[0m`;
        const name = isSelected ? trunc(best.c) : `\x1b[38;5;248m${trunc(best.c)}\x1b[0m`;
        // other open changes. Space-separated and "o"-suffixed so it can't read as arithmetic on the task count.
        const more = all.length > 1 ? ` \x1b[38;5;245m+${all.length - 1}o\x1b[0m` : '';
        if (!best.total) return `${tag} ${name} \x1b[38;5;245m·\x1b[0m${more}`;  // proposal not expanded yet
        if (best.done === best.total) return `${tag} ${name} \x1b[1;32m✓\x1b[0m${more}`;  // ready to /opsx:archive
        const pct = Math.round(100 * best.done / best.total);
        const c = pct >= 75 ? '\x1b[38;5;114m' : pct >= 25 ? '\x1b[33m' : '\x1b[38;5;250m';
        return `${tag} ${name} ${c}${best.done}/${best.total}\x1b[0m${more}`;
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

      const clean = (s) => (s || '').replace(/\[.*?\]/g, '').replace(/:thinking.*?$/g, '').replace(/^.*?\//, '').trim().toLowerCase();
      if (map) {
        if (modelId) {
          const val = map[modelId.toLowerCase()] ?? map[clean(modelId)];
          if (val !== undefined) return val;
        }
        if (modelName) {
          const val = map[modelName.toLowerCase()] ?? map[clean(modelName)];
          if (val !== undefined) return val;
        }
      }

      // OMP omits `int` for Haiku 4.5; AA Intelligence Index v4.1.1 scores its reasoning variant at 30.
      const isHaiku45 = (value) => {
        const key = clean(value)
          .replace(/\s*\([^)]*\)\s*$/, '')
          .replace(/^anthropic[.-]/, '')
          .replace(/\./g, '-')
          .replace(/\s+/g, '-');
        return /^(?:claude-)?(?:haiku-4-5|4-5-haiku)(?:-\d+)?$/.test(key);
      };
      return [modelId, modelName].some(isHaiku45) ? 30 : null;
    };

    const formatCompactTokens = (num) => {
      if (!Number.isFinite(num) || num <= 0) return '0';
      if (num >= 1000000) {
        const m = num / 1000000;
        return (m >= 100 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, '')) + 'M';
      }
      if (num >= 1000) {
        const k = num / 1000;
        return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
      }
      return String(Math.round(num));
    };

    const getRtkSavings = () => {
      if (!session) return null;
      try {
        const storeFile = path.join(os.homedir(), '.claude', 'session-context', `${session}.rtk`);
        if (!fs.existsSync(storeFile)) return null;
        const raw = fs.readFileSync(storeFile, 'utf8').trim();
        const saved = parseInt(raw, 10);
        if (!saved || saved <= 0 || !Number.isFinite(saved)) return null;
        return saved;
      } catch {
        return null;
      }
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
    if (d.cost?.total_duration_ms != null) {
      const mins = Math.round(d.cost.total_duration_ms / 60000);
      L1.push(`${timeColor(mins)}${mins}m\x1b[0m`);
    }
    // The phase is the headline feature, so it leads instead of trailing five ambient segments.
    if (sessionCtx) L1.unshift(sessionCtx);

    // ---- Line 2 (stats joined by |) ----
    const L2 = [];
    if (change) L2.push(change);
    if (d.cost?.total_cost_usd != null && d.cost.total_cost_usd > 0) {
      L2.push(`${costColor(d.cost.total_cost_usd)}$${d.cost.total_cost_usd.toFixed(2)}\x1b[0m`);
    }
    const savedTokens = getRtkSavings();
    const totalTokens = scan.total || 0;
    if (totalTokens > 0 || (savedTokens && savedTokens > 0)) {
      const totStr = totalTokens > 0 ? formatCompactTokens(totalTokens) : '';
      const savStr = savedTokens && savedTokens > 0 ? `\x1b[32m↓${formatCompactTokens(savedTokens)}\x1b[0m` : '';
      L2.push(`${totStr}${savStr}`);
    }
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

    // Warp/iTerm tab title. Only when Claude Code has stopped writing its own (it would overwrite
    // this within a turn). stdout is a pipe, so the title goes to the TTY of the nearest ancestor
    // that has one — the claude process. Written only on change: OSC every 5s is noise on the pty.
    if (process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE && session && process.platform !== 'win32') {
      try {
        // "▶ landing-tracking-par…" on a change, "⚠ DB schema migration" off one. Phase as a symbol
        // up front so a ⚠ reads from across the window. Same keys as PHASE above; unknown phases
        // keep 3 letters. Kept short enough to fit: Warp clips the active tab from the left.
        const SYM = { research: '🔍', explore: '🔍', analysis: '🔍', plan: '✎', planification: '✎', 'review-plan': '✎?',
                      exec: '▶', 'q&a': '?', review: '?', 'review-execution': '?', critique: '?', verify: '✔', done: '✓',
                      debug: '🐛', fix: '🐛', focus: '◎', chat: '💬', docs: '📄',
                      'necesita-revisión': '⚠', 'necesita-revision': '⚠', 'needs-review': '⚠', confirma: '⚠', revisa: '⚠' };
        const m = focus.match(/^([\p{L}\d&-]+):\s*(.*)/u);
        const sym = m ? SYM[m[1].toLowerCase()] || m[1].slice(0, 3) : '';
        const subject = changeId || (m ? m[2] : focus) || dir;
        // ponytail: 18 fits a Warp tab with ~7 open; raise if it looks clipped with fewer
        const title = `${sym ? `${sym} ` : ''}${trunc(subject, 18)}`;
        const titleFile = path.join(os.homedir(), '.claude', 'session-context', `${session}.title`);
        // Re-sent when the title changes or the phase file was touched since the last send: Warp
        // drops program titles on a hand-renamed tab, so "update your phase" is also the refresh.
        let prev = '', stale = false;
        try { prev = fs.readFileSync(titleFile, 'utf8'); stale = fs.statSync(focusFile).mtimeMs > fs.statSync(titleFile).mtimeMs; } catch {}
        if (title !== prev || stale) {
          let pid = process.ppid, tty = '';
          for (let i = 0; i < 6 && pid > 1; i++) {
            tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (tty && tty !== '??') break;
            pid = Number(execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
            tty = '';
          }
          if (tty) { fs.writeFileSync(`/dev/${tty}`, `\x1b]0;${title}\x07`); fs.writeFileSync(titleFile, title); }
        }
      } catch {}
    }
    process.stdout.write(`${L1.join(' | ')}\n${L2.join(' | ')}`);
  } catch (e) {}
});
