# Warp tab color, set programmatically

`research` · 2026-10-12 · Warp Stable v0.2026.10.07 (macOS) · Claude Code + `claude-code-warp` 2.1.0

## Question

Can a Claude Code session change its own Warp tab's **color** without clicks, the way
`bin/claude-code-status.js` already sets the tab **title** (OSC 0 written to the claude process's tty)?

## Answer

Yes, but indirectly. Warp Stable has no tab-color API and no tab-color escape sequence. Its
**directory tab colors** setting colors a tab by its working directory, though, and Warp takes that
directory from **OSC 7**, which any program in the tab can emit. So: map one dedicated folder per color
once, then point the tab at the folder of the color you want.

1. One-time map in `~/.warp/settings.toml` (hot-reloaded; paths absolute, folders created with `mkdir -p`):

   ```toml
   [appearance.tabs.directory_tab_colors]
   "/Users/<you>/.warp/tab-colors/red" = { color = "red" }
   "/Users/<you>/.warp/tab-colors/green" = { color = "green" }
   "/Users/<you>/.warp/tab-colors/yellow" = { color = "yellow" }
   "/Users/<you>/.warp/tab-colors/blue" = { color = "blue" }
   "/Users/<you>/.warp/tab-colors/magenta" = { color = "magenta" }
   "/Users/<you>/.warp/tab-colors/cyan" = { color = "cyan" }
   ```

2. Per change, from inside the tab:

   ```sh
   printf '\e]7;file://%s%s\a' "$(hostname)" ~/.warp/tab-colors/yellow > /dev/tty  # color it
   printf '\e]7;file://%s%s\a' "$(hostname)" "$PWD" > /dev/tty                     # back to the real cwd = no color
   ```

   From a Claude Code hook, either print `{"terminalSequence": "<seq>"}`, which needs Claude Code
   ≥ 2.1.141 (`claude-code-warp` emits its OSC 777 this way), or write to the claude process's tty the way the title code does.

## Verified

- A fresh tab opened with `open "warp://action/new_tab?path=$HOME"`, then OSC 7 written to its tty:
  none → magenta → green → none. A tab-strip screenshot after each step showed only that tab changing.
- Warp's restore DB (`terminal_panes.cwd`) showed the OSC 7 path within seconds. `tabs.color` stayed
  NULL: a directory color is derived, not stored.
- From this session's own tab (the claude process's tty), all six colors plus `white`, measured on the
  tab strip (background tab, theme grey `#494949`): red `#594642`, yellow `#5b5444`, magenta `#554852`, blue
  `#474f5a` read clearly; green `#48534b` is subtle; cyan `#515352` is barely distinguishable from grey, so it is
  left unused. `white` renders as a clearly lighter tab.
- New tabs open in the color folder (see *The new-tab folder problem*): a Cmd+T shell from a colored tab
  had its cwd at the mirror path (`lsof -a -d cwd`), and with the zsh line below a tab opened there ended up
  in the real folder, uncolored.

## Rules learned

- Each tab holds `SelectedTabColor { Unset, Cleared, Color(ansi) }`. Only `Unset` tabs show directory colors.
- A color picked from the right-click menu stores `Color(x)` and **beats** directory colors.
- The menu's ⊘ ("no color") stores `Cleared`. That **pins** the tab colorless, even after OSC 7 moves it to a
  mapped folder. The binary has a `ResetColor` action that probably un-pins it; this is unverified.
- The directory map **matches by prefix**: mapping `~` colored every tab under home. That's why the color
  folders are dedicated, and why any **real** folder under one is colored too (a folder named `a%2Fb` included).
- Warp **resolves symlinks** before matching: OSC 7 to a symlink inside `yellow/` that points at the project
  left the tab grey.
- New sessions start where the active tab last was: `session.working_directory_config` defaults to
  `previous_dir` for `new_tab`, `new_window` and `split_pane` (alternatives: `home_dir`, a custom dir).
- Values are the 8 ANSI names (`black`…`white`), rendered with the active theme's colors. The menu offers 6 plus ⊘.
- Settings changes apply live, with no cwd change needed. A menu click persists only to SQLite.

## Caveats

- OSC 7 changes the directory Warp *thinks* the tab is in. New tabs and splits opened from that tab start in
  the color folder, and session restore saves it. Solved below.
- The shell's next prompt re-reports the real cwd, which drops the color. So the color holds while a
  long-running program (Claude Code) owns the tab, and clears itself when it exits. That fits session state.
- Claude Code's Bash tool sandbox can write only to its own session's tty. Writing to another tab's
  tty needs the sandbox off.
- Anything run inside a Claude session that walks up to the claude process's tty writes to **that tab**. The
  statusline's own test suite did, run by subagents: it pointed the tab at a temp folder, the color vanished,
  and the write-on-change cache never re-sent it. Hence `CCS_TTY` (tests write to a file) and the
  once-a-minute re-send of an active color.
- A phase label is written once per turn, so it goes stale both ways: `Exec` after the turn ended, or a
  leftover `Needs-Review` while the session is working again. The label alone cannot color the tab.

## The new-tab folder problem

A tab opened from a colored tab (Cmd+T, a split, session restore) started **in** `~/.warp/tab-colors/<color>`:
colored, and in the wrong folder, because the real cwd was lost.

| Try | Colored? | New tab lands in |
|---|---|---|
| Leaf color folder (first version) | yes | the color folder, real cwd lost |
| Symlink inside `yellow/` to the real folder | **no**, Warp resolves it first | — |
| Real empty mirror `yellow/<real cwd>`, e.g. `yellow/Users/me/proj` | yes | the mirror, real path kept |
| Warp setting `working_directory_config` → `home_dir` | — | home, for every tab, always |

