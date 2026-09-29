#!/usr/bin/env node
// subagent-status — the `subagentStatusLine` command. Rewrites each row of Claude Code's agent
// panel: what the agent is doing on the left, and the model with the effort the agent actually
// runs at opening the metrics on the right:
//
//   ◯ Verify: auth tests                             Sonnet 5 [high·55] · 1m 35s · ↓ 93.2k tokens
//
// Claude hands every visible row on stdin (`tasks[]` with id, model, effort, label, startTime,
// tokenCount) and reads back one `{"id","content"}` JSON line per row to override. The row's
// `effort` is only the configured value; the applied one and the agent's own phase come from
// files hooks/subagent-effort.js arranges.
process.removeAllListeners('warning');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scoreFor = require('./intelligence');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(input);
    if (!Array.isArray(d.tasks)) return;
    const width = Number.isFinite(d.columns) ? d.columns : 120;
    const strip = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\[.*?\]/g, '').trim();

    // Per-agent files, keyed <session>.<agent_id>:
    //   .agent.json — the effort the subagent itself reported (after Claude's silent per-model
    //                 downgrade), written by hooks/subagent-effort.js. Absent until the agent's
    //                 first tool call — then it is simply not shown, never borrowed from the session.
    //   .phase      — `Phase: subject` the subagent writes about itself; replaces the description.
    const sid = /^[\w-]+$/.test(d.session_id || '') ? d.session_id : '';
    const ownOf = id => {
      const f = path.join(os.homedir(), '.claude', 'session-context', `${sid}.${id}`);
      let rec = {}; try { rec = JSON.parse(fs.readFileSync(`${f}.agent.json`, 'utf8')); } catch {}
      try { rec.phase = strip(fs.readFileSync(`${f}.phase`, 'utf8').split('\n')[0]); } catch {}
      return rec;
    };

    // "claude-sonnet-5" / "claude-fable-5-1[1m]" -> "Sonnet 5" / "Fable 5.1"; anything else as-is.
    const modelName = id => {
      const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
      return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
    };
    const effortName = e => typeof e === 'number' ? `${e}` : strip(e).toLowerCase().replace(/^medium$/, 'med');
    const elapsed = ms => {
      const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
      return h ? `${h}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
    };
    const tokens = n => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${n}`;
    const dim = s => `\x1b[2m${s}\x1b[0m`;

    for (const t of d.tasks) {
      if (typeof t?.id !== 'string' || !/^[\w-]+$/.test(t.id)) continue;
      const id = strip(t.model);
      const own = sid ? ownOf(t.id) : {};
      const effort = own.effort ?? t.effort;
      const eName = effort != null && effortName(effort);
      const sc = scoreFor(eName, id);
      const tag = [eName, sc && `${sc.approx ? '≤' : ''}${Math.round(sc.score)}`].filter(Boolean);
      const model = (id ? modelName(id) : '…') + (tag.length ? ` [${tag.join('·')}]` : '');
      const left = [t.name, own.phase || strip(t.label || t.description)].filter(Boolean).join('  ');
      const right = `${model} · ${elapsed(Date.now() - (t.startTime || Date.now()))} · ↓ ${tokens(t.tokenCount || 0)} tokens`;
      // ponytail: [...str].length is code points, not cells; wide glyphs in a label shift the right edge by a cell
      const gap = Math.max(2, width - [...left].length - [...right].length);
      // the model reads at full brightness; the counters keep the native dim
      process.stdout.write(JSON.stringify({ id: t.id, content: `${left}${' '.repeat(gap)}${model}${dim(right.slice(model.length))}` }) + '\n');
    }
  } catch {} // no output → Claude keeps its native rows
});
