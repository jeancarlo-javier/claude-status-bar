#!/usr/bin/env node
'use strict';
process.removeAllListeners('warning');

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
const SESSION = 'sess-test-' + Date.now();
// the prompt-cache accounting test needs its own transcript, so its own session id and sidecar
const CACHE_SESSION = 'sess-cache-' + Date.now();
// the Planification tests need their own transcript, session id and sidecars too
const PLAN_SESSION = 'sess-plan-' + Date.now();
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

function render(payload = STDIN_JSON) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, HOME: home },
      cwd: home,
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
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
  assert.ok(line2.startsWith('df live-change 2/3 +3o'), `openspec change missing, or others not counted: ${JSON.stringify(plain)}`);
  // hue = lifecycle stage (cyan 75 = being applied), weight = who chose it (dim 2 = recommendation)
  assert.ok(out.includes('\x1b[2;38;5;75mdf\x1b[0m'), `df tag not dim cyan for a change in progress: ${JSON.stringify(out)}`);
  assert.ok(out.includes('\x1b[38;5;248mlive-change\x1b[0m'), `unselected change name not subdued grey 248: ${JSON.stringify(out)}`);
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

  // an acknowledgement is not a transition: both hooks tell the model to `touch` a label that is
  // still right, and mtime alone would restart the clock every time that happened
  setPhase('Exec: Compact the status bar', 0);   // same text, mtime reset to now — a touch
  assert.ok((await render()).replace(/\x1b\[[0-9;]*m/g, '').startsWith('Exec 3h20m: '),
    'a touch on an unchanged label restarted the time-in-phase clock');

  // a genuinely new label does start the clock over
  setPhase('Verify: the migration ran', 0);
  assert.ok(!/Verify \d/.test((await render()).replace(/\x1b\[[0-9;]*m/g, '')),
    'a changed label kept the previous phase age');

  // waiting on the user is the one state that has to carry across tabs: reverse-video chip
  setPhase('Needs-Review: approve the plan');
  assert.ok((await render()).startsWith('\x1b[1;7;38;5;226mNeeds-Review'), 'Needs-Review is not rendered as a chip');
  setPhase('Exec: Compact the status bar');

  // model display name is stripped of its parenthetical ("Opus 5 (1M context)" -> "Opus 5")
  assert.ok(!line1.includes('('), `model parenthetical not stripped: ${JSON.stringify(plain)}`);

  // every task checked -> the archive-me tick, not "3/3"
  fs.writeFileSync(path.join(chg, 'live-change', 'tasks.md'), '- [x] a\n- [X] b\n- [x] c\n');
  const doneOutput = await render();
  const done = doneOutput.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(done.startsWith('df live-change ✓'), `completed change not flagged for archive: ${JSON.stringify(done)}`);
  assert.ok(doneOutput.includes('\x1b[2;38;5;114mdf\x1b[0m'), `every box ticked did not turn the tag green: ${JSON.stringify(doneOutput)}`);

  // archived changes drop off on the next render, with no restart
  fs.renameSync(path.join(chg, 'live-change'), path.join(chg, 'archive', '2026-08-28-live-change'));
  const archived = (await render()).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(!archived.includes('live-change'), `archived change still rendered: ${JSON.stringify(archived)}`);

  // 1200 output tokens / 20s of API time = 60 tok/s, last stat on line 2
  assert.ok(line2.endsWith('60 tok/s'), `tok/s missing from end of line 2: ${JSON.stringify(plain)}`);
  assert.ok(out.includes('\x1b[32m60 tok/s\x1b[0m'), `fast tok/s not green: ${JSON.stringify(out)}`);

  // tok/s is counted incrementally: the next render must read only the appended bytes and still
  // reach 2000/20s = 100, proving the sidecar carries the running total rather than recounting.
  fs.appendFileSync(transcript, '{"requestId":"req_c","message":{"usage":{"output_tokens":800}}}\n');
  const grownOut = await render();
  const grown = grownOut.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(grown.endsWith('100 tok/s'), `incremental tok/s did not pick up the append: ${JSON.stringify(grown)}`);
  assert.ok(grownOut.includes('\x1b[32m100 tok/s\x1b[0m'), `100 tok/s not green: ${JSON.stringify(grownOut)}`);

  // tok/s color thresholds: green >= 60, yellow 30..59, red < 30 (with decimals like 18.5)
  const medOut = await render({
    ...JSON.parse(STDIN_JSON),
    cost: { total_duration_ms: 600000, total_api_duration_ms: 2000000 / 45 }, // 2000 tokens / (44.44s) = 45 tok/s
  });
  assert.ok(medOut.includes('\x1b[33m45 tok/s\x1b[0m'), `medium tok/s not yellow: ${JSON.stringify(medOut)}`);

  const slowOut = await render({
    ...JSON.parse(STDIN_JSON),
    cost: { total_duration_ms: 600000, total_api_duration_ms: 2000000 / 18.5 }, // 2000 tokens / (108.1s) = 18.5 tok/s
  });
  assert.ok(slowOut.includes('\x1b[31m18.5 tok/s\x1b[0m'), `slow tok/s not red: ${JSON.stringify(slowOut)}`);

  // cost color thresholds: green $0..$3, yellow $3..$6, red > $6
  const cheapCostOut = await render({
    ...JSON.parse(STDIN_JSON),
    cost: { total_cost_usd: 2.50, total_duration_ms: 600000 },
  });
  assert.ok(cheapCostOut.includes('\x1b[32m$2.50\x1b[0m'), `cheap cost not green: ${JSON.stringify(cheapCostOut)}`);

  const medCostOut = await render({
    ...JSON.parse(STDIN_JSON),
    cost: { total_cost_usd: 4.50, total_duration_ms: 600000 },
  });
  assert.ok(medCostOut.includes('\x1b[33m$4.50\x1b[0m'), `moderate cost not yellow: ${JSON.stringify(medCostOut)}`);

  const expCostOut = await render({
    ...JSON.parse(STDIN_JSON),
    cost: { total_cost_usd: 8.50, total_duration_ms: 600000 },
  });
  assert.ok(expCostOut.includes('\x1b[31m$8.50\x1b[0m'), `expensive cost not red: ${JSON.stringify(expCostOut)}`);

  const [cheapL1, cheapL2] = cheapCostOut.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  assert.ok(!cheapL1.includes('$2.50'), `cost should not be in line 1: ${JSON.stringify(cheapL1)}`);
  assert.ok(cheapL2.includes('df just-proposed-change 0/2 +2o | $2.50'), `change must precede cost on line 2: ${JSON.stringify(cheapL2)}`);

  // RTK token savings test: optional, only shown when session-specific .rtk file exists with saved tokens
  const sessionRtkFile = path.join(home, '.claude', 'session-context', `${SESSION}.rtk`);
  fs.writeFileSync(sessionRtkFile, '34011');

  const rtkOut = await render({
    ...JSON.parse(STDIN_JSON),
    cost: { total_cost_usd: 20.54, total_duration_ms: 600000 },
  });
  assert.ok(rtkOut.includes('\x1b[32m↓34k\x1b[0m'), `rtk compact savings badge missing or uncolored: ${JSON.stringify(rtkOut)}`);
  const [, rtkL2] = rtkOut.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  assert.ok(rtkL2.includes('$20.54 | 2k↓34k | ctx'), `rtk badge must sit between cost and ctx with compacted total: ${JSON.stringify(rtkL2)}`);

  // When session .rtk file has 0 saved tokens or is absent, badge must not be shown
  fs.writeFileSync(sessionRtkFile, '0');
  const zeroRtkOut = await render();
  assert.ok(!zeroRtkOut.includes('↓'), `zero saved tokens must not render badge: ${JSON.stringify(zeroRtkOut)}`);
  fs.unlinkSync(sessionRtkFile);
  const noRtkOut = await render();
  assert.ok(!noRtkOut.includes('↓'), `absent session rtk file must not render badge: ${JSON.stringify(noRtkOut)}`);
  assert.ok(noRtkOut.includes('2k | ctx'), `total tokens without savings must render before ctx: ${JSON.stringify(noRtkOut)}`);
  for (const token of ['| h:', '💧', '👀', '🚶', '☀️', "-hd"]) {
    assert.ok(!plain.includes(token), `removed health token rendered: ${token}`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'health-reminders.json')),
    'health state file was created');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'health-reminders.json.activity')),
    'health activity sidecar was created');
  // rate limits show ultra-compact reset countdown: ~3h, ~2d, and minutes ~45m when < 1h
  const nowSec = Math.floor(Date.now() / 1000);
  const rlOut = await render({
    ...JSON.parse(STDIN_JSON),
    rate_limits: {
      five_hour: { used_percentage: 41, resets_at: nowSec + 3 * 3600 },
      seven_day: { used_percentage: 59, resets_at: nowSec + 2 * 86400 },
    },
  });
  const rlPlain = rlOut.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(rlPlain.includes('5h~3h ▃ 41%'), `5h ~3h reset missing: ${JSON.stringify(rlPlain)}`);
  assert.ok(rlPlain.includes('wk~2d ▅ 59%'), `wk ~2d reset missing: ${JSON.stringify(rlPlain)}`);
  assert.ok(rlOut.includes('\x1b[38;5;245m~3h\x1b[0m'), `5h reset not colored dim grey: ${JSON.stringify(rlOut)}`);

  // when less than 1h remains, minutes are shown (~45m)
  const minOut = (await render({
    ...JSON.parse(STDIN_JSON),
    rate_limits: {
      five_hour: { used_percentage: 92, resets_at: nowSec + 45 * 60 },
    },
  })).replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(minOut.includes('5h~45m ▇ 92%'), `minutes (<1h) reset missing: ${JSON.stringify(minOut)}`);

  // pace: the same 88% is grey when the window is nearly over (it will not tip) and amber when
  // three hours remain at that burn (88% of a 5h window spent in its first 2h projects to 220%)
  const paceOut = await render({
    ...JSON.parse(STDIN_JSON),
    rate_limits: { five_hour: { used_percentage: 88, resets_at: nowSec + 3 * 3600 } },
  });
  assert.ok(paceOut.includes('\x1b[33m~3h\x1b[0m'), `off-pace reset not amber: ${JSON.stringify(paceOut)}`);
  const onPaceOut = await render({
    ...JSON.parse(STDIN_JSON),
    rate_limits: { five_hour: { used_percentage: 88, resets_at: nowSec + 30 * 60 } },
  });
  assert.ok(onPaceOut.includes('\x1b[38;5;245m~30m\x1b[0m'), `on-pace reset not grey: ${JSON.stringify(onPaceOut)}`);

  // a spiky start must not paint the bar amber: under 50% used the projection is not a signal
  const earlyOut = await render({
    ...JSON.parse(STDIN_JSON),
    rate_limits: { five_hour: { used_percentage: 30, resets_at: nowSec + 4 * 3600 } },
  });
  assert.ok(earlyOut.includes('\x1b[38;5;245m~4h\x1b[0m'), `early burn should stay grey: ${JSON.stringify(earlyOut)}`);

  // exhausted: the countdown stops being a warning and becomes the ETA back to work, so it leads
  const doneOut = await render({
    ...JSON.parse(STDIN_JSON),
    rate_limits: { five_hour: { used_percentage: 100, resets_at: nowSec + 80 * 60 } },
  });
  assert.ok(doneOut.includes('\x1b[1;38;5;203m~1h\x1b[0m'), `exhausted reset not highlighted: ${JSON.stringify(doneOut)}`);

  // ── which change is being worked ───────────────────────────────────────────────────────────
  // A change blocked on someone else sits at 32/34 forever and outranks the one you switched to,
  // because "has a checked task" is a binary key. The transcript settles it: what the session
  // deliberately selected wins over what merely looks furthest along.
  fs.mkdirSync(path.join(chg, 'blocked-change'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'blocked-change', 'tasks.md'), '- [x] a\n- [x] b\n- [ ] c\n');
  fs.mkdirSync(path.join(chg, 'fresh-change'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'fresh-change', 'tasks.md'), '- [ ] a\n- [ ] b\n');
  fs.utimesSync(path.join(chg, 'fresh-change', 'tasks.md'), new Date(0), new Date(0));

  const say = (...lines) => fs.appendFileSync(transcript, lines.join('\n') + '\n');
  const chgSeg = async () => (await render()).replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')[1].match(/(?:chg|df) (\S+)/)?.[1];
  const tagSeg = async () => (await render()).replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')[1].match(/^(chg|df) /)?.[1];
  const userMsg = (text, extra = '') => `{"type":"user"${extra},"message":{"role":"user","content":${JSON.stringify(text)}}}`;
  const toolUse = (input) => `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":${JSON.stringify(input)}}]}}`;

  // progress alone: the blocked change wins, which is the bug
  assert.equal(await chgSeg(), 'blocked-change', 'baseline: furthest-along change should lead');
  assert.equal(await tagSeg(), 'df', 'baseline change should be tagged df');
  assert.ok((await render()).includes('\x1b[2;38;5;75mdf\x1b[0m'), 'df tag must be dim cyan while the change is in progress');

  // an `ls` listing every change is tool *output* — it must not select anything
  say(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"openspec/changes/fresh-change/\\nopenspec/changes/blocked-change/"}]}}`);
  assert.equal(await chgSeg(), 'blocked-change', 'a tool_result listing moved the pin');

  // opening one of its files does
  say(toolUse({ file_path: '/repo/openspec/changes/fresh-change/tasks.md' }));
  assert.equal(await chgSeg(), 'fresh-change', 'opening a change file did not select it');
  assert.equal(await tagSeg(), 'chg', 'selected change should be tagged chg');
  assert.ok((await render()).includes('\x1b[1;38;5;75mchg\x1b[0m'), 'a selected change in progress must be bold cyan 75');

  // a subagent's picks belong to the subagent, and isMeta is the harness talking, not you
  say(toolUse({ file_path: '/repo/openspec/changes/blocked-change/tasks.md' }).replace('{"type":"assistant"', '{"type":"assistant","isSidechain":true'));
  say(userMsg('/opsx:apply blocked-change', ',"isMeta":true'));
  assert.equal(await chgSeg(), 'fresh-change', 'a sidechain or meta record moved the pin');

  // one line, two blocks: skipping the whole line because it holds a tool_result would lose the ask
  say(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"noise"},{"type":"text","text":"/opsx:apply blocked-change"}]}}`);
  assert.equal(await chgSeg(), 'blocked-change', 'text block alongside a tool_result was dropped');

  // a slash command arrives split across tags, never as the line you typed
  say(userMsg('<command-message>opsx:apply</command-message>\n<command-name>/opsx:apply</command-name>\n<command-args>fresh-change</command-args>'));
  assert.equal(await chgSeg(), 'fresh-change', 'a real /opsx: slash command did not select its argument');

  // naming exactly one change selects it
  say(userMsg('sigo con fresh-change'));
  assert.equal(await chgSeg(), 'fresh-change', 'prose naming one change did not select it');

  // A command is the selection and holds; naming a change any other way is an aside that must not
  // outlive itself. So an aside follows, and then the next thing said drops it again.
  say(userMsg('/opsx:apply fresh-change'));
  say(userMsg('por cierto, blocked-change sigue esperando al otro equipo'));
  assert.equal(await chgSeg(), 'blocked-change', 'a change named in passing was not followed');
  say(userMsg('vale, sigue con lo del tracking entonces'));
  assert.equal(await chgSeg(), 'fresh-change', 'the aside outlived the message that made it');

  // naming two at once is ambiguous: it selects neither, and leaves the command standing
  say(userMsg('apply fresh-change; blocked-change sigue bloqueado'));
  assert.equal(await chgSeg(), 'fresh-change', 'prose naming two changes picked one anyway');

  // the id a workflow command was handed, even with no path in sight
  say(toolUse({ command: 'openspec status --change "blocked-change" --json' }));
  assert.equal(await chgSeg(), 'blocked-change', '--change did not select the change');

  // /opsx:propose is scanned before it creates the directory, and these bytes are never re-read:
  // the id has to survive not existing yet
  // until it exists it cannot be selected, and the change you were on has to stay put meanwhile
  say(userMsg('/opsx:propose later-change'));
  assert.equal(await chgSeg(), 'blocked-change', 'an id with no directory should not select');
  assert.equal(await chgSeg(), 'blocked-change', 'a proposal in flight dropped the change being worked');
  fs.mkdirSync(path.join(chg, 'later-change'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'later-change', 'tasks.md'), '- [ ] a\n');
  assert.equal(await chgSeg(), 'later-change', 'the id was forgotten before its directory appeared');

  // a prefix is not a match: selecting "later-change" must not be read as selecting "later-change-2"
  fs.mkdirSync(path.join(chg, 'later-change-2'), { recursive: true });
  fs.writeFileSync(path.join(chg, 'later-change-2', 'tasks.md'), '- [x] a\n- [ ] b\n');
  assert.equal(await chgSeg(), 'later-change', 'a longer id sharing the prefix stole the selection');

  // dummy example placeholders like add-auth must never be selected
  say(userMsg('**Input**: Optionally specify a change name (e.g., `/opsx:apply add-auth`).'));
  assert.equal(await chgSeg(), 'later-change', 'dummy example placeholder add-auth was erroneously selected');

  // stage hue: a change still being proposed (no tasks.md) is the blue of the Planification phase,
  // so both rows say "designing" at once
  fs.mkdirSync(path.join(chg, 'proposal-only'), { recursive: true });
  say(userMsg('/opsx:apply proposal-only'));
  const proposalOut = await render();
  assert.ok(proposalOut.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1].startsWith('chg proposal-only ·'),
    `a change with no tasks.md did not render as a bare proposal: ${JSON.stringify(proposalOut)}`);
  assert.ok(proposalOut.includes('\x1b[1;38;5;111mchg\x1b[0m'), `a proposal's tag is not plan blue 111: ${JSON.stringify(proposalOut)}`);
  say(userMsg('/opsx:apply later-change'));

  // subproject discovery: root openspec/changes has archive only, subproject has active change
  const umbrellaDir = path.join(home, 'umbrella');
  fs.mkdirSync(path.join(umbrellaDir, 'openspec', 'changes', 'archive'), { recursive: true });
  const subprojectChanges = path.join(umbrellaDir, 'subpkg', 'openspec', 'changes', 'sub-feature');
  fs.mkdirSync(subprojectChanges, { recursive: true });
  fs.writeFileSync(path.join(subprojectChanges, 'tasks.md'), '- [x] task 1\n- [ ] task 2\n');
  const umbrellaOut = (await render({
    ...JSON.parse(STDIN_JSON),
    workspace: { current_dir: umbrellaDir },
  })).replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(umbrellaOut.includes('df sub-feature 1/2'), `subproject change missing in umbrella dir: ${JSON.stringify(umbrellaOut)}`);

  // ── Planification: the one phase the bar writes itself ────────────────────────────────────
  // `/opsx:propose` is the only transition with a machine-readable trigger: the workflow always
  // ends up running an OpenSpec command that names the slug it just chose. Every other phase
  // stays the model's to write.
  const planFile = path.join(home, '.claude', 'session-context', PLAN_SESSION);
  const planTx = path.join(home, 'plan-transcript.jsonl');
  fs.writeFileSync(planTx, '');
  const planRender = () => render({ ...JSON.parse(STDIN_JSON), session_id: PLAN_SESSION, transcript_path: planTx });
  const planPhase = () => { try { return fs.readFileSync(planFile, 'utf8').trim(); } catch { return ''; } };
  const planSay = (...lines) => fs.appendFileSync(planTx, lines.join('\n') + '\n');
  const at = (min = 0) => new Date(Date.now() + min * 60000).toISOString();
  // A manual label wins on mtime, so the tests set that mtime explicitly instead of racing it.
  const setManual = (text, minutesAgo = 0) => {
    fs.writeFileSync(planFile, text + '\n');
    const when = new Date(Date.now() - minutesAgo * 60000);
    fs.utimesSync(planFile, when, when);
  };
  // a slash command never reaches the transcript the way it was typed
  const propose = (extra = '') => `{"type":"user"${extra},"message":{"role":"user","content":[{"type":"text","text":"<command-message>opsx:propose</command-message>\\n<command-name>/opsx:propose</command-name>"}]}}`;
  const bashUse = (command, when = at(), extra = '') => `{"type":"assistant"${extra},"timestamp":${JSON.stringify(when)},"message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":${JSON.stringify(command)}}}]}}`;

  // the command alone is not the trigger: with no proposal in flight nothing is inferred
  planSay(bashUse('openspec new change unarmed-change'));
  await planRender();
  assert.equal(planPhase(), '', `an unarmed openspec command wrote a phase: ${JSON.stringify(planPhase())}`);

  // armed, but only a command that actually runs counts — a wrapper or a quoted example is text
  planSay(propose(), bashUse('echo npx openspec new change false-slug'), bashUse("openspec --example='status --change fake '"));
  await planRender();
  assert.equal(planPhase(), '', `a wrapped or quoted command fired: ${JSON.stringify(planPhase())}`);

  // the canonical propose step does, and the chip leads line 1 in plan blue
  planSay(bashUse('openspec new change "pr-flow-gate"'));
  const planOut = await planRender();
  assert.equal(planPhase(), 'Planification: pr-flow-gate', `propose did not set the phase: ${JSON.stringify(planPhase())}`);
  assert.ok(planOut.startsWith('\x1b[1;38;5;111mPlanification'), `Planification chip not plan blue: ${JSON.stringify(planOut.slice(0, 40))}`);

  // the phase is the model's again the moment it writes one, and a replay must not undo that: the
  // tmp sidecar is swept, the whole transcript is re-derived, and the label on disk is newer. A
  // minute of daylight, not a shared millisecond: the comparison is the subject, not clock grain.
  setManual('Exec: build the thing', -1);
  fs.unlinkSync(path.join(os.tmpdir(), `ccs-tps-${PLAN_SESSION}.json`));
  await planRender();
  assert.equal(planPhase(), 'Exec: build the thing', `a replayed proposal overwrote a newer phase: ${JSON.stringify(planPhase())}`);

  // proposing again is a real transition, so a newer event does win — including the same slug,
  // and including the step that names an existing change instead of creating one
  setManual('Exec: build the thing', 30);
  planSay(propose(), bashUse('openspec status --change pr-flow-gate'));
  await planRender();
  assert.equal(planPhase(), 'Planification: pr-flow-gate', `re-proposing the same slug did not reactivate: ${JSON.stringify(planPhase())}`);

  // a cancelled proposal stops arming: the next OpenSpec command is ordinary work
  setManual('Exec: build the thing', 30);
  planSay(propose(), userMsg('cancel that, wrong repo'), bashUse('openspec status --change pr-flow-gate'));
  await planRender();
  assert.equal(planPhase(), 'Exec: build the thing', `a cancelled proposal still activated: ${JSON.stringify(planPhase())}`);

  // a clarification reply is part of proposing — even one that is only the slug — so the arm holds
  planSay(propose(), userMsg('pr-flow-gate'), bashUse('openspec new change pr-flow-gate'));
  await planRender();
  assert.equal(planPhase(), 'Planification: pr-flow-gate', `a clarification reply dropped the proposal: ${JSON.stringify(planPhase())}`);

  // a subagent proposing something is not this session's phase
  setManual('Exec: build the thing', 30);
  planSay(propose(',"isSidechain":true'), bashUse('openspec new change side-change', at(), ',"isSidechain":true'));
  await planRender();
  assert.equal(planPhase(), 'Exec: build the thing', `a subagent proposal moved the phase: ${JSON.stringify(planPhase())}`);

  // an event dated in the future would outrank a label written before it comes round, so a replay
  // could then overwrite that label: no honest clock, no activation
  setManual('Exec: build the thing', 30);
  planSay(propose(), bashUse('openspec new change future-change', at(30)));
  await planRender();
  assert.equal(planPhase(), 'Exec: build the thing', `a future-dated event activated: ${JSON.stringify(planPhase())}`);

  // a write that fails keeps the activation pending, and the retry has to land on a render that
  // has nothing new to read
  setManual('Exec: build the thing', 30);
  fs.chmodSync(planFile, 0o444);
  planSay(propose(), bashUse('openspec new change retried-change'));
  await planRender();
  assert.equal(planPhase(), 'Exec: build the thing', `an unwritable phase file was somehow written: ${JSON.stringify(planPhase())}`);
  fs.chmodSync(planFile, 0o644);
  await planRender();
  assert.equal(planPhase(), 'Planification: retried-change', `a failed activation was not retried: ${JSON.stringify(planPhase())}`);


  // intelligence score + effort formatting: e.g. "Gemini 3.7 Flash [high·56]"
  const intRender = await render({
    ...JSON.parse(STDIN_JSON),
    model: { id: 'gemini-3.7-flash', display_name: 'Gemini 3.7 Flash' },
    effort: 'high',
  });
  const intPlain = intRender.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
  assert.ok(intPlain.includes('Gemini 3.7 Flash [high·56]'), `intelligence badge missing: ${JSON.stringify(intPlain)}`);
  assert.ok(intRender.includes('\x1b[38;5;51m56\x1b[0m'), `frontier intelligence score not electric cyan: ${JSON.stringify(intRender)}`);

  // only medium is shortened: medium -> med
  const medRender = await render({
    ...JSON.parse(STDIN_JSON),
    model: { id: 'gemini-3.7-flash', display_name: 'Gemini 3.7 Flash' },
    effort: 'medium',
  });
  assert.ok(medRender.includes('Gemini 3.7 Flash \x1b[38;5;245m[\x1b[0m\x1b[38;2;108;184;110mmed\x1b[0m\x1b[38;5;245m·\x1b[0m\x1b[38;5;51m56\x1b[0m\x1b[38;5;245m]\x1b[0m'), 'medium was not abbreviated to med');

  const xhighRender = await render({
    ...JSON.parse(STDIN_JSON),
    model: { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
    effort: 'xhigh',
  });
  assert.ok(xhighRender.includes('Claude Opus 4.6 \x1b[38;5;245m[\x1b[0m\x1b[38;2;179;136;244mxhigh\x1b[0m\x1b[38;5;245m·\x1b[0m\x1b[38;5;114m39\x1b[0m\x1b[38;5;245m]\x1b[0m'), 'xhigh was unexpectedly abbreviated');

  const haikuRender = await render({
    ...JSON.parse(STDIN_JSON),
    model: { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    effort: 'high',
  });
  const haikuPlain = haikuRender.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
  assert.ok(haikuPlain.includes('Claude Haiku 4.5 [high·30]'), `Haiku 4.5 intelligence score missing: ${JSON.stringify(haikuPlain)}`);
  // ---- prompt-cache accounting, and the sidecar that outlives a counting change ----
  // Claude Code caches every prompt, so `input_tokens` is a residue of 2 while the real input
  // rides in cache_creation_input_tokens. Counting input+output alone read a 517k session as
  // 1.1k next to a $15.66 cost. cache_read is excluded on purpose: it re-bills the same prompt
  // every turn, so counting it would report ~4x the tokens the session actually transmitted.
  const cacheTranscript = path.join(home, 'cache-transcript.jsonl');
  const cacheSidecar = path.join(os.tmpdir(), `ccs-tps-${CACHE_SESSION}.json`);
  fs.writeFileSync(cacheTranscript, [
    // two content blocks of one request repeat its usage: counted once
    '{"requestId":"req_1","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":29506,"cache_read_input_tokens":26933,"output_tokens":297}}}',
    '{"requestId":"req_1","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":29506,"cache_read_input_tokens":26933,"output_tokens":297}}}',
    '{"requestId":"req_2","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":833,"cache_read_input_tokens":56439,"output_tokens":148}}}',
  ].join('\n') + '\n');
  const cachePayload = {
    ...JSON.parse(STDIN_JSON),
    session_id: CACHE_SESSION,
    transcript_path: cacheTranscript,
  };
  try { fs.unlinkSync(cacheSidecar); } catch {}

  // (2+29506+297) + (2+833+148) = 30788
  const cacheL2 = (await render(cachePayload)).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(cacheL2.includes('30.8k'), `cache_creation tokens not counted: ${JSON.stringify(cacheL2)}`);
  assert.ok(!cacheL2.includes('114k'), `cache_read must not be counted: ${JSON.stringify(cacheL2)}`);
  // tok/s stays output-only (445 / 20s): the badge's total and the speed counter must not conflate
  assert.ok(cacheL2.includes('22.3 tok/s'), `tok/s must stay output-only: ${JSON.stringify(cacheL2)}`);

  // A sidecar written by older arithmetic holds a byte offset already counted, so its numbers can
  // never be corrected incrementally — the version gate must throw it away and recount.
  fs.writeFileSync(cacheSidecar, JSON.stringify({
    off: fs.statSync(cacheTranscript).size, sum: 445, total: 449, last: 'req_2', hist: [], pro: '',
  }));
  const staleL2 = (await render(cachePayload)).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[1];
  assert.ok(staleL2.includes('30.8k'), `unversioned sidecar was trusted instead of recounted: ${JSON.stringify(staleL2)}`);

  console.log('ALL TESTS PASSED');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    fs.rmSync(home, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(os.tmpdir(), `ccs-phase-${SESSION}.json`)); } catch {}
    try { fs.unlinkSync(path.join(os.tmpdir(), `ccs-tps-${SESSION}.json`)); } catch {}
    try { fs.unlinkSync(path.join(os.tmpdir(), `ccs-tps-${CACHE_SESSION}.json`)); } catch {}
    try { fs.unlinkSync(path.join(os.tmpdir(), `ccs-phase-${PLAN_SESSION}.json`)); } catch {}
    try { fs.unlinkSync(path.join(os.tmpdir(), `ccs-tps-${PLAN_SESSION}.json`)); } catch {}
  });
