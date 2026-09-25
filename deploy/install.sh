#!/usr/bin/env bash
# Instala/atualiza a Central na c3. Rodar como root: bash /srv/orion/deploy/install.sh
set -euo pipefail
cd /srv/orion
chown -R orion:orion /srv/orion
sudo -u orion -H npm ci --no-audit --no-fund
sudo -u orion -H npm run build
if [ -n "${SEED_PASSWORD:-}" ]; then
  sudo -u orion -H env SEED_PASSWORD="$SEED_PASSWORD" $(grep -v '^#' /etc/orion/central.env | xargs) node dist/scripts/seed.js
fi
install -m 644 deploy/orion-central.service /etc/systemd/system/orion-central.service
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now orion-central
systemctl restart orion-central
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy || systemctl restart caddy
sleep 2
curl -fsS http://127.0.0.1:3000/api/health && echo " central ok"
