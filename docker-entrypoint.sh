#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}
UMASK=${UMASK:-022}

# Create group and user if they don't exist
if ! getent group "$PGID" > /dev/null 2>&1; then
  addgroup -g "$PGID" appgroup
fi
GROUP_NAME=$(getent group "$PGID" | cut -d: -f1)

if ! getent passwd "$PUID" > /dev/null 2>&1; then
  adduser -u "$PUID" -G "$GROUP_NAME" -s /bin/sh -D appuser
fi
USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)

# Ensure data dir is owned correctly
mkdir -p "${DATA_DIR:-/data}"
chown -R "$PUID:$PGID" "${DATA_DIR:-/data}"

echo "[entrypoint] Running as $USER_NAME ($PUID:$PGID) umask=$UMASK"

umask "$UMASK"
exec su-exec "$PUID:$PGID" "$@"
