# claude-chats-web

Lightweight **local** web UI to browse all your `~/claude-chats` sessions and run
any of them in the browser. It does **not** reimplement Claude — it attaches the
real `claude` CLI (via your existing `chat` shell function) to a pseudo-terminal
and streams it to an xterm.js terminal in the browser. Behaviour is identical to
the CLI: same rendering, same `--continue`, same workspace/template/archive logic.

## Requirements (important — not fully standalone)
This app **reuses your existing shell setup** rather than reimplementing chat:
- The [`claude` CLI](https://claude.com/claude-code) installed and on `PATH`.
- A **`chat` shell function** in your `~/.zshrc` that starts/resumes a named
  workspace under `~/claude-chats/<name>/` (from the "founder-config" setup). The
  server literally runs `zsh -ic 'chat "$1"'` per session, so without that function
  it won't launch sessions. Adapt `startSession()` in `server.js` if your launcher
  differs.
- macOS/Linux with `zsh`. Node 18+.

## Run
```
chatweb              # from anywhere (zsh function), or:
cd ~/claude-chats-web && npm start
```
It prints a `http://127.0.0.1:8790/?token=…` URL and opens it. `Ctrl-C` to stop.

- **New chat:** type a name, hit *start* → creates the workspace and launches Claude.
- **Existing chat:** click it → resumes with `claude -c`.
- **Archived chats** are listed (badge); opening one auto-restores it, same as the CLI.
- **Images:** drag an image onto the terminal, or paste one from the clipboard (⌘V).
  The browser can't see a real file path, so the bytes are sent over the socket, the
  server writes a temp file under `~/claude-chats-web/.uploads/` (pruned after 24h,
  outside chat workspaces so backups stay clean), and types that path in wrapped in
  bracketed-paste — so Claude renders it as `[Image #N]`, same as a CLI drag. 20 MB cap.

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

## Notes
- `node-pty` ships a prebuilt `spawn-helper` that npm extracts without the execute
  bit (causes `posix_spawnp failed`). The `postinstall` script re-adds `+x`; if you
  ever reinstall and hit that error, run `npm run postinstall`.
