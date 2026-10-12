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

## Rules learned

- Each tab holds `SelectedTabColor { Unset, Cleared, Color(ansi) }`. Only `Unset` tabs show directory colors.
- A color picked from the right-click menu stores `Color(x)` and **beats** directory colors.
- The menu's ⊘ ("no color") stores `Cleared`. That **pins** the tab colorless, even after OSC 7 moves it to a
  mapped folder. The binary has a `ResetColor` action that probably un-pins it; this is unverified.
- The directory map **matches by prefix**: mapping `~` colored every tab under home. That's why the color
  folders are dedicated leaves.
- Values are the 8 ANSI names (`black`…`white`), rendered with the active theme's colors. The menu offers 6 plus ⊘.
- Settings changes apply live, with no cwd change needed. A menu click persists only to SQLite.

## Caveats

- OSC 7 changes the directory Warp *thinks* the tab is in. New tabs and splits opened from that tab start in
  the color folder, and session restore saves it.
- The shell's next prompt re-reports the real cwd, which drops the color. So the color holds while a
  long-running program (Claude Code) owns the tab, and clears itself when it exits. That fits session state.
- Claude Code's Bash tool sandbox can write only to its own session's tty. Writing to another tab's
  tty needs the sandbox off.

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

## Integration point here (not built)

`bin/claude-code-status.js` (~L615–645) already resolves the claude process's tty and writes OSC 0 on change,
caching the last title in `~/.claude/session-context/<session>.title`. Tab color would go in the same spot:
map phase → color (for example `needs-review` → yellow, `debug` → red, `verify` → green), write
`\x1b]7;file://<host><home>/.warp/tab-colors/<color>\x07`, and cache it the same way.

Open points:
- **Setup:** the `settings.toml` map is a one-time install step.
- **Pinned tabs:** tabs pinned `Cleared` or `Color(x)` ignore this.
- **Clearing:** the cwd side effect is acceptable, or the color should be cleared on Stop.

## Sources

- [Warp Tab Configs](https://docs.warp.dev/terminal/windows/tab-configs.md)
- [Warp URI scheme](https://docs.warp.dev/terminal/more-features/uri-scheme.md)
- [warpdotdev/warp #6897: tab name/color from CLI](https://upd.dev/warpdotdev/warp/issues/6897)
- [Customizing Warp](https://docs.warp.dev/getting-started/customizing-warp)
