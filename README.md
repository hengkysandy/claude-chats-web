# claude-chats-web

Lightweight **local** web UI to browse all your `~/claude-chats` sessions and run
any of them in the browser. It does **not** reimplement Claude — it attaches the
real `claude` CLI (via your existing `chat` shell function) to a pseudo-terminal
and streams it to an xterm.js terminal in the browser. Behaviour is identical to
the CLI: same rendering, same `--continue`, same workspace/template/archive logic.

## Requirements (install these first)
- **macOS or Linux with `zsh`** (macOS's default shell).
- **Node.js 18+** — macOS: `brew install node`.
- **The `claude` CLI, installed and signed in to your OWN account** —
  see https://claude.com/claude-code. Verify with `claude --version`, then run
  `claude` once and log in. Auth is per-person; nothing about it is shared here.
- Optional: **ripgrep** (`brew install ripgrep`) for faster `chatfind`.

Everything else — the `chat` / `chats` / `chatweb` commands and the new-session
template — is bundled in [`shell/`](shell/), so there's no prior shell config to
copy from anyone. (The server starts each session with `zsh -ic 'chat "$1"'`,
reusing the bundled `chat` function — it all ships in this repo.)

## Setup (new machine / coworker)
```bash
# 1. clone
git clone https://github.com/hengkysandy/claude-chats-web.git ~/claude-chats-web
cd ~/claude-chats-web

# 2. install: npm deps + adds the shell commands to your ~/.zshrc (idempotent)
./install.sh

# 3. reload your shell
source ~/.zshrc          # or just open a new terminal window
```
Then use it:
```bash
chatweb                  # open the web UI (prints a 127.0.0.1 URL with a token)
chat <name>              # …or the plain terminal, identical to the CLI
chathelp                 # list every command
```

Prefer not to run `install.sh`? Do it by hand — add this one line to your `~/.zshrc`
and reload (after `npm install` in the repo):
```bash
source "$HOME/claude-chats-web/shell/claude-chats.zsh"
```

Your chats live under `~/claude-chats/<name>/` on your own machine — private to you.

## Run
```
chatweb              # from anywhere (zsh function), or:
cd ~/claude-chats-web && npm start
```
It prints a `http://127.0.0.1:8790/?token=…` URL and opens it. `Ctrl-C` to stop.

- **New chat:** type a name, hit *start* → creates the workspace and launches Claude.
- **Existing chat:** click it → resumes with `claude -c`.
- **Archived chats** are listed (badge); opening one auto-restores it, same as the CLI.

### Split panes
The `1 2 3 4` buttons in the header split the terminal area so you can watch several
sessions at once:

| | layout |
|---|---|
| **1** | one session, full width (default) |
| **2** | left \| right |
| **3** | left \| right on top, one full-width below |
| **4** | 2×2 grid |

Click a pane to focus it — the next chat you open from the tab bar takes *that* pane.
Sessions not currently on screen keep running; they're just hidden, so nothing is lost
by switching layouts. Each pane gets its own `cols`/`rows` and resizes its PTY
independently.

Your open tabs and layout are remembered, so a browser reload puts you back where you
were. Only sessions the server still reports as **live** are reopened — otherwise a
refresh would silently spawn fresh Claude processes for chats that had already exited.

### Keyboard shortcuts
⌘ on macOS, Ctrl elsewhere. The terminal never uses these, so nothing is shadowed.

| | |
|---|---|
| `⌘1` … `⌘4` | switch layout |
| `⌘0` | back to the chat list |
| `⌘⇧]` / `⌘⇧[` | cycle focus between panes (arrows work too) |
| `⌘F` | find in the focused session (then `↑`/`↓` to step) |

(`⌘W` is deliberately absent — browsers don't let a page override closing the tab.)

### Knowing which session wants you
Running four sessions is only useful if you can tell which one finished. A session you
aren't looking at raises a flag, and it clears the moment you focus or type into it.

The status dot does double duty — **green means running, red means it wants you**:

- **Tab** — red pulsing dot with a glow, red text and border.
- **Pane** — red border and red label, so it's obvious in a 4-up grid.
- **Browser tab** — the page title becomes `(2) ● claude-chats` and a red dot is drawn
  onto the favicon. This is the one that matters when chatweb isn't the window you're
  looking at; the favicon is generated on a canvas from the existing icon, so there's
  no second image to ship.

Two signals feed this, because neither is reliable alone:
- **BEL (`\x07`)** — what a TUI emits to demand attention. Unambiguous, but not every
  program sends it.
- **Idle** — output ran and then stopped for `CHATWEB_ATTN_IDLE_MS` (default 6000)
  while you haven't typed since. That's the shape of *"it finished and is waiting"*.
  Raise it if a long tool call gets mistaken for being done.

Optional extras, both off until you turn them on:
- **🔔 in the header** toggles a short chime (synthesised with Web Audio — no audio
  file is shipped or fetched). Persists across reloads.
- **Desktop notifications** are requested the first time you enable sound, and only
  fire while the browser tab is in the background — a banner for a window you're
  already staring at is noise. Clicking one focuses that session.

### Find in session (⌘F / Ctrl-F)
Browser find can't see terminal output, so the UI drives xterm's search addon instead.
`⌘F` (macOS) or `Ctrl-F` (Linux/Windows) opens a find bar in the focused pane —
`Ctrl-Shift-F` works everywhere as a fallback. Every match is highlighted, the active
one is picked out in orange, and an `n/total` counter tracks where you are.

| | |
|---|---|
| `Enter` / `↓` | next match |
| `Shift-Enter` / `↑` | previous match |
| `Aa` | toggle case sensitivity |
| `Esc` | close |

Stepping scrolls the terminal to each match, including matches up in the scrollback —
you don't have to hunt for the highlight.

> On macOS the shortcut is ⌘F rather than Ctrl-F on purpose: Ctrl-F is *forward-char*
> in the prompt's readline, and hijacking it would break cursor movement.

### Dropping files and folders
Drag a file **or folder** from Finder onto a session and its real path is typed in,
exactly like a drag into a real terminal.

The browser deliberately never exposes a dragged item's true path, so the server finds
it: it looks up the basename (Spotlight on macOS, `find` elsewhere, scoped to `$HOME`
and `/Volumes`) and then verifies each candidate against a signature the browser *can*
see — child names for a folder, size + mtime for a file. One verified match is used
directly; several offer a picker; none falls back to uploading the bytes.

- **Images / clipboard paste (⌘V)** have no path to find, so they still upload by
  value: the bytes go over the socket, the server writes a temp file under
  `~/claude-chats-web/.uploads/` (pruned after 24h, outside chat workspaces so backups
  stay clean) and types that path in. Claude renders it as `[Image #N]`. 20 MB cap.
- Resolving a path is better than uploading a copy — Claude then reads the **live**
  file rather than a snapshot taken at drop time.

## Session persistence (survives disconnects)
A session's Claude process is **decoupled from the browser connection**, so it keeps
running when the socket drops. This makes it safe to run a session all day:
- **Laptop sleep / lid close, idle, wifi blips** → the socket drops but Claude keeps
  running; the browser **auto-reconnects** (1→5s backoff) and replays the current
  screen. A WebSocket heartbeat (25s ping/pong) also prevents idle drops.
- A session ends only when: **you close its tab with ×** (sends a kill), **Claude
  itself exits**, or **you stop the server** (`Ctrl-C`).
- Closing the whole browser tab/window does NOT kill the session — reopen the chat
  and you reattach to the still-running session.
- `CHATWEB_DETACH_GRACE_MS` (default `0` = never) — set to N ms to auto-reap a
  session left with no client attached that long, to reclaim RAM.

Caveat: because closing a tab no longer kills Claude, use **×** (or stop the server)
to actually free a session's memory.

## Security
The terminal runs an agent with `--dangerously-skip-permissions` — anyone who can
drive `/pty` gets a shell as you. Controls, in layers:
- Binds to **127.0.0.1 only** — never a network interface.
- Every page/API/WebSocket is gated by a **per-start random token** (ephemeral —
  dies when you stop the server).
- **Origin + Host checks:** rejects any request whose Origin/Host isn't our own
  loopback endpoint → defeats DNS-rebinding and cross-origin driving from a
  malicious web page, even if the token leaked.
- **Strict CSP** + `Referrer-Policy: no-referrer` + `X-Frame-Options: DENY` on the
  page: same-origin resources only, no external loads/exfiltration, no token leak
  via Referer, no framing.
- Don't port-forward it or bind it to a public interface.

## Config (env vars)
- `CHATWEB_PORT`  — default `8790`
- `CHATWEB_TOKEN` — fixed token instead of random (handy for bookmarks)
- `CHATWEB_NO_OPEN=1` — don't auto-open the browser
- `CHATWEB_ATTN_IDLE_MS` — how long output must be quiet before a session is treated
  as waiting for you (default `6000`)
- `CHATWEB_CHATS_ROOT` — where chats live (default `~/claude-chats`)

## Tests
```bash
npm test        # node --test, no test framework dependency
npm run check   # syntax-check server.js and public/app.js
```
The suite points `CHATWEB_CHATS_ROOT` at a temp dir, so it never touches your real
chats. `server.js` only binds a port when run directly, so requiring it from a test is
side-effect free.

## Notes
- `node-pty` ships a prebuilt `spawn-helper` that npm extracts without the execute
  bit (causes `posix_spawnp failed`). The `postinstall` script re-adds `+x`; if you
  ever reinstall and hit that error, run `npm run postinstall`.
- The PTY always runs **zsh**, even if your login shell is bash or fish — `chat` is a
  zsh function, so anything else would fail with `chat: command not found`.
- Chat search (the box on the home screen) indexes `*.md` per chat, skipping
  `CLAUDE.md`, dotdirs, and vendor/build dirs (`node_modules`, `.venv`, `dist`, …).
  Results are cached and invalidated by file mtime/size, so an unchanged workspace is
  never re-read. Notes nested more than 6 levels deep are not indexed.

## Contributing
Bug reports and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The short
version: no new runtime dependencies, no build step, and don't weaken the security
posture above.

## License
[MIT](LICENSE) © Hengky Sandy.
