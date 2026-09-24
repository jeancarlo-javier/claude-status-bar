# Agent panel shows xhigh for subagents the parent said run at medium

`log` · learning · claude-code

## Occurrences

- 2026-09-24 — segmenta session `e01a263b…`: three `general-purpose` + `model: opus` eval runners
  showed `Opus 5.5 [xhigh·58]`; the parent had told the user "Opus 5.5's own default effort is medium".

## Observation

The panel was right. A subagent runs at the parent session's effort — not the model's API default,
not `modelSettings` — and the `Agent` tool has no `effort` param; only an agent type's frontmatter
`effort:` changes it. Separately, the `sonnet` alias inherits the parent's exact Sonnet version
(Sonnet 4.6 parent → Sonnet 4.6 subagent). Workaround shipped outside this repo:
`~/pr26/workflows/subagent-effort-patch` (effort-pinned agent types + self-removing CLAUDE.md rule).

## Repro

`claude -p --model sonnet --effort low` spawning `general-purpose` with `model: opus` → the subagent
transcript's assistant messages carry `"effort":"low"`; with `--effort xhigh` → `"xhigh"`. Claude Code 2.1.282.

## Evidence

- `~/.claude/projects/-Users-jeancarlojavier-pr26-segmenta/e01a263b-25c0-48c1-90cd-c733368dfd69/subagents/agent-a17aa77eec51b68f3.jsonl` — `"effort":"xhigh","perTurnEffort":"xhigh"`
- `~/.claude/session-context/e01a263b-….<agent_id>.agent.json` — `{"effort":"xhigh"}` from `hooks/subagent-effort.js`
- `~/pr26/workflows/subagent-effort-patch/README.md` — full test matrix
