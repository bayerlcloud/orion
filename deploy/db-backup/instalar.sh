#!/bin/sh
# Instala o backup dos bancos de produção (rodar como root, pelo orion-root). Idempotente.
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd)

# pg_dump 17 (maior ou igual à versão do Postgres do Supabase), pelo repositório oficial PGDG.
if ! pg_dump --version 2>/dev/null | grep -q ' 17\.'; then
  apt-get install -y postgresql-common
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get install -y postgresql-client-17
fi

install -d -o danilo -g danilo -m 700 /srv/backups /srv/backups/db
install -m 644 "$AQUI/orion-db-backup.service" /etc/systemd/system/orion-db-backup.service
install -m 644 "$AQUI/orion-db-backup.timer" /etc/systemd/system/orion-db-backup.timer
systemctl daemon-reload
systemctl enable --now orion-db-backup.timer
pg_dump --version
systemctl list-timers orion-db-backup.timer --no-pager
