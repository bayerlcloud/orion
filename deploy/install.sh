#!/usr/bin/env bash
# Instala/atualiza a Central na c3. Rodar como root: bash /srv/orion/deploy/install.sh
set -euo pipefail
cd /srv/orion
chown -R danilo:orion /srv/orion && chmod -R g+rwX /srv/orion
sudo -u danilo -H npm ci --no-audit --no-fund
sudo -u danilo -H npm run build
if [ -n "${SEED_PASSWORD:-}" ]; then
  sudo -u danilo -H env SEED_PASSWORD="$SEED_PASSWORD" $(grep -v '^#' /etc/orion/central.env | xargs) node dist/scripts/seed.js
fi
install -m 644 deploy/orion-central.service /etc/systemd/system/orion-central.service
install -m 644 deploy/orion-inventory.service /etc/systemd/system/orion-inventory.service
install -m 644 deploy/orion-inventory.timer /etc/systemd/system/orion-inventory.timer
install -m 644 deploy/orion-curador.service /etc/systemd/system/orion-curador.service
install -m 644 deploy/orion-curador.timer /etc/systemd/system/orion-curador.timer
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now orion-central
systemctl restart orion-central
# Inventário: timer de hora em hora + uma coleta agora, para a aba "Instalado" já sair atualizada.
systemctl enable --now orion-inventory.timer
# Curador da memória: uma rodada por dia (03:10 UTC), sem coleta inicial (gasta tokens).
systemctl enable --now orion-curador.timer
systemctl start orion-inventory.service || echo "aviso: coleta inicial do inventário falhou (journalctl -u orion-inventory)"
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy || systemctl restart caddy
sleep 2
curl -fsS http://127.0.0.1:3000/api/health && echo " central ok"
