#!/usr/bin/env bash
#
# ALG backup: database AND file storage.
#
# A pg_dump on its own is half a backup here. Report PDFs, screenshots and crawl
# artifacts live on disk and are referenced by rows in `files`; restoring only the
# database yields a catalogue of documents that no longer exist.
#
# Usage: backup.sh [target-directory]
#   ALG_BACKUP_DIR   default target (default: /var/backups/alg)
#   ALG_STORAGE_PATH storage root to archive (default: /data/alg/storage)
#   DATABASE_URL     connection string for pg_dump
#   ALG_BACKUP_KEEP  how many timestamped backups to retain (default: 14)

set -Eeuo pipefail

BACKUP_DIR="${1:-${ALG_BACKUP_DIR:-/var/backups/alg}}"
STORAGE_PATH="${ALG_STORAGE_PATH:-/data/alg/storage}"
KEEP="${ALG_BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/${STAMP}"

log() { printf '[backup] %s\n' "$*" >&2; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is not set"
command -v pg_dump >/dev/null || fail "pg_dump not found"

mkdir -p "${TARGET}"

# Stage into .incomplete and rename at the end, so a partial run is never mistaken
# for a usable backup by the restore script or by an operator under pressure.
INCOMPLETE="${TARGET}.incomplete"
rm -rf "${INCOMPLETE}"
mkdir -p "${INCOMPLETE}"
rmdir "${TARGET}"

log "dumping database"
pg_dump --format=custom --no-owner --no-acl --file="${INCOMPLETE}/database.dump" "${DATABASE_URL}"

if [[ -d "${STORAGE_PATH}" ]]; then
  log "archiving storage from ${STORAGE_PATH}"
  # .tmp holds in-flight writes and is deliberately excluded.
  tar --create --gzip \
      --file="${INCOMPLETE}/storage.tar.gz" \
      --exclude='.tmp' \
      --directory="${STORAGE_PATH}" .
else
  log "WARNING: storage path ${STORAGE_PATH} does not exist - archiving nothing"
fi

cat > "${INCOMPLETE}/manifest.txt" <<EOF
created_at=${STAMP}
storage_path=${STORAGE_PATH}
database_dump=database.dump
storage_archive=storage.tar.gz
host=$(hostname)
EOF

( cd "${INCOMPLETE}" && sha256sum ./* > checksums.sha256 )

mv "${INCOMPLETE}" "${TARGET}"
log "backup complete: ${TARGET}"

# Retention: keep the newest N complete backups.
if [[ "${KEEP}" -gt 0 ]]; then
  mapfile -t OLD < <(find "${BACKUP_DIR}" -maxdepth 1 -mindepth 1 -type d -name '*Z' | sort -r | tail -n +"$((KEEP + 1))")
  for dir in "${OLD[@]:-}"; do
    [[ -n "${dir}" ]] || continue
    log "pruning ${dir}"
    rm -rf "${dir}"
  done
fi

log "done"
