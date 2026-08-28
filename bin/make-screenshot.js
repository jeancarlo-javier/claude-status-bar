#!/usr/bin/env node
// Regenerates assets/statusline.svg from the real renderer, so the README picture can never
// drift from what the status line actually prints.
//
//   node bin/make-screenshot.js            -> assets/statusline.svg
//   node bin/make-screenshot.js --png      -> also assets/statusline.png, if a converter exists
//
// The payload below is the one Claude Code would hand the renderer on stdin. Keep it free of
// anything time-dependent (effort "max" cycles colours off Date.now()) or the output stops
// being reproducible.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const out = path.join(ROOT, 'assets', 'statusline.svg');

const PAYLOAD = {
  model: { display_name: 'Opus 5 (1M context)' },
  effort: 'xhigh',
  session_id: 'screenshot',
  workspace: { current_dir: null },   // filled in with a throwaway demo project below
  context_window: { remaining_percentage: 62 },
  cost: { total_cost_usd: 3.12, total_duration_ms: 840000, total_api_duration_ms: 120000 },
  rate_limits: {
    five_hour: { used_percentage: 35, resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 },
    seven_day: { used_percentage: 71, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 },
  },
};
const PHASE = 'Exec: Compact the status line';
const CHANGE = 'add-compact-gauges';
const BRANCH = 'main';
const TASKS = '- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n';

