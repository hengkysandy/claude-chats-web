# ─── claude-chats: named conversations for ad-hoc tasks + web UI ───
# Source this from your ~/.zshrc:   source /path/to/claude-chatweb/shell/claude-chats.zsh
# Provides: chat, chats, chatfind, chatarchive, chatrestore, chatsarchived, chatweb, chathelp
# Requires: zsh, and the `claude` CLI on PATH. Chats live under ~/claude-chats/.

# Resolve this repo's location so chatweb finds server.js and chat finds the template.
CLAUDE_CHATS_WEB_DIR="${${(%):-%x}:A:h:h}"
CLAUDE_CHATS_TEMPLATE="${${(%):-%x}:A:h}/adhoc-task.md"
export CLAUDE_CHATS_WEB_DIR CLAUDE_CHATS_TEMPLATE

# Show all claude-chats commands. Usage: chathelp  (or: chat --help)
chathelp() {
  cat <<'EOF'
claude-chats — named conversations for ad-hoc tasks

  chat <name>       Start or resume a named conversation. Creates the workspace
                    (with a CLAUDE.md template) if new; restores it if archived.
  chats             List active chats — name, updated, created (JKT), newest first.
  chatfind <query>  Search all chats' notes (*.md, minus CLAUDE.md) for a term.
  chatarchive [name...]
                    Archive chats (hidden from chats/chatfind, kept on disk).
                    No args = interactive tick/untick picker.
  chatrestore <name>
                    Restore an archived chat back to active.
  chatsarchived     List archived chats — name, updated, created (JKT).
  chatweb           Open the local web UI to browse & run chats in the browser.
  chathelp          Show this help.
EOF
}

# Launch the local web UI (lists all chats, run any of them in the browser).
# Binds to 127.0.0.1 only, token-gated. Ctrl-C to stop.
chatweb() {
  local dir="${CLAUDE_CHATS_WEB_DIR:-$HOME/claude-chats-web}"
  [ -d "$dir" ] || { echo "claude-chats-web not found at $dir"; return 1; }
  [ -d "$dir/node_modules" ] || { echo "deps missing — run: (cd \"$dir\" && npm install)"; return 1; }
  ( cd "$dir" && node server.js )
}

# Start or resume a named conversation. Usage: chat <name>
chat() {
  case "$1" in -h|--help|help) chathelp; return 0 ;; esac
  local name="${1:?usage: chat <name>}"
  local dir="$HOME/claude-chats/$name"
  local template="${CLAUDE_CHATS_TEMPLATE:-$HOME/.claude/plugins/founder-config/templates/adhoc-task.md}"

  local archived="$HOME/claude-chats/.archive/$name"

  if [ -d "$dir" ]; then
    cd "$dir" || return 1
    claude -c --dangerously-skip-permissions
  elif [ -d "$archived" ]; then
    # reopening an archived chat auto-restores it to active
    mv "$archived" "$dir"
    echo "→ restored from archive: $name"
    cd "$dir" || return 1
    claude -c --dangerously-skip-permissions
  else
    mkdir -p "$dir"
    if [ -f "$template" ]; then
      cp "$template" "$dir/CLAUDE.md"
    fi
    echo "→ created new chat workspace: $dir"
    cd "$dir" || return 1
    claude --dangerously-skip-permissions
  fi
}

# List all named conversations — name, created, updated (JKT), newest first.
chats() {
  local root="$HOME/claude-chats"
  if [ ! -d "$root" ] || [ -z "$(ls -A "$root" 2>/dev/null)" ]; then
    echo "(no chats yet — start one with: chat <name>)"
    return 0
  fi

  local tz="Asia/Jakarta"
  local rows="" d name created_epoch updated_epoch created updated

  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    # created = directory birth time; updated = newest file mtime inside (any activity)
    created_epoch="$(stat -f '%B' "$d" 2>/dev/null)"
    updated_epoch="$(find "$d" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -nr | head -1)"
    [ -z "$updated_epoch" ] && updated_epoch="$(stat -f '%m' "$d" 2>/dev/null)"
    [ -z "$created_epoch" ] && created_epoch="$updated_epoch"
    created="$(TZ="$tz" date -r "$created_epoch" '+%Y-%m-%d %H:%M' 2>/dev/null)"
    updated="$(TZ="$tz" date -r "$updated_epoch" '+%Y-%m-%d %H:%M' 2>/dev/null)"
    rows+="${updated_epoch}|${name}|${created}|${updated}"$'\n'
  done

  printf "%-30s  %-17s  %-17s\n" "CHAT" "UPDATED (JKT)" "CREATED (JKT)"
  printf "%-30s  %-17s  %-17s\n" "------------------------------" "-----------------" "-----------------"
  printf '%s' "$rows" | sort -t'|' -k1 -nr | while IFS='|' read -r _ name created updated; do
    [ -z "$name" ] && continue
    printf "%-30s  %-17s  %-17s\n" "$name" "$updated" "$created"
  done
}

