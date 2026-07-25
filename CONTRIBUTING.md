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
npm run check                  # syntax-checks server.js and public/app.js
zsh -n shell/claude-chats.zsh  # parse-check the shell functions
```

There is no test suite yet. If you touch anything non-obvious, say in the PR how you
verified it — a paste of the commands you ran is fine. Contributions that add real
tests are very welcome.

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

- A test suite (there's currently none).
- Linux verification — the path resolver falls back from Spotlight to `find`, and that
  fallback has had far less real-world use than the macOS path.
- Accessibility passes on the web UI.
- Reducing the replay-buffer memory cost for very long-running sessions.

## Reporting bugs

Include your OS, `node --version`, and whether it reproduces in the plain CLI (`chat
<name>`) as well as the web UI — that separates shell-function bugs from server bugs
quickly.
