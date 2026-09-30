#!/bin/sh
# Instala a infra dos previews ao vivo na c3 (rodar como root, pelo orion-root). Idempotente.
# Spec: docs/superpowers/specs/2026-09-30-preview-design.md, Parte 1.
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd)

# Usuário sem shell e sem home: roda os vites, sem acesso a ~danilo nem a /etc/orion.
id preview >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin preview
command -v setfacl >/dev/null || apt-get install -y acl

# Leitura nas pastas dos projetos e das worktrees (e padrão para o que nascer depois).
for d in /srv/projects /srv/worktrees; do
  mkdir -p "$d"
  setfacl -m u:preview:rX "$d"
  setfacl -R -m u:preview:rX,d:u:preview:rX "$d"
done
setfacl -m u:preview:x /srv

# .env dos previews: escritos pelo orion-central (danilo), lidos pelas units.
install -d -o danilo -g danilo -m 755 /srv/previews

# Swap de 4 GB como proteção geral da c3.
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 4G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# O orion-central (danilo) só pode parar o vite de um preview para trocar a pasta servida.
printf 'danilo ALL=(root) NOPASSWD: /usr/bin/systemctl stop preview-vite@*\n' > /etc/sudoers.d/orion-preview
chmod 440 /etc/sudoers.d/orion-preview
visudo -c -f /etc/sudoers.d/orion-preview

for u in preview.slice preview@.socket preview@.service preview-vite@.service; do
  install -m 644 "$AQUI/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload

# Caddy lê um arquivo por preview.
mkdir -p /etc/caddy/previews.d
grep -q 'import /etc/caddy/previews.d/\*.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/previews.d/*.caddy\n' >> /etc/caddy/Caddyfile

echo "ok: infra de preview instalada; rode node /srv/orion-live/dist/scripts/sync-previews.js"
