#!/usr/bin/env bash
# Ponte da unit orion-deploy.path: lê /srv/builds/pedido.json (escrito pelo painel), apaga o pedido
# e passa para build.sh. Se um build já estiver rodando, o systemd dispara de novo quando ele acabar.
set -euo pipefail
P=/srv/builds/pedido.json
[ -f "$P" ] || exit 0
if ! J=$(python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); print(j.get("ref") or "main", (j.get("por") or "painel").replace("\n"," "))' "$P" 2>&1); then
  echo "pedido inválido, descartado: $J"; rm -f "$P"; exit 1
fi
read -r REF POR <<<"$J"
rm -f "$P"
[[ $REF =~ ^(main|[0-9a-fA-F]{7,40})$ ]] || { echo "ref recusada: $REF"; exit 1; }
DEPLOY_POR=$POR exec bash "$(dirname "$0")/build.sh" "$REF"
