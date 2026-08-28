# claude-status-bar

[![release](https://img.shields.io/github/v/release/jeancarlo-javier/claude-status-bar)](https://github.com/jeancarlo-javier/claude-status-bar/releases)
[![license](https://img.shields.io/github/license/jeancarlo-javier/claude-status-bar)](LICENSE)
[![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/jeancarlo-javier-claude-status-bar)](https://www.claudepluginhub.com/plugins/jeancarlo-javier-claude-status-bar?ref=badge)

Two-line Claude Code status line. The headline feature: the session's live **workflow
phase** (`Plan:`, `Exec:`, `Verify:`, …) and its subject, color-coded and rewritten by the
model itself as the work progresses. The rest is the session context you want on screen
anyway.

![status line showing the session phase](assets/statusline.png)

<sub>Regenerate with `node bin/make-screenshot.js --png` — it pipes a fixed payload through the
real renderer, so the picture cannot drift from what the bar prints. Drop `--png` for the SVG
alone, which needs nothing installed.</sub>

## How it works — three layers

1. **Teach** — a rule in `~/.claude/CLAUDE.md` (see `docs/global-claude-rule.md`) defines the
   `Phase: subject` format and requires a rewrite at every phase transition:
   `echo "Exec: subject" > ~/.claude/session-context/$CLAUDE_CODE_SESSION_ID`
2. **Remind** — the nudge hook re-surfaces the rule only when the file is stale (>10 min) or
   missing. Fresh file → zero tokens injected.
3. **Enforce** — the guard blocks the first stop of a session that never wrote the file.
   `stop_hook_active` prevents loops; an existing non-empty file makes it permanently silent.

The store is `~/.claude/session-context/<session_id>` — one plain-text file per session,
shared across all Claude config dirs (the scripts always resolve `~/.claude/` regardless of
`CLAUDE_CONFIG_DIR`).

## Install

```bash
claude plugin marketplace add jeancarlo-javier/claude-status-bar
claude plugin install claude-status-bar@claude-status-bar
```

Then restart Claude Code twice: the first start configures, the second renders.

Installing wires the hooks. A plugin cannot set a `statusLine` or edit your global `CLAUDE.md`
directly, so a `SessionStart` hook does it on first launch — it points `statusLine` at the
renderer in `~/.claude/settings.json` and appends the phase rule to `~/.claude/CLAUDE.md`,
between `claude-status-bar:begin`/`:end` markers. It is silent on every later start.

It never overwrites a status line you already have; if you have one, it says so and leaves it
alone. `/claude-status-bar:init` switches over when you want that. Plugin updates re-point the
path automatically.

To remove: `claude plugin uninstall claude-status-bar@claude-status-bar`, then delete the
`claude-status-bar:begin`/`:end` block from `~/.claude/CLAUDE.md`, and — only if it still points
at `claude-code-status.js` — the `statusLine` key from `~/.claude/settings.json`. Also
`rm ~/.claude/.claude-status-bar-noticed`, the flag that keeps the one-time notice from repeating.

<details>
<summary>Manual install, without the plugin system</summary>

Paste this into Claude Code:

````markdown
Install this status line: https://github.com/jeancarlo-javier/claude-status-bar

Clone it to ~/.claude/claude-status-bar, then wire it in ~/.claude/settings.json:
- statusLine → bin/claude-code-status.js
- Stop hook → hooks/session-context-guard.js
- UserPromptSubmit hook → hooks/session-context-nudge.js

Plus append the rule from docs/global-claude-rule.md to ~/.claude/CLAUDE.md.
Verify it renders, then tell me to restart.
````

</details>

## Files

| File | Role |
|------|------|
| `bin/claude-code-status.js` | Status line renderer (`statusLine` command, not a hook). Reads `~/.claude/session-context/<session_id>`, parses `Phase: subject`, renders it color-coded. |
| `hooks/session-context-nudge.js` | `UserPromptSubmit` hook. Silent while the phase file is fresh (<10 min); injects a short reminder when it's stale or missing. On the missing branch — the first turn of a session — it also deletes phase files older than 30 days. |
| `hooks/session-context-guard.js` | `Stop` hook. Blocks turn completion (max once per turn) if the phase file was never written, still holds the example template, or has not changed in 30 minutes — the deterministic enforcement layer. The block offers `touch` for a line that is still right, so keeping an honest label is cheaper than inventing one. |
| `docs/global-claude-rule.md` | The global CLAUDE.md rule that teaches the model the format and when to write. |
| `.claude-plugin/` | Plugin and marketplace manifests, so the repo installs as a Claude Code plugin. |
| `hooks/hooks.json` | Wires all three hooks automatically when installed as a plugin. |
| `hooks/plugin-setup.js` | `SessionStart` hook. Self-configures the status line and the CLAUDE.md rule on first launch; silent afterwards. |
| `skills/init/SKILL.md` | `/claude-status-bar:init` — repair path, for switching from another status line or restoring a deleted rule. |

## Phases and colors

Phases are **dynamic** — any short English label works; unknown labels render bold grey (250).
Canonical labels are English. Semantic palette (256-color):

| Phase | Color | Meaning |
|-------|-------|---------|
| `Research:` | 176 orchid | thinking |
| `Plan:` | 111 blue | thinking |
| `Review-Plan:` | 141 lavender | checking a plan |
| `Exec:` | 220 gold | working |
| `Q&A:` / `Review:` / `Review-Execution:` | 208 orange | questioning |
| `Verify:` | 80 cyan | checking |
| `Done:` | 114 green | finished |
| `Debug:` / `Fix:` | 203 red | trouble |
| `Focus:` | 213 pink | daily focus |
| `Chat:` | 117 sky | conversation, no task |
| `Docs:` | 109 slate | writing docs |
| `Explore:` / `Analysis:` | 176 orchid | thinking |
| `Critique:` | 208 orange | questioning |
| `Needs-Review:` | 226 bright yellow | **waiting on the user**, drawn as a reverse-video chip |

Only the phase label is colored — the subject renders plain. The subject truncates at 48
chars; branch names and change ids at 32.

### Time in phase

The label carries its age once it has stood for **20 minutes** (`Exec 40m: …`), and dims past
**90 minutes**. Measured over 38 real sessions (median 134 min, 4 phase writes), the label was
more than 15 minutes out of date 57% of the wall clock: a subject survives a whole pipeline, a
phase does not. So the two halves are no longer drawn with equal confidence — and the same
number answers *is it stuck on this?* The subject stays at full brightness; it is the half that holds.

The clock measures time since the label's **text** changed, not the file's mtime. Both hooks tell
the model to `touch` a label that is still correct, so an mtime clock would restart on every
acknowledgement and this segment would never reach its 20-minute floor. The renderer keeps the
earlier of the two under `$TMPDIR`, so a touch confirms the phase without erasing how long it has
run.

## What the two lines show

```
Exec 40m: Compact the status bar | Fable 5 xhigh | claude-status-bar@master | $3.12 | 55m
chg add-compact-gauges 2/4 | ctx ▁ 8% | 5h ▃ 35% | wk ▆ 71% (3d)
```

| Line | Shows |
|------|-------|
| 1 | **phase: subject** first, since it is the thing you actually read, with time-in-phase once the label is 20 min old; then model and reasoning effort, `project@branch` (`↑↓` vs upstream), session cost, elapsed minutes |
| 2 | the OpenSpec change being worked and its task progress, context window used (the same number `/context` reports), 5-hour and weekly rate limits, output tokens per second |

Each meter is one glyph off the `▁▂▃▄▅▆▇█` ramp plus its number, colored together —
green under 40%, yellow, orange, red at 80% (the auto-compact threshold), blinking
red at 95%. A reset countdown only appears once that limit is past 60%, where it
starts to matter.

The `chg` segment tracks `openspec/changes/`: `2/4` is checked tasks, `✓` means every
box is ticked and it is ready to `/opsx:archive`, a lone `·` is a proposal whose
`tasks.md` does not exist yet, and `+3o` counts the other changes left open. Archiving
one drops it on the next render.

Every segment is optional: the renderer only displays a segment when Claude Code
supplies its data (no upstream branch, no `↑↓`; no rate-limit payload, no meters; no
`openspec/` directory, no change). A session that has not written a phase file yet simply
starts line 1 at the model — the Stop hook is what keeps that rare.


## Token budget (measured)

| Piece | Cost |
|-------|------|
| CLAUDE.md rule | ~360 tokens, fixed per session |
| Nudge, file fresh | 0 |
| Nudge, stale/missing | ~62–76 tokens per event (quoted line capped at 120 chars) |
| Guard block | ~100 tokens, at most once per session |
| Renderer + echo writes | 0 (outside model context) |

Typical session: 300–800 tokens total.

## Data and privacy

- **No network, no dependencies.** The three scripts require `fs`, `os`, `path`,
  `child_process` — nothing else. No HTTP, no telemetry, no analytics.
- **Reads:** your phase file (contents and mtime), `openspec/changes/`
  in the current project, your session transcript (output-token counts only, read
  incrementally — see below), and two read-only `git` commands in the current repo.
- **Writes:** two small per-session files under `$TMPDIR`. `ccs-tps-<session>.json` holds the
  running output-token total and the transcript offset already counted, so the renderer reads
  only the bytes appended since the last refresh instead of re-reading a transcript that grows to
  tens of megabytes. `ccs-phase-<session>.json` holds the current phase line and when it first
  appeared, which is what makes time-in-phase survive a `touch`.
- The phase file itself is written by the model's own `echo`, not by this tool.
- **One thing leaves the machine:** when the phase file goes stale, the nudge hook echoes
  up to 120 chars of it back to the model — so the subject reaches the API as part of your
  next prompt, exactly like anything you type.
- **Retention:** the store is one 34-byte file per session, so it grows by roughly 13 files a
  day and nothing else prunes it. The nudge hook deletes files older than **30 days** on the
  first turn of each new session — never the running session's own file, and never anything that
  is not a regular file. Subjects can name projects or clients, so shorten that window in
  `hooks/session-context-nudge.js`, or `rm ~/.claude/session-context/*` whenever you like.

## Verified behavior (2026-07-24)

Tested with crafted-stdin edge cases plus live headless sessions (Haiku) and external CLIs
(omp: MiniMax-M3:low, GPT-5.5:low):

- Guard blocks exactly once; `stop_hook_active` loop protection holds; never interrupts mid-work.
- Small models ignore the buried rule but always comply after the single guard block.
- With the rule salient (short prompt), even `:low` external models transition voluntarily
  (`Plan: → Exec: → Verify: → Done:`) — salience, not model size, is the main variable.
- Hardened: nudge quote capped at 120 chars (context-flood), guard requires non-whitespace
  content (`touch` bypass), renderer strips control chars (ANSI injection), path-traversal
  session ids rejected, accented/unicode labels supported.
