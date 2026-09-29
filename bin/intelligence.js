// Per-effort intelligence score for a Claude model, from data/intelligence.json (a tinkuy snapshot
// refreshed by bin/refresh-intelligence.js): exact effort, else the model-wide "*", else the max
// score as an upper bound. Claude models only; anything else has no score.
const fs = require('fs');
const path = require('path');

// effort: low | med(ium) | high | xhigh | max
module.exports = function scoreFor(effort, ...names) {
  if (effort === 'med') effort = 'medium';
  let models;
  try { models = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'intelligence.json'), 'utf8')).models; } catch { return null; }
  // "claude-opus-5-5" / "Claude Opus 5.5" / "claude-haiku-4-5-20251001" -> opus-5.5 / haiku-4.5
  const hit = names.map(v => (v || '').match(/(opus|sonnet|haiku|fable)[- ](\d+)(?:[-.](\d{1,2})(?!\d))?/i)).find(Boolean);
  const e = hit && models[`${hit[1].toLowerCase()}-${hit[2]}${hit[3] ? '.' + hit[3] : ''}`];
  if (!e) return null;
  const exact = e[effort] ?? e['*'];
  return exact != null ? { score: exact } : e.max != null ? { score: e.max, approx: true } : null;
};
