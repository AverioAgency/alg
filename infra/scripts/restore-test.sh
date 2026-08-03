#!/usr/bin/env bash
#
# Verifies that a backup is actually restorable. An untested backup is a guess.
#
# Restores the dump into a scratch database, unpacks the storage archive into a
# temp directory, and cross-checks that every row in `files` has a matching file.
# Never point this at the production database.
#
# Usage: restore-test.sh <backup-directory>
#   RESTORE_DATABASE_URL  scratch database to restore into (required)

set -Eeuo pipefail

BACKUP="${1:-}"
log() { printf '[restore-test] %s\n' "$*" >&2; }
fail() { printf '[restore-test] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -n "${BACKUP}" ]] || fail "usage: restore-test.sh <backup-directory>"
[[ -d "${BACKUP}" ]] || fail "no such backup directory: ${BACKUP}"
[[ -n "${RESTORE_DATABASE_URL:-}" ]] || fail "RESTORE_DATABASE_URL is not set"

case "${RESTORE_DATABASE_URL}" in
  *prod*|*production*) fail "refusing to restore into something that looks like production" ;;
esac

command -v pg_restore >/dev/null || fail "pg_restore not found"
command -v psql >/dev/null || fail "psql not found"

log "verifying checksums"
( cd "${BACKUP}" && sha256sum --check --quiet checksums.sha256 ) || fail "checksum mismatch"

log "restoring database into scratch target"
pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname="${RESTORE_DATABASE_URL}" "${BACKUP}/database.dump"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT

if [[ -f "${BACKUP}/storage.tar.gz" ]]; then
  log "unpacking storage archive"
  tar --extract --gzip --file="${BACKUP}/storage.tar.gz" --directory="${SCRATCH}"
fi

log "cross-checking files table against restored artifacts"
MISSING=0
while IFS= read -r rel; do
  [[ -n "${rel}" ]] || continue
  if [[ ! -f "${SCRATCH}/${rel}" ]]; then
    log "MISSING: ${rel}"
    MISSING=$((MISSING + 1))
  fi
done < <(psql "${RESTORE_DATABASE_URL}" -Atc "SELECT relative_path FROM files")

TOTAL="$(psql "${RESTORE_DATABASE_URL}" -Atc "SELECT count(*) FROM files")"
log "checked ${TOTAL} rows, ${MISSING} missing"

# A restored database whose files are gone would surface as broken report links in
# production, so this is a hard failure rather than a warning.
[[ "${MISSING}" -eq 0 ]] || fail "${MISSING} referenced files are absent from the archive"

log "restore test passed"
