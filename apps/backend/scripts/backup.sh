#!/bin/sh
# Sauvegarde quotidienne de la base `catalyst`, conservation 7 jours.
set -eu
while true; do
  file="/backups/catalyst-$(date +%Y%m%d-%H%M%S).sql.gz"
  if pg_dump --no-owner | gzip > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "sauvegarde OK : $file"
  else
    rm -f "$file.tmp"
    echo "sauvegarde EN ÉCHEC" >&2
  fi
  find /backups -name 'catalyst-*.sql.gz' -mtime +7 -delete
  sleep 86400
done
