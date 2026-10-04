#!/usr/bin/env node
'use strict';
process.removeAllListeners('warning');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, 'subagent-status.js');
const HOOK = path.join(__dirname, '..', 'hooks', 'subagent-effort.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-test-'));
const home = path.join(tmp, 'home');
const ctx = path.join(home, '.claude', 'session-context');
// scores come from the committed data/intelligence.json snapshot; expectations read it, so a refresh doesn't break them
const M = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'intelligence.json'), 'utf8')).models;
const sc = (k, e) => Math.round(M[k][e]);
const SESSION = 'sess-rows';

const run = (bin, payload) => spawnSync(process.execPath, [bin], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  encoding: 'utf8',
  env: { ...process.env, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
}).stdout;
const rows = payload => run(BIN, payload).trim().split('\n').filter(Boolean).map(JSON.parse);
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

try {
  const now = Date.now();
  const tasks = [
    { id: 'a', label: 'Sonnet low idle 5 min', startTime: now - 5000, model: 'claude-sonnet-5', tokenCount: 41500 },
    { id: 'b', name: 'Reviewer', label: 'Reading modal wiring', startTime: now - 95000, model: 'claude-opus-5[1m]', effort: 'xhigh', tokenCount: 93200 },
    { id: 'c', label: 'Booting', startTime: now, tokenCount: 0 },
    { label: 'no id, no override' },
  ];

  // ---- before any subagent has run a tool: nothing recorded, no effort invented ----
  let r = rows({ session_id: SESSION, columns: 120, tasks });
  assert.equal(r.length, 3, 'a row without an id must be left to Claude');
  assert.ok(plain(r[0].content).startsWith('Sonnet low idle 5 min'), plain(r[0].content));
  assert.ok(plain(r[0].content).endsWith(`Sonnet 5 [≤${sc('sonnet-5', 'max')}] · 5s · ↓ 41.5k tokens`), plain(r[0].content));
  // the model is the one bright thing on the right; the counters keep the native dim
  assert.ok(r[0].content.includes(`Sonnet 5 [≤${sc('sonnet-5', 'max')}]\x1b[2m · 5s · ↓ 41.5k tokens\x1b[0m`), JSON.stringify(r[0].content));
  assert.equal(plain(r[0].content).length, 120, 'right edge must sit on the last column');
  // configured effort is all the panel knows about b; variant suffix stripped; name kept
  assert.ok(plain(r[1].content).startsWith('Reviewer  Reading modal wiring'), plain(r[1].content));
  assert.ok(plain(r[1].content).endsWith(`Opus 5 [xhigh·${sc('opus-5', 'xhigh')}] · 1m 35s · ↓ 93.2k tokens`), plain(r[1].content));
  assert.ok(plain(r[2].content).startsWith('Booting') && plain(r[2].content).endsWith('… · 0s · ↓ 0 tokens'), plain(r[2].content));

  // ---- the hook fires inside the subagents ----
  // main thread: agent_id absent → nothing recorded
  assert.equal(run(HOOK, { session_id: SESSION, effort: { level: 'medium' } }), '');
  assert.ok(!fs.existsSync(ctx), 'the main thread must not be recorded as an agent');
  // no phase file yet → the subagent is reminded where to write it
  const nudge = JSON.parse(run(HOOK, { session_id: SESSION, agent_id: 'a', agent_type: 'general-purpose', effort: { level: 'medium' } }));
  assert.equal(nudge.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(nudge.hookSpecificOutput.additionalContext.includes(path.join(ctx, 'sess-rows.a.phase')), 'the reminder must name the exact phase path');
  // b was configured xhigh but Claude downgraded it for the model: the applied level wins
  run(HOOK, { session_id: SESSION, agent_id: 'b', agent_type: 'code-reviewer', effort: { level: 'high' } });
  run(HOOK, { session_id: 'sess-other', agent_id: 'c', agent_type: 'general-purpose', effort: { level: 'low' } });
  run(HOOK, { session_id: '../escape', agent_id: 'c', effort: { level: 'low' } });
  assert.deepEqual(fs.readdirSync(ctx).filter(f => !f.endsWith('.phase')).sort(), ['sess-other.c.agent.json', 'sess-rows.a.agent.json', 'sess-rows.b.agent.json']);

  r = rows({ session_id: SESSION, columns: 120, tasks });
  assert.ok(plain(r[0].content).startsWith('Sonnet low idle 5 min'), plain(r[0].content));
  assert.ok(plain(r[0].content).endsWith(`Sonnet 5 [med·${sc('sonnet-5', 'medium')}] · 5s · ↓ 41.5k tokens`), plain(r[0].content));
  assert.ok(plain(r[1].content).startsWith('Reviewer  Reading modal wiring'), plain(r[1].content));
  assert.ok(plain(r[1].content).endsWith(`Opus 5 [high·${sc('opus-5', 'high')}] · 1m 35s · ↓ 93.2k tokens`), plain(r[1].content));
  assert.ok(plain(r[2].content).startsWith('Booting'), 'another session\'s record leaked into this one: ' + plain(r[2].content));

  // a per-request override the hook never sees (the /subagent mod pins effort in turn.step): the
  // subagent's transcript records the level each request carried, and the last one wins
  const transcript = path.join(tmp, 'proj', `${SESSION}.jsonl`);
  const agentLog = path.join(tmp, 'proj', SESSION, 'subagents', 'agent-b.jsonl');
  fs.mkdirSync(path.dirname(agentLog), { recursive: true });
  fs.writeFileSync(agentLog, '{"type":"assistant","effort":"low","perTurnEffort":"medium"}\n{"type":"user"}\n{"type":"assistant","effort":"low","perTurnEffort":"low"}\n');
  r = rows({ session_id: SESSION, transcript_path: transcript, columns: 120, tasks });
  assert.ok(plain(r[1].content).endsWith(`Opus 5 [low·${sc('opus-5', 'low')}] · 1m 35s · ↓ 93.2k tokens`), plain(r[1].content));
  // no transcript for a: the hook's record still holds
  assert.ok(plain(r[0].content).endsWith(`Sonnet 5 [med·${sc('sonnet-5', 'medium')}] · 5s · ↓ 41.5k tokens`), plain(r[0].content));

  // Haiku 4.5 has no effort parameter: the hook input carries no effort → nothing to record,
  // and the score is its model-wide one
  run(HOOK, { session_id: SESSION, agent_id: 'h', agent_type: 'general-purpose' });
  assert.ok(!fs.existsSync(path.join(ctx, 'sess-rows.h.agent.json')), 'no effort, no record');
  const haiku = plain(rows({ session_id: SESSION, columns: 120, tasks: [
    { id: 'h', label: 'Haiku low sleep 5m', startTime: now - 33000, model: 'claude-haiku-4-5', tokenCount: 28500 },
  ] })[0].content);
  assert.ok(haiku.startsWith('Haiku low sleep 5m'), haiku);
  assert.ok(haiku.endsWith(`Haiku 4.5 [${sc('haiku-4.5', '*')}] · 33s · ↓ 28.5k tokens`), haiku);

  // a second tool call at the same level is not a second write
  const mtime = fs.statSync(path.join(ctx, 'sess-rows.a.agent.json')).mtimeMs;
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(ctx, 'sess-rows.a.agent.json'), past, past);
  run(HOOK, { session_id: SESSION, agent_id: 'a', agent_type: 'general-purpose', effort: { level: 'medium' } });
  assert.ok(fs.statSync(path.join(ctx, 'sess-rows.a.agent.json')).mtimeMs < mtime, 'an unchanged level was rewritten');

  // ---- SubagentStart: the subagent learns its phase path; nothing else is recorded ----
  const phaseFile = path.join(ctx, 'sess-rows.p.phase');
  const start = JSON.parse(run(HOOK, { hook_event_name: 'SubagentStart', session_id: SESSION, agent_id: 'p', agent_type: 'Explore' }));
  assert.equal(start.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.ok(start.hookSpecificOutput.additionalContext.includes(phaseFile), 'the subagent must be told the exact phase path');
  assert.ok(!fs.existsSync(path.join(ctx, 'sess-rows.p.agent.json')));
  fs.writeFileSync(path.join(ctx, 'sess-rows.q.phase'), 'Exec: q\n');
  assert.equal(run(HOOK, { session_id: SESSION, agent_id: 'q', agent_type: 'x', effort: { level: 'low' } }), '', 'PreToolUse must stay silent once the phase exists');
  const prow = () => plain(rows({ session_id: SESSION, columns: 120, tasks: [
    { id: 'p', label: 'Find the auth wiring', startTime: now - 5000, model: 'claude-sonnet-5', tokenCount: 1000 },
  ] })[0].content);
  assert.ok(prow().startsWith('Find the auth wiring'), prow());
  // the phase the subagent writes replaces the description; first line only, an empty file counts as none
  fs.writeFileSync(phaseFile, 'Verify: auth tests\nscratch\n');
  assert.ok(prow().startsWith('Verify: auth tests    '), prow());
  fs.writeFileSync(phaseFile, '\n');
  assert.ok(prow().startsWith('Find the auth wiring'), prow());

  assert.equal(run(BIN, '{broken'), '', 'a broken payload must leave the native rows alone');
  assert.equal(run(BIN, { tasks: 'nope' }), '', 'a payload without rows must leave the native rows alone');
  console.log('ok — subagent rows');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