// ---- run the real renderer against a throwaway project ----------------------------------
// The project name and branch are read off the directory and its git repo, so the demo project
// gets a real name (a random mkdtemp suffix would both look wrong and break reproducibility)
// and one empty commit, which is the least it takes for `git rev-parse HEAD` to name a branch.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-shot-'));
const demo = path.join(tmp, 'claude-status-bar');
const phaseFile = path.join(os.homedir(), '.claude', 'session-context', PAYLOAD.session_id);
let ansi;
try {
  fs.mkdirSync(path.join(demo, 'openspec', 'changes', CHANGE), { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', demo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', BRANCH);
  git('-c', 'user.email=demo@example.com', '-c', 'user.name=demo', 'commit', '-q', '--allow-empty', '-m', 'demo');
  fs.writeFileSync(path.join(demo, 'openspec', 'changes', CHANGE, 'tasks.md'), TASKS);
  fs.mkdirSync(path.dirname(phaseFile), { recursive: true });
  fs.writeFileSync(phaseFile, PHASE);
  PAYLOAD.workspace.current_dir = demo;
  ansi = execFileSync(process.execPath, [path.join(__dirname, 'claude-code-status.js')], {
    input: JSON.stringify(PAYLOAD), encoding: 'utf8',
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(phaseFile, { force: true });
}

// ---- ANSI -> coloured runs --------------------------------------------------------------
const xterm = (n) => {
  if (n < 16) return ['#000000','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5',
                      '#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff'][n];
  if (n < 232) { const c = n - 16, l = [0,95,135,175,215,255];
    return `#${[l[Math.floor(c/36)], l[Math.floor(c/6)%6], l[c%6]].map(v=>v.toString(16).padStart(2,'0')).join('')}`; }
  const g = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
  return `#${g}${g}${g}`;
};
const BASIC = { 30:'#666666', 31:'#f14c4c', 32:'#23d18b', 33:'#f5f543', 34:'#3b8eea', 35:'#d670d6', 36:'#29b8db', 37:'#e5e5e5' };
const FG = '#d8d8d8';

const parse = (line) => {
  const runs = [];
  let fill = FG, bold = false, i = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
    if (sgr) {
      const p = sgr[1].split(';').map(Number);
      for (let k = 0; k < p.length; k++) {
        if (p[k] === 0) { fill = FG; bold = false; }
        else if (p[k] === 1) bold = true;
        else if (p[k] === 38 && p[k+1] === 5) { fill = xterm(p[k+2]); k += 2; }
        else if (p[k] === 38 && p[k+1] === 2) { fill = `rgb(${p[k+2]},${p[k+3]},${p[k+4]})`; k += 4; }
        else if (BASIC[p[k]]) fill = BASIC[p[k]];
      }
      continue;
    }
    if (part) { runs.push({ text: part, fill, bold, col: i }); i += [...part].length; }
  }
  return { runs, width: i };
};

// ---- SVG --------------------------------------------------------------------------------
// The panel is translucent over a heavily blurred colour field, the way the original screenshot
// sat on a desktop wallpaper. SVG has no backdrop-filter, but blurring the backdrop itself and
// laying a semi-transparent panel on top gets the same glass read.
const CH = 8.4, LH = 26, PAD = 22, FS = 14, M = 34;
const lines = ansi.replace(/\n$/, '').split('\n').map(parse);
const PW = Math.round(PAD * 2 + Math.max(...lines.map(l => l.width)) * CH);
const PH = PAD * 2 + lines.length * LH;
const W = PW + M * 2, H = PH + M * 2;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const blob = (cx, cy, rx, ry, fill, o) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" opacity="${o}"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FS}">
  <defs>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.round(H / 3)}"/></filter>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="16"/></clipPath>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="#0b0a12"/>
    <g filter="url(#blur)">
${[blob(W * 0.18, H * 0.22, W * 0.26, H * 0.7, '#3b2a7a', 0.95),
   blob(W * 0.46, H * 0.78, W * 0.3, H * 0.8, '#7b2f6b', 0.8),
   blob(W * 0.74, H * 0.18, W * 0.26, H * 0.75, '#2a4a8c', 0.85),
   blob(W * 0.93, H * 0.7, W * 0.2, H * 0.7, '#a33f7d', 0.6)].map(b => '      ' + b).join('\n')}
    </g>
    <rect x="${M}" y="${M}" width="${PW}" height="${PH}" rx="11" fill="#0d0e15" fill-opacity="0.62"/>
    <rect x="${M + 0.5}" y="${M + 0.5}" width="${PW - 1}" height="${PH - 1}" rx="10.5" fill="none" stroke="url(#edge)"/>
  </g>
${lines.map((l, r) => `  <text x="${M + PAD}" y="${M + PAD + r * LH + FS}" xml:space="preserve">` +
  l.runs.map(run => `<tspan x="${(M + PAD + run.col * CH).toFixed(1)}" fill="${run.fill}"${run.bold ? ' font-weight="700"' : ''}>${esc(run.text)}</tspan>`).join('') +
  `</text>`).join('\n')}
</svg>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log(`${path.relative(ROOT, out)}  ${W}x${H}`);

// ---- optional PNG, only if the machine already has something that can do it ---------------
if (process.argv.includes('--png')) {
  const png = out.replace(/\.svg$/, '.png');
  // ImageMagick delegates SVG to rsvg-convert and cannot do it alone (it fails on fonts), so the
  // fallback is a headless browser, which every machine with Chrome already has.
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                  '/Applications/Chromium.app/Contents/MacOS/Chromium',
                  '/Applications/Arc.app/Contents/MacOS/Arc'].find(b => fs.existsSync(b));
  const tries = [
    ['rsvg-convert', ['-w', String(W * 2), '-o', png, out]],
    chrome && [chrome, ['--headless', '--disable-gpu', '--force-device-scale-factor=2',
                        `--window-size=${W},${H}`, '--default-background-color=00000000',
                        `--screenshot=${png}`, `file://${out}`]],
  ].filter(Boolean);
  fs.rmSync(png, { force: true });
  const ok = tries.some(([bin, args]) => {
    if (bin.startsWith('/') ? !fs.existsSync(bin) : spawnSync('command', ['-v', bin], { shell: true }).status !== 0) return false;
    spawnSync(bin, args, { stdio: 'ignore' });
    return fs.existsSync(png);
  });
  console.log(ok ? `${path.relative(ROOT, png)}  ${W * 2}px wide`
    : 'no SVG->PNG converter found (brew install librsvg, or install Chrome) — GitHub renders the SVG fine');
}
