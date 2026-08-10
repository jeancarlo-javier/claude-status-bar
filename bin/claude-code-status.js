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

    process.stdout.write(`${L1.join(' | ')}\n${L2.join(' | ')}`);
  } catch (e) {}
});