The mirror plus one line in `~/.zshrc` that leaves it:

```zsh
[[ $PWD == $HOME/.warp/tab-colors/*/* ]] && { cd "/${PWD#$HOME/.warp/tab-colors/*/}" 2>/dev/null || cd }
```

The new shell starts in the mirror, `cd`s to the real folder (home if it is gone), and its first prompt reports
the real cwd, which clears the color. Session restore after a crash or quit while colored is covered the same way.

## Dead ends

| Route | Why not |
|---|---|
| `warpctrl` (Warp Control: hidden mode of the app binary, has tab color set/clear + `--tab-title` targeting) | Gated by Settings → Scripting, which Stable doesn't ship: settings search for "Warp Control" finds nothing, there's no wrapper in `Resources/bin`, and argv0/symlink dispatch falls through to the `oz` parser. Revisit when it lands; it avoids OSC 7's cwd side effect. |
| `workspace:cycle_active_tab_color` keybinding | `keybindings.yaml` loads only at app launch (bundled `change-keybinding` skill), and it acts on the active tab only. |
| Tab-color escape sequence (iTerm2 OSC 6, OSC 1337 `SetColors`) | Not handled: there are no parser strings for it in the binary. |
| `/set-tab-color` slash command | Warp input only, current tab. Unreachable while a TUI owns the tab. |
| Tab Configs `color =` / `warp://tab_config/<name>` | New tabs only. |
| Editing `tabs.color` in the restore DB | Snapshot, read at launch, overwritten on save. |
| `claude-code-warp` protocol (OSC 777 `notify`, JSON `{v, agent, event, session_id, cwd, project}`) | Status events only, no color. |

## How it was found

- `strings` on `/Applications/Warp.app/Contents/MacOS/stable` surfaced `warpctrl`, `/set-tab-color`,
  `DirectoryTabColors`, and `SelectedTabColor`'s variants.
- `stable dump-settings-schema` gave the schema for `appearance.tabs.directory_tab_colors`:
  `{ "<dir>": { color } | "suppressed" | "unassigned" }`.
- Bundled docs: `Contents/Resources/bundled/skills/{warpctrl,change-keybinding}/SKILL.md`.
- A before/after diff of a menu click showed it changes only
  `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite`.
- Mapping a session to its tab: `terminal_panes.uuid` (hex = `$WARP_TERMINAL_SESSION_UUID`) →
  `pane_nodes.id` → `pane_nodes.tab_id` → `tabs`.
- Checks used `deskctl shot --window <id>` plus `zoom IMG 0 0 1 0.045` (tab strip only). The window title is the
  active tab's.
- `open "warp://settings?q=<query>"` searches Settings without a click.

## Built here

`bin/claude-code-status.js`, next to the tab title (commit `34776e9`, then follow-ups). It shares one tty
lookup (`toTty`) with the title and writes `\x1b]7;file://<host><home>/.warp/tab-colors/<color><cwd>\x07`, path encoded per
segment so `#` and `?` survive. The cache is `~/.claude/session-context/<session>.tabcolor`, and nothing is sent
until a color is involved or when the color folder is missing (no setup, no escapes).

What the session is doing decides the color. The transcript gives the turn state: a `system`/`turn_duration`
record closes every finished turn, and a `[Request interrupted by user` message marks an Esc.

| Tab | State |
|---|---|
| blue | a turn is running (any label; the default for unknown ones) |
| magenta | a turn is running on `Research` / `Explore` / `Analysis` |
| white | turn over, on a working label |
| yellow | turn over, on `Needs-Review` (and Spanish forms), `Q&A`, `Chat` |
| red | turn over, on `Blocked` |
| green | turn over, on `Done` |

Setup: the folders (`mkdir -p ~/.warp/tab-colors/{red,green,yellow,blue,magenta,white}`), their map in
`settings.toml`, and the zsh line above. All of it is in the README.

Still open:
- **Pinned tabs:** tabs pinned `Cleared` or `Color(x)` ignore this.
- **Waiting mid-turn:** Claude Code does not run the statusline while a dialog is open (permission prompt,
  AskUserQuestion; probed in a real pty, 15 s gaps with no render), so no statusline signal can show it.
  `hooks/tab-wait.js` on `PermissionRequest` (fires for every dialog, bypass mode included) turns the tab
  yellow; the first render after the answer repaints the real state. Reaches users with the next release.

Turn-state signals, measured over the local transcripts:
- `turn_duration` closes 2,064 of 2,138 CLI turns; the rest are Esc'd, steered or killed. A Stop hook that
  blocks writes none, so there is no white↔blue flicker.
- `turn_duration` also carries `pendingBackgroundAgentCount` and `pendingWorkflowCount`: turn over with
  background work pending reads as working. Background shells are not counted there; they are tracked from
  launch to `<task-notification>`, servers excluded by wording, capped at 15 min.
- Only a user record whose first text starts with `[Request interrupted by user` is an Esc (28 of 115
  sightings were quotes). `<command-name>` / `<local-command-*>` / `<bash-*>` records and compaction summaries
  never reach the model, so they change nothing.
- `CLAUDE_PID` stamps the state, so a resumed or cleared session repaints at once instead of inheriting the
  dead process's state.

## Sources

- [Warp Tab Configs](https://docs.warp.dev/terminal/windows/tab-configs.md)
- [Warp URI scheme](https://docs.warp.dev/terminal/more-features/uri-scheme.md)
- [warpdotdev/warp #6897: tab name/color from CLI](https://upd.dev/warpdotdev/warp/issues/6897)
- [Customizing Warp](https://docs.warp.dev/getting-started/customizing-warp)
