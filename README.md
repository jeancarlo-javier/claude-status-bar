# claude-status-bar

Claude Code status line with live **session workflow phase** context. The status line
shows what phase the session is in (`Plan:`, `Exec:`, `Verify:`, …) and its subject,
color-coded, updated by the model itself as the work progresses.

![status line showing the session phase](assets/statusline.png)

```
Fable 5 · high | claude-status-bar | master | +315-50 | $20.86 | 178m | Done: repo rename
```

## Files

| File | Role |
|------|------|
| `hooks/claude-code-zhul-bar.js` | Status line renderer (`statusLine` command). Reads `~/.claude/session-context/<session_id>`, parses `Phase: subject`, renders it color-coded. |
| `hooks/session-context-nudge.js` | `UserPromptSubmit` hook. Silent while the phase file is fresh (<10 min); injects a short reminder when it's stale or missing. |
| `hooks/session-context-guard.js` | `Stop` hook. Blocks turn completion (max once per session) if the phase file was never written — the deterministic enforcement layer. |
| `docs/global-claude-rule.md` | The global CLAUDE.md rule that teaches the model the format and when to write. |

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
| `Needs-Review:` | 226 bright yellow | **waiting on the user** |

Subject text renders in light blue (117); lines truncate at 48 chars.

## Wiring (per Claude config)

Point the settings at this folder (symlinks also exist at the old `~/.claude/hooks/` paths
for backwards compat):

```jsonc
// statusLine
"statusLine": { "type": "command", "command": "node \"~/pr26/claude-status-bar/hooks/claude-code-zhul-bar.js\"", "refreshInterval": 5 }
// hooks
"Stop":             [{ "hooks": [{ "type": "command", "command": "node \"~/pr26/claude-status-bar/hooks/session-context-guard.js\"", "timeout": 5 }] }],
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"~/pr26/claude-status-bar/hooks/session-context-nudge.js\"", "timeout": 5 }] }]
```

Currently wired: `~/.claude/settings.json` (covers `claude` and `cs`; `cm` inherits it —
its `minimax.settings.json` overlay defines no statusLine/hooks) and
`~/.claude-eventrid/settings.json` (`ce`).

## Token budget (measured)

| Piece | Cost |
|-------|------|
| CLAUDE.md rule | ~360 tokens, fixed per session |
| Nudge, file fresh | 0 |
| Nudge, stale/missing | ~62–76 tokens per event (quoted line capped at 120 chars) |
| Guard block | ~100 tokens, at most once per session |
| Renderer + echo writes | 0 (outside model context) |

Typical session: 300–800 tokens total.

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
