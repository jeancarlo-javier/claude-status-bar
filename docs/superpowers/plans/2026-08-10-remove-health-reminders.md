# Remove Health Reminder System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the health-reminder statusline and acknowledgement flow while preserving all phase, context, rate-limit, task, git, cost, and duration behavior.

**Architecture:** Delete the health subsystem at its two entry points: the renderer no longer owns health state or emits `h:`, and the UserPromptSubmit hook no longer interprets `-hd`. Keep the existing session-context nudge/guard pipeline and statusline data assembly unchanged. Replace the health-heavy test suite with one deterministic CLI contract test for the remaining output and absence of health artifacts.

**Tech Stack:** Node.js built-ins (`fs`, `os`, `path`, `child_process`), plain Node `assert`, Markdown documentation.

## Global Constraints

- Do not read or write `~/.claude/health-reminders.json` or its `.activity` sidecar.
- Do not treat `-hd` as a control token; it must follow the ordinary prompt path.
- Keep plugin hook registration, installation flow, phase-file format, and version number unchanged.
- Leave any existing health files in a user's home directory untouched.
- Do not add dependencies or introduce a configuration flag for the removed feature.

---

### Task 1: Replace health tests with the remaining statusline contract

**Files:**
- Modify: `bin/claude-code-status.test.js`

**Interfaces:**
- Consumes: `bin/claude-code-status.js` as a child-process CLI receiving JSON on stdin.
- Produces: a deterministic smoke test that fails while the health segment still renders or creates health files.

- [ ] **Step 1: Replace the health test suite with this CLI contract test**

```js
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
const STDIN_JSON = JSON.stringify({
  model: { display_name: 'M' },
  workspace: { current_dir: home },
  context_window: { remaining_percentage: 50 },
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
  const [line1, line2] = out.split('\n');

  assert.ok(line1.includes('M'), `model missing: ${JSON.stringify(out)}`);
  assert.ok(line2.includes('ctx '), `context segment missing: ${JSON.stringify(out)}`);
  assert.ok(line2.includes('63%'), `context percentage missing: ${JSON.stringify(out)}`);
  for (const token of ['h:', '💧', '👀', '🚶', '☀️', "-hd"]) {
    assert.ok(!out.includes(token), `removed health token rendered: ${token}`);
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
```

- [ ] **Step 2: Run the contract test before implementation**

Run: `node bin/claude-code-status.test.js`

Expected: FAIL because the current renderer emits `h:` and creates the health state/sidecar files.

- [ ] **Step 3: Commit the failing contract test**

```bash
git add bin/claude-code-status.test.js
git commit -m "test(statusline): specify health reminder removal"
```

### Task 2: Remove health state and acknowledgement code

**Files:**
- Modify: `bin/claude-code-status.js`
- Modify: `hooks/session-context-nudge.js`

**Interfaces:**
- Consumes: the contract test from Task 1 and existing statusline JSON input.
- Produces: a renderer with no health subsystem and a nudge hook that only handles session-context freshness.

- [ ] **Step 1: Delete the renderer health subsystem**

In `bin/claude-code-status.js`, remove the constants and functions from `HEALTH_STATE_PATH` through `ackDone`, including `HEALTH_REMINDERS`, `normalizeState`, `readHealthState`, `dueList`, `activityResume`, `deriveHealth`, `selectHealthPhrase`, `writeHealthState`, the helper exports, the `require.main` early return, and the `process.argv[2] === 'done'` branch. Keep the top-level `fs`, `path`, `os`, and `execSync` imports because the remaining renderer still uses them. Leave the stdin JSON renderer starting at `let input = ''` as the module's only execution path.

In the line-2 assembly, delete:

```js
const hp = selectHealthPhrase(Date.now());
if (hp) L2.push(`\x1b[36mh: ${hp}\x1b[0m`);
```

- [ ] **Step 2: Delete the hook acknowledgement branch**

In `hooks/session-context-nudge.js`, remove the `execFileSync` import and delete the `ACK_TOKEN` branch that invokes `claude-code-status.js done` and returns `{ continue: false, ... }`. Keep JSON parsing, session ID validation, session-context path validation, freshness handling, and stale/missing nudge output unchanged.

- [ ] **Step 3: Run the statusline contract test**

Run: `node bin/claude-code-status.test.js`

Expected: `ALL TESTS PASSED`, with no health files created under the temporary home.

- [ ] **Step 4: Commit the implementation removal**

```bash
git add bin/claude-code-status.js hooks/session-context-nudge.js
git commit -m "fix(statusline): remove health reminder system"
```

### Task 3: Remove obsolete health documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the post-removal renderer and hook behavior from Task 2.
- Produces: documentation describing only the remaining statusline and phase-context features.

- [ ] **Step 1: Update the file-role table**

Remove the sentence saying `hooks/session-context-nudge.js` intercepts `-hd` and checks off health reminders. Keep its phase freshness/nudge description.

- [ ] **Step 2: Update the output example and table**

Remove the `| h: ...` segment from the two-line example. Change the line-2 description to context-window usage plus 5-hour and weekly rate limits. Replace “Every segment except health is optional” with wording that all displayed segments are optional and depend on Claude Code payloads.

- [ ] **Step 3: Delete health behavior and data/privacy paragraphs**

Remove the health segment behavior paragraph, all `-hd`/`done` instructions, the health state and sidecar reads/writes, and any token-budget claims that describe health reminders. Keep the phase-file, todo, git, and retention documentation.

 - [ ] **Step 4: Verify the documentation no longer advertises health behavior**

Run:

```bash
node -e 'const assert = require("assert"); const text = require("fs").readFileSync("README.md", "utf8"); for (const token of ["| h:", "-hd", "health-reminders.json", "💧", "👀", "🚶", "☀️"]) assert.ok(!text.includes(token), `obsolete README token: ${token}`); console.log("README health references removed");'
```

Expected: `README health references removed`.

- [ ] **Step 5: Commit the documentation update**

```bash
git add README.md
git commit -m "docs: remove health reminder documentation"
```

### Task 4: Verify preserved phase hook behavior and final output

**Files:**
- Verify: `bin/claude-code-status.js`
- Verify: `hooks/session-context-nudge.js`
- Verify: `hooks/session-context-guard.js`

**Interfaces:**
- Consumes: all changes from Tasks 1–3.
- Produces: evidence that removal is complete and the unrelated session-context pipeline still works.

- [ ] **Step 1: Run the existing stop-guard test**

Run: `node hooks/session-context-guard.test.js`

Expected: the existing guard assertions pass.

- [ ] **Step 2: Smoke-test the stale phase nudge without `-hd`**

Run:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/.claude/session-context"
printf 'Plan: stale phase\n' > "$tmp/.claude/session-context/s"
touch -t 202001010000 "$tmp/.claude/session-context/s"
printf '{"prompt":"hello","session_id":"s"}' | HOME="$tmp" node hooks/session-context-nudge.js
rm -rf "$tmp"
```

Expected: output contains `session-context (status line) still shows "Plan: stale phase"`; it does not contain health acknowledgement output or invoke the renderer's removed `done` path.

- [ ] **Step 3: Run the final statusline test again**

Run: `node bin/claude-code-status.test.js`

Expected: `ALL TESTS PASSED`.
