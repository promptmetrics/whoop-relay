#!/usr/bin/env bash
# Manage the WHOOP Relay invite allowlist in D1.
#
#   scripts/allowlist.sh add <email> [note]   # invite (idempotent)
#   scripts/allowlist.sh remove <email>       # un-invite (does not disconnect an already-connected user)
#   scripts/allowlist.sh list                 # show invites and who has connected
#
# Targets production D1; add --local as the LAST argument for the local dev database.
set -euo pipefail

target="--remote"
if [[ $# -gt 0 && "${*: -1}" == "--local" ]]; then target="--local"; set -- "${@:1:$#-1}"; fi

cmd="${1:-}"; email="${2:-}"; note="${3:-}"
sql_quote() { printf "%s" "$1" | sed "s/'/''/g"; }
run() { npx wrangler d1 execute whoop-relay "$target" --command "$1"; }

case "$cmd" in
  add)
    [[ -n "$email" ]] || { echo "usage: $0 add <email> [note]" >&2; exit 2; }
    if [[ -n "$note" ]]; then note_sql="'$(sql_quote "$note")'"; else note_sql="NULL"; fi
    run "INSERT INTO allowlist (email, added_at, note) VALUES ('$(sql_quote "$email")', strftime('%Y-%m-%dT%H:%M:%SZ','now'), $note_sql) ON CONFLICT(email) DO UPDATE SET note=excluded.note"
    ;;
  remove)
    [[ -n "$email" ]] || { echo "usage: $0 remove <email>" >&2; exit 2; }
    run "DELETE FROM allowlist WHERE email = '$(sql_quote "$email")'"
    ;;
  list)
    run "SELECT a.email, a.added_at, a.note, CASE WHEN u.whoop_user_id IS NULL THEN 'invited' ELSE 'connected' END AS state FROM allowlist a LEFT JOIN users u ON u.email = a.email COLLATE NOCASE ORDER BY a.added_at"
    ;;
  *)
    sed -n '2,8p' "$0" >&2; exit 2 ;;
esac
