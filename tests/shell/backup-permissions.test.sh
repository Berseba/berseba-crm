#!/usr/bin/env bash
# Proves that backup.sh writes the backups readable by their owner only.
#
#   bash tests/shell/backup-permissions.test.sh
#
# Measured on a production VPS on 2026-09-29: `backups/db-*.sql.gz` (every
# customer's data) and `backups/waha-*.tgz` (the WhatsApp sessions) came out
# 644 — readable by any user on the machine.
#
# The real backup.sh runs in a fake project with a docker double. The double
# writes the WAHA snapshot with `umask 022`, as the real container does (it
# ignores the host umask) — a double that inherited the script's umask would
# make the chmod after the `mv` look unnecessary.
set -uo pipefail
unset COMPOSE_PROJECT_NAME

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
mode_is() { local m; m="$(mode "$1")"; [ "$m" = "$2" ] || { printf '    %s is %s, expected %s\n' "$1" "$m" "$2"; return 1; }; }

export VOLSTORE="$WORK/volumes"
mkdir -p "$WORK/bin" "$VOLSTORE/deskcommcrm_waha-data/noweb"
head -c 4096 /dev/urandom > "$VOLSTORE/deskcommcrm_waha-data/noweb/waha.sqlite3"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
case " $* " in
  *" ps -a -q waha "*) echo abc123; exit 0 ;;
  *" inspect "*) printf 'volume|deskcommcrm_waha-data|\n'; exit 0 ;;
esac
case " $* " in *" run "*) ;; *) exit 0 ;; esac
out=""; prev=""
for a in "$@"; do
  [ "$prev" = "-v" ] && case "$a" in *:/out) out="${a%:/out}" ;; esac
  prev="$a"
done
[ -n "$out" ] || { echo "-- fake dump --"; exit 0; }   # pg_dump: goes to stdout
target="$(printf '%s\n' "$*" | grep -oE '/out/[^ ]+' | head -1)"
# The container writes as its own root with its own umask.
umask 022
tar czf "$out/${target#/out/}" -C "$VOLSTORE/deskcommcrm_waha-data" .
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

PROJ="$WORK/deskcommcrm"
mkdir -p "$PROJ/backups"
: > "$PROJ/docker-compose.prod.yml"
printf '%s\n' 'SUPABASE_DB_URL="postgresql://postgres:pw@db.example.supabase.co:5432/postgres"' > "$PROJ/.env"
# What older versions left behind: a 755 folder and 644 backups.
chmod 755 "$PROJ/backups"
printf 'old dump' | gzip > "$PROJ/backups/db-20260101-030000.sql.gz"
printf 'old sessions' > "$PROJ/backups/waha-20260101-030000.tgz"
chmod 644 "$PROJ/backups/db-20260101-030000.sql.gz" "$PROJ/backups/waha-20260101-030000.tgz"

echo "control: the docker double writes the snapshot 644, like the real container"
( umask 077; cd "$WORK" && mkdir -p ctl && docker run --rm -v "x:/data:ro" -v "$WORK/ctl:/out" alpine tar czf /out/probe.tgz -C /data . )
check "the double ignores the caller's umask 077" mode_is "$WORK/ctl/probe.tgz" 644

echo "backup.sh:"
( cd "$PROJ" && umask 022 && bash "$KIT_DIR/backup.sh" ) > "$WORK/out.txt" 2>&1
RC=$?
[ "$RC" = 0 ] || sed 's/^/    | /' "$WORK/out.txt"
check "finished (exit 0)" [ "$RC" = 0 ]
DB="$(ls -t "$PROJ"/backups/db-*.sql.gz | head -1)"
WAHA="$(ls -t "$PROJ"/backups/waha-*.tgz | head -1)"
check "made a new dump (not the old one)" [ "$DB" != "$PROJ/backups/db-20260101-030000.sql.gz" ]
check "made a new WhatsApp snapshot" [ "$WAHA" != "$PROJ/backups/waha-20260101-030000.tgz" ]
check "the database dump is 600" mode_is "$DB" 600
check "the WhatsApp snapshot is 600 (written by the container at 644)" mode_is "$WAHA" 600
check "the backups folder is 700" mode_is "$PROJ/backups" 700
check "an old 644 dump was closed to 600" mode_is "$PROJ/backups/db-20260101-030000.sql.gz" 600
check "an old 644 snapshot was closed to 600" mode_is "$PROJ/backups/waha-20260101-030000.tgz" 600
check "no .parcial left behind" bash -c '! ls -A "$1" | grep -q parcial' _ "$PROJ/backups"

echo "backup.sh with BACKUP_DIR set by the operator:"
# A shared mount another user or a copy job reads: the kit must not change the
# folder's mode, only close its own files.
CUSTOM="$WORK/shared-mount"
mkdir -p "$CUSTOM"; chmod 755 "$CUSTOM"
( cd "$PROJ" && umask 022 && BACKUP_DIR="$CUSTOM" bash "$KIT_DIR/backup.sh" ) > "$WORK/out-custom.txt" 2>&1
RC=$?
[ "$RC" = 0 ] || sed 's/^/    | /' "$WORK/out-custom.txt"
check "finished (exit 0)" [ "$RC" = 0 ]
check "the operator's folder keeps its 755" mode_is "$CUSTOM" 755
check "the dump inside it is still 600" mode_is "$(ls -t "$CUSTOM"/db-*.sql.gz | head -1)" 600
check "the WhatsApp snapshot inside it is still 600" mode_is "$(ls -t "$CUSTOM"/waha-*.tgz | head -1)" 600

[ "$FAILS" -eq 0 ] || { echo "✗ $FAILS failure(s)" >&2; exit 1; }
echo "✓ backup permissions: all cases passed"