# Search across all chats' notes for a term — find which chat it came from.
# Usage: chatfind <query...>   (case-insensitive; searches *.md except CLAUDE.md)
chatfind() {
  local root="$HOME/claude-chats"
  [ $# -eq 0 ] && { echo "usage: chatfind <query>"; return 1; }
  local q="$*"
  [ -d "$root" ] || { echo "(no chats yet — start one with: chat <name>)"; return 0; }

  local tz="Asia/Jakarta"
  local rows="" d name updated_epoch updated snip hit have_rg=0
  command -v rg >/dev/null 2>&1 && have_rg=1

  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    if [ "$have_rg" = 1 ]; then
      hit="$(rg -li -g '*.md' -g '!CLAUDE.md' -- "$q" "$d" 2>/dev/null)"
    else
      hit="$(grep -ril --include='*.md' --exclude='CLAUDE.md' -- "$q" "$d" 2>/dev/null)"
    fi
    [ -z "$hit" ] && continue
    name="$(basename "$d")"
    updated_epoch="$(find "$d" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -nr | head -1)"
    [ -z "$updated_epoch" ] && updated_epoch="$(stat -f '%m' "$d" 2>/dev/null)"
    updated="$(TZ="$tz" date -r "$updated_epoch" '+%Y-%m-%d %H:%M' 2>/dev/null)"
    if [ "$have_rg" = 1 ]; then
      snip="$(rg -iIN -m1 -g '*.md' -g '!CLAUDE.md' -- "$q" "$d" 2>/dev/null | head -1)"
    else
      snip="$(grep -rih --include='*.md' --exclude='CLAUDE.md' -m1 -- "$q" "$d" 2>/dev/null | head -1)"
    fi
    snip="$(printf '%s' "$snip" | sed 's/^[[:space:]]*//' | cut -c1-90)"
    rows+="${updated_epoch}|${name}|${updated}|${snip}"$'\n'
  done

  [ -z "$rows" ] && { echo "no chats mention: $q"; return 0; }

  printf '%s' "$rows" | sort -t'|' -k1 -nr | while IFS='|' read -r _ name updated snip; do
    [ -z "$name" ] && continue
    printf '\033[1m%-30s\033[0m  %s\n' "$name" "$updated"
    [ -n "$snip" ] && printf '    %s\n' "$snip"
  done
}

# Archive chats — hides them from `chats`/`chatfind` but keeps them on disk.
# Usage: chatarchive              → interactive tick/untick picker
#        chatarchive <name...>    → archive named chats directly
chatarchive() {
  local root="$HOME/claude-chats" adir="$HOME/claude-chats/.archive"

  # helper: move one active chat to archive
  _chat_do_archive() {
    local name="$1" dir="$root/$1"
    [ -d "$dir" ] || { echo "no active chat named: $name"; return 1; }
    mkdir -p "$adir"
    [ -d "$adir/$name" ] && { echo "skip (already archived): $name"; return 1; }
    mv "$dir" "$adir/$name" && echo "→ archived: $name"
  }

  # direct mode
  if [ $# -gt 0 ]; then
    local n
    for n in "$@"; do _chat_do_archive "$n"; done
    unfunction _chat_do_archive
    return
  fi

  # interactive mode — gather active chats, newest-updated first
  local tz="Asia/Jakarta" rows="" d name updated_epoch updated
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    updated_epoch="$(find "$d" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -nr | head -1)"
    [ -z "$updated_epoch" ] && updated_epoch="$(stat -f '%m' "$d" 2>/dev/null)"
    updated="$(TZ="$tz" date -r "$updated_epoch" '+%Y-%m-%d' 2>/dev/null)"
    rows+="${updated_epoch}|${name}|${updated}"$'\n'
  done
  if [ -z "$rows" ]; then
    echo "(no active chats to archive)"
    unfunction _chat_do_archive
    return 0
  fi

  local -a names dates sel
  while IFS='|' read -r _ name updated; do
    [ -z "$name" ] && continue
    names+=("$name"); dates+=("$updated"); sel+=(0)
  done < <(printf '%s' "$rows" | sort -t'|' -k1 -nr)

  local n=${#names} cur=1 i mark row key rest cancelled=0 maxw
  maxw=$(( ${COLUMNS:-80} - 2 ))

  # draw one row (highlighted if it's the cursor); clears to end of line
  _chat_row() {
    local idx=$1
    [ "${sel[$idx]}" = 1 ] && mark="x" || mark=" "
    row="$(printf '[%s] %-32.32s %s' "$mark" "${names[$idx]}" "${dates[$idx]}")"
    row="${row[1,$maxw]}"
    if [ "$idx" = "$cur" ]; then
      printf '\033[7m› %s\033[0m\033[K\n' "$row"
    else
      printf '  %s\033[K\n' "$row"
    fi
  }

  print -r -- ""
  print -r -- "↑/↓ move · space tick/untick · a all · n none · Enter archive · q cancel"
  print -r -- ""
  for i in {1..$n}; do _chat_row $i; done   # initial draw

  while true; do
    read -sk1 key || { cancelled=1; break; }
    case "$key" in
      $'\e')                       # escape sequence (arrow keys) or bare Esc
        read -sk2 -t 1 rest || { cancelled=1; break; }
        case "$rest" in
          '[A') (( cur > 1 )) && cur=$((cur-1)) ;;   # up
          '[B') (( cur < n )) && cur=$((cur+1)) ;;   # down
        esac ;;
      ' ')          sel[$cur]=$(( 1 - ${sel[$cur]} )) ;;
      k|K)          (( cur > 1 )) && cur=$((cur-1)) ;;   # vim-style up
      j|J)          (( cur < n )) && cur=$((cur+1)) ;;   # vim-style down
      a|A)          for i in {1..$n}; do sel[$i]=1; done ;;
      n|N)          for i in {1..$n}; do sel[$i]=0; done ;;
      q|Q)          cancelled=1; break ;;
      $'\n'|$'\r')  break ;;
    esac
    printf '\033[%dA' $n           # cursor back to top of list, redraw
    for i in {1..$n}; do _chat_row $i; done
  done
  unfunction _chat_row

  if [ "$cancelled" = 1 ]; then
    echo "cancelled"
    unfunction _chat_do_archive
    return 0
  fi

  local count=0
  for i in {1..${#names}}; do
    [ "${sel[$i]}" = 1 ] && { _chat_do_archive "${names[$i]}" && count=$((count+1)); }
  done
  [ "$count" = 0 ] && echo "(nothing selected — nothing archived)" \
                   || echo "archived $count chat(s). restore with: chatrestore <name>, or just: chat <name>"
  unfunction _chat_do_archive
}

# Restore an archived chat back to active. Usage: chatrestore <name>
chatrestore() {
  local name="${1:?usage: chatrestore <name>}"
  local dir="$HOME/claude-chats/$name"
  local adir="$HOME/claude-chats/.archive/$name"
  if [ ! -d "$adir" ]; then
    echo "no archived chat named: $name"
    return 1
  fi
  if [ -d "$dir" ]; then
    echo "an active chat named $name already exists — rename one first"
    return 1
  fi
  mv "$adir" "$dir" && echo "→ restored: $name"
}

# List archived chats — name, updated, created (JKT), newest first.
chatsarchived() {
  local root="$HOME/claude-chats/.archive"
  if [ ! -d "$root" ] || [ -z "$(ls -A "$root" 2>/dev/null)" ]; then
    echo "(no archived chats)"
    return 0
  fi
  local tz="Asia/Jakarta"
  local rows="" d name created_epoch updated_epoch created updated
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    created_epoch="$(stat -f '%B' "$d" 2>/dev/null)"
    updated_epoch="$(find "$d" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -nr | head -1)"
    [ -z "$updated_epoch" ] && updated_epoch="$(stat -f '%m' "$d" 2>/dev/null)"
    [ -z "$created_epoch" ] && created_epoch="$updated_epoch"
    created="$(TZ="$tz" date -r "$created_epoch" '+%Y-%m-%d %H:%M' 2>/dev/null)"
    updated="$(TZ="$tz" date -r "$updated_epoch" '+%Y-%m-%d %H:%M' 2>/dev/null)"
    rows+="${updated_epoch}|${name}|${created}|${updated}"$'\n'
  done
  printf "%-30s  %-17s  %-17s\n" "ARCHIVED CHAT" "UPDATED (JKT)" "CREATED (JKT)"
  printf "%-30s  %-17s  %-17s\n" "------------------------------" "-----------------" "-----------------"
  printf '%s' "$rows" | sort -t'|' -k1 -nr | while IFS='|' read -r _ name created updated; do
    [ -z "$name" ] && continue
    printf "%-30s  %-17s  %-17s\n" "$name" "$updated" "$created"
  done
}

# Optional: always run `claude` with --dangerously-skip-permissions (matches the
# original setup). Uncomment if you want it globally; chat/chatweb already pass it.
# claude() { command claude --dangerously-skip-permissions "$@"; }
# ─── end claude-chats ───
