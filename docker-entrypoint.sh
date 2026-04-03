#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}
UMASK=${UMASK:-022}

if ! getent group "$PGID" > /dev/null 2>&1; then
  groupadd -g "$PGID" appgroup
fi
GROUP_NAME=$(getent group "$PGID" | cut -d: -f1)

if ! getent passwd "$PUID" > /dev/null 2>&1; then
  useradd -u "$PUID" -g "$PGID" -s /bin/sh -M appuser
fi
USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)

mkdir -p "${DATA_DIR:-/data}"
chown -R "$PUID:$PGID" "${DATA_DIR:-/data}"

echo "[entrypoint] Running as $USER_NAME ($PUID:$PGID) umask=$UMASK"

umask "$UMASK"
exec gosu "$PUID:$PGID" "$@"
