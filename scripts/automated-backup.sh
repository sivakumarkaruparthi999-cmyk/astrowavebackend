#!/usr/bin/env bash
# ==============================================================================
# AstroWave Production Automated Backup & Offsite Replication Script
# Hardened: Zero hardcoded secrets, restrictive permissions, web-root protection
# ==============================================================================
set -euo pipefail

# 1. Configurable backup destination (defaulting to isolated system directory)
BACKUP_DIR="${BACKUP_DIR:-/var/backups/astrowave}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/astrowave_pg_${TIMESTAMP}.dump"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
ALERT_WEBHOOK="${ALERT_WEBHOOK_URL:-}"

# 2. Strict Credential Handling: Require DATABASE_URL or PG* standard variables
POSTGRES_URL="${DATABASE_URL:-}"

notify_failure() {
    local err_msg="$1"
    echo "[ERROR] AstroWave backup failed: ${err_msg}" >&2
    if [[ -n "${ALERT_WEBHOOK}" ]]; then
        curl -s -X POST -H 'Content-Type: application/json' \
            -d "{\"text\":\"[CRITICAL] AstroWave Backup Failure: ${err_msg}\"}" \
            "${ALERT_WEBHOOK}" >/dev/null 2>&1 || true
    fi
    exit 1
}

# Cleanup hook for incomplete / temporary files on error
cleanup_on_error() {
    local exit_code=$?
    if [[ ${exit_code} -ne 0 ]]; then
        echo "[WARN] Cleaning up incomplete backup files due to error (exit ${exit_code})..." >&2
        rm -f "${BACKUP_FILE}" "${CHECKSUM_FILE}" 2>/dev/null || true
    fi
}
trap cleanup_on_error EXIT

# 3. Security Boundary: Ensure backup directory cannot accidentally be web-accessible
CURRENT_DIR="$(pwd)"
RESOLVED_BACKUP_DIR="$(mkdir -p "${BACKUP_DIR}" && cd "${BACKUP_DIR}" && pwd)"

for prohibited in "uploads" "public" "static" "dist" "build" "astroo-admin"; do
    if [[ "${RESOLVED_BACKUP_DIR}" == *"${CURRENT_DIR}/${prohibited}"* ]] || [[ "${RESOLVED_BACKUP_DIR}" == *"${prohibited}" ]]; then
        notify_failure "Backup directory (${RESOLVED_BACKUP_DIR}) cannot reside inside public web directory '${prohibited}'"
    fi
done

# Enforce restrictive directory permissions (Owner-only access)
chmod 700 "${RESOLVED_BACKUP_DIR}" 2>/dev/null || true

echo "[INFO] [$(date)] Starting AstroWave automated backup..."

# 4. Execute pg_dump using credentials strictly from environment
if [[ -z "${POSTGRES_URL}" && -z "${PGDATABASE:-}" ]]; then
    notify_failure "DATABASE_URL or PGDATABASE must be set in environment. Hardcoded fallbacks are strictly prohibited."
fi

PG_DUMP_BIN=""
if command -v pg_dump >/dev/null 2>&1; then
    PG_DUMP_BIN="pg_dump"
elif [[ -x "/Library/PostgreSQL/18/bin/pg_dump" ]]; then
    PG_DUMP_BIN="/Library/PostgreSQL/18/bin/pg_dump"
else
    notify_failure "pg_dump binary not found in PATH or standard location"
fi

# Execute dump safely without printing credentials
if [[ -n "${POSTGRES_URL}" ]]; then
    "${PG_DUMP_BIN}" -Fc -d "${POSTGRES_URL}" -f "${BACKUP_FILE}"
else
    "${PG_DUMP_BIN}" -Fc -f "${BACKUP_FILE}"
fi

# 5. Restrictive File Permissions (Owner-only read/write: 0600)
chmod 600 "${BACKUP_FILE}"

# 6. Compute & Validate SHA-256 Checksum
if command -v shasum >/dev/null 2>&1; then
    (cd "${RESOLVED_BACKUP_DIR}" && shasum -a 256 "$(basename "${BACKUP_FILE}")" > "$(basename "${CHECKSUM_FILE}")")
    (cd "${RESOLVED_BACKUP_DIR}" && shasum -a 256 -c "$(basename "${CHECKSUM_FILE}")" >/dev/null)
elif command -v sha256sum >/dev/null 2>&1; then
    (cd "${RESOLVED_BACKUP_DIR}" && sha256sum "$(basename "${BACKUP_FILE}")" > "$(basename "${CHECKSUM_FILE}")")
    (cd "${RESOLVED_BACKUP_DIR}" && sha256sum -c "$(basename "${CHECKSUM_FILE}")" >/dev/null)
fi
chmod 600 "${CHECKSUM_FILE}"

BACKUP_SIZE="$(stat -f%z "${BACKUP_FILE}" 2>/dev/null || stat -c%s "${BACKUP_FILE}" 2>/dev/null || echo "0")"
echo "[INFO] Backup created and checksum validated: ${BACKUP_FILE} (${BACKUP_SIZE} bytes, mode 0600)"

# 7. Offsite Replication to Isolated S3 Object Storage (if configured)
if [[ -n "${S3_BUCKET}" ]]; then
    echo "[INFO] Replicating backup to offsite bucket: ${S3_BUCKET}..."
    if command -v aws >/dev/null 2>&1; then
        aws s3 cp "${BACKUP_FILE}" "${S3_BUCKET}/postgres/${TIMESTAMP}/" --sse aws:kms
        aws s3 cp "${CHECKSUM_FILE}" "${S3_BUCKET}/postgres/${TIMESTAMP}/"
        echo "[INFO] Offsite replication complete."
    else
        echo "[WARN] aws CLI not installed; offsite sync skipped."
    fi
else
    echo "[INFO] No BACKUP_S3_BUCKET specified. Backup securely retained locally in ${RESOLVED_BACKUP_DIR}."
fi

# 8. Enforce Retention Policy: Prune backups older than RETENTION_DAYS
echo "[INFO] Enforcing retention policy: deleting local backups older than ${RETENTION_DAYS} days..."
find "${RESOLVED_BACKUP_DIR}" -type f -name "astrowave_pg_*.dump*" -mtime +"${RETENTION_DAYS}" -delete || true

echo "[INFO] [$(date)] AstroWave automated backup completed successfully."
