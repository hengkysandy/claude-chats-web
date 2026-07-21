#!/usr/bin/env bash
# claude-chats-web installer — sets up deps + shell commands so you get the same
# `chat` / `chats` / `chatweb` experience. Safe to re-run (idempotent).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"
SRC_LINE="source \"$DIR/shell/claude-chats.zsh\""

echo "→ claude-chats-web at: $DIR"

# 1) dependencies
if ! command -v node >/dev/null 2>&1; then echo "✗ Node.js not found — install Node 18+ first." >&2; exit 1; fi
if ! command -v claude >/dev/null 2>&1; then echo "! 'claude' CLI not on PATH — install it: https://claude.com/claude-code"; fi
echo "→ installing npm deps…"; ( cd "$DIR" && npm install )

# 2) data dir
mkdir -p "$HOME/claude-chats"

# 3) wire the shell commands into ~/.zshrc (idempotent)
if grep -qF "$SRC_LINE" "$ZSHRC" 2>/dev/null; then
  echo "→ shell commands already sourced in $ZSHRC"
else
  printf '\n# claude-chats-web — chat/chats/chatweb commands\n%s\n' "$SRC_LINE" >> "$ZSHRC"
  echo "→ added source line to $ZSHRC"
fi

echo
echo "✓ done. Open a NEW terminal (or run: source \"$ZSHRC\"), then:"
echo "    chat <name>   # start/resume a named session in the terminal"
echo "    chatweb       # open the web UI"
echo "    chathelp      # list all commands"
