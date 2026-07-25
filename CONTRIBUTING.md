# Contributing

Thanks for taking a look. This is a small, deliberately dependency-light project —
please keep it that way.

## Getting set up

```bash
git clone https://github.com/hengkysandy/claude-chats-web.git ~/claude-chats-web
cd ~/claude-chats-web
./install.sh          # npm deps + wires the shell commands into ~/.zshrc
source ~/.zshrc
chatweb
```

Editing `public/app.js`, `public/index.html`, or the CSS? Just reload the browser —
those files are served fresh on every request. Only `server.js` and `shell/*.zsh`
changes need a restart (`chatweb-stop`, then `chatweb`).

## Before you open a PR

```bash
npm test                       # node --test — must be green
npm run check                  # syntax-checks server.js and public/app.js
zsh -n shell/claude-chats.zsh  # parse-check the shell functions
```

Tests use Node's built-in runner — no test framework dependency. They point
`CHATWEB_CHATS_ROOT` at a temp dir, so they never touch your real `~/claude-chats`.
`server.js` binds a port only when run directly (`require.main === module`), which is
what makes it requirable from a test.

Coverage is server-side today: name validation, archive/restore, notes indexing and
caching, search, the dropped-path resolver, and the request guards. **The browser code
in `public/app.js` has no automated tests** — if you change it, say in the PR how you
verified it by hand.

## Ground rules

- **No new runtime dependencies** without a good reason. The whole point is that this
  is auditable in an afternoon: a single `server.js`, one `app.js`, no build step,
  no framework, no bundler.
- **No build step.** `public/` is served as-is. Keep it plain ES2020 that a browser
  runs directly.
- **Don't weaken the security posture.** See the Security section in the README. In
  particular: keep the loopback bind, the token gate, and the Origin/Host checks. This
  process runs an agent with `--dangerously-skip-permissions`; anyone who can reach
  `/pty` gets a shell as the user running it.
- **Match the surrounding style.** Comments explain *why*, not *what*. Two-space
  indent, semicolons, single quotes.
- Keep the shell functions POSIX-ish where practical, but zsh-specific is fine —
  `chat` is a zsh function by design.

## Things that would genuinely help

- **Browser-side tests** for `public/app.js` — panes, find bar, drag handling. The
  server has a suite; the client doesn't.
- **Linux verification** — the path resolver falls back from Spotlight to `find`, and
  that fallback has had far less real-world use than the macOS path.
- **Better busy detection.** The amber "working" dot infers busy from PTY output
  flowing, which works because Claude Code redraws its spinner while it thinks. It's a
  proxy, not a real signal — a long silent tool call looks idle. If there's a
  dependable way to ask Claude directly, that would be a real improvement.
- Accessibility passes on the web UI.
- Reducing the replay-buffer memory cost for very long-running sessions (256 KB per
  session, and `pushBuf` drops whole chunks, so a replay can begin mid-escape-sequence).

## Reporting bugs

Include your OS, `node --version`, and whether it reproduces in the plain CLI (`chat
<name>`) as well as the web UI — that separates shell-function bugs from server bugs
quickly.
