<!-- generated from content/docs/shortcuts.md - edit the source in kern-web, then run: npm run skill:build -->

# keyboard shortcuts

`mod` is `ctrl` on windows/linux and `cmd` on macos.

## global

| keys | action |
|---|---|
| `mod` `k` | command palette — jump to an instance, run start/stop/restart, open settings |
| `esc` | close the palette / dialog / search |

## server detail

| keys | action |
|---|---|
| `enter` | send the console input line |
| `↑` / `↓` | cycle the local command history in the console input |
| `esc` | close the find/replace overlay or a dialog |

## file editor

| keys | action |
|---|---|
| `mod` `f` | toggle the editor search panel (when the editor isn't focused) |
| `mod` `s` | save the active file |
| `alt` `shift` `f` | format the active file (monaco's formatter, where available) |
| `esc` | close the search panel |

## dialogs

`esc` cancels. `enter` confirms the focused button. destructive dialogs (`stop`, delete, restore) require an explicit click or the confirm key — nothing triggers on a stray keypress.

## cli dashboard

bare `kern-cli` opens a full-screen dashboard with its own keys:

| keys | action |
|---|---|
| `q` / `ctrl+c` | quit |
| `↑` `↓` / `j` `k` | select a server |
| `s` `x` `r` `i` | start / stop / restart / install |
| `b` | back up the selected server |
| `PgUp` `PgDn` | scroll the log pane |
| `Home` / `End` | log top / follow |
| `/` | filter the fleet |
| `:` | command bar (`start all`, `restart minecraft`, `backup <name>`, …) |
| `?` | help |

## docs search

| keys | action |
|---|---|
| `mod` `k` | focus the docs search on this site |
| `↑` `↓` | move through results |
| `enter` | open the highlighted result |
| `esc` | clear the query |

> **note** shortcuts are contextual on purpose — `mod+k` works everywhere, but console keys only fire while the console input is focused, and editor keys only inside the editor.
