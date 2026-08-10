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
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const [line1, line2] = plain.split('\n');

  assert.ok(line1.includes('M'), `model missing: ${JSON.stringify(plain)}`);
  assert.ok(line2.includes('ctx '), `context segment missing: ${JSON.stringify(plain)}`);
  assert.ok(line2.includes('63%'), `context percentage missing: ${JSON.stringify(plain)}`);
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
