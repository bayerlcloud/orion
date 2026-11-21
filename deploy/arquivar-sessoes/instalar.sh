#!/bin/sh
# Instala o arquivamento automático de sessões paradas (rodar como root, pelo orion-root). Idempotente.
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd)

install -m 644 "$AQUI/orion-arquivar-sessoes.service" /etc/systemd/system/orion-arquivar-sessoes.service
install -m 644 "$AQUI/orion-arquivar-sessoes.timer" /etc/systemd/system/orion-arquivar-sessoes.timer
systemctl daemon-reload
systemctl enable --now orion-arquivar-sessoes.timer
systemctl list-timers orion-arquivar-sessoes.timer --no-pager
