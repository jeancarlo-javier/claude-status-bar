#!/usr/bin/env node
// Refresh data/intelligence.json: sync tinkuy (needs AA_API_KEY in its .env), then snapshot the
// Claude per-effort intelligence scores. Only refresh-time depends on tinkuy, never the status bar.
// Usage: node bin/refresh-intelligence.js   (TINKUY_DIR overrides ~/pr26/tinkuy)
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = process.env.TINKUY_DIR || path.join(os.homedir(), 'pr26', 'tinkuy');
execSync('set -a && . ./.env && set +a && bun src/cli.ts sync', { cwd: dir, stdio: 'inherit', shell: '/bin/bash' });
const db = new DatabaseSync(path.join(dir, 'tinkuy.sqlite'), { readOnly: true });

const snap = db.prepare('SELECT id, fetched_at FROM snapshots ORDER BY id DESC LIMIT 1').get();
const rows = db.prepare(`
  SELECT m.family, m.effort, x.value FROM models m
  JOIN metrics x ON x.model_id = m.id AND x.key = 'intelligence' AND x.snapshot_id = ?
  WHERE m.creator = 'Anthropic' AND m.name NOT LIKE '%Non-reasoning%'
  ORDER BY m.family, x.value`).all(snap.id);

// "Claude Opus 5.5" -> "opus-5.5", "Claude 4.5 Haiku" -> "haiku-4.5". Dated or pre-4 families are skipped.
const keyOf = (family) => {
  if (family.includes('(')) return null;
  const tier = family.match(/\b(opus|sonnet|haiku|fable)\b/i)?.[1];
  const ver = family.match(/\b(\d+(?:\.\d+)?)\b/)?.[1];
  return tier && ver && parseFloat(ver) >= 4 ? `${tier.toLowerCase()}-${ver}` : null;
};

const models = {};
for (const r of rows) {
  const key = keyOf(r.family);
  if (!key) continue;
  // Families without effort tiers ("reasoning"/"default") apply to every effort: store as "*".
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(r.effort) ? r.effort : '*';
  (models[key] ??= {})[effort] = Math.round(r.value * 10) / 10;
}

if (!Object.keys(models).length) throw new Error('no Claude scores in tinkuy; keeping the old snapshot');
fs.writeFileSync(path.join(__dirname, '..', 'data', 'intelligence.json'), JSON.stringify({
  source: 'https://artificialanalysis.ai/',
  fetched_at: snap.fetched_at,
  models,
}, null, 1) + '\n');
