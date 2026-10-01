#!/usr/bin/env bash
# Build e publicação do Orion v2. Rodar como root: bash /usr/local/lib/orion/build.sh [main|sha]
# Chamado pela unit orion-deploy.service (botão Publicar, via deploy-run.sh) ou na mão por um agente.
# Um build por vez (flock, o mesmo cadeado dos builds manuais). Checkout limpo em /srv/builds/<sha>-<data>,
# node_modules por hardlink do build anterior quando o package-lock não mudou, typecheck + testes + build
# como danilo, troca atômica do symlink /srv/orion-live, restart, health em 40 s e volta se não responder.
# Estado para o painel em /srv/builds/status.json (e <nome>.json no fim); log em <nome>.log.
set -euo pipefail
REPO=/srv/orion
BUILDS=/srv/builds
LIVE=/srv/orion-live
LOCK=/tmp/orion-build.lock
DONO=danilo:orion
REF=${1:-main}

export B_ESTADO=fila B_ETAPA='esperando o cadeado' B_REF=$REF B_POR=${DEPLOY_POR:-terminal} B_INICIO=$(date -u +%FT%TZ)
export B_FIM= B_SHA= B_MSG= B_NOME= B_LOG= B_ANTERIOR=
install -d -m 2775 -o danilo -g orion "$BUILDS"

status() { # status <estado> <etapa>: escrita atômica de status.json (0664, danilo:orion)
  B_ESTADO=$1 B_ETAPA=$2 python3 - "$BUILDS/status.json" <<'PY'
import json, os, sys
p = sys.argv[1]; e = os.environ
d = {k: e.get('B_' + k.upper(), '') for k in ('estado', 'etapa', 'sha', 'msg', 'ref', 'nome', 'por', 'inicio', 'log', 'anterior')}
d['fim'] = e.get('B_FIM') or None
with open(p + '.tmp', 'w') as f: json.dump(d, f, ensure_ascii=False)
os.chmod(p + '.tmp', 0o664); os.replace(p + '.tmp', p)
PY
  chown $DONO "$BUILDS/status.json"
  echo "[$(date -u +%T)] $1: $2"
}
etapa() { ETAPA_ATUAL=$1; status rodando "$1"; }
como() { sudo -u danilo -H env "PATH=$PATH" bash -o pipefail -c "cd '$DIR' && $*"; }
trocar_link() { ln -sfn "$1" "$LIVE.tmp" && mv -T "$LIVE.tmp" "$LIVE"; }
saudavel() { for _ in $(seq 40); do curl -fsS -m 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

fim() { # trap EXIT: fecha o status (ok|falhou), copia para <nome>.json
  rc=$?
  export B_FIM=$(date -u +%FT%TZ)
  if [ $rc -eq 0 ]; then status ok "publicado ${B_NOME:-}"; else status falhou "falhou em: ${ETAPA_ATUAL:-início}"; fi
  [ -n "${B_NOME:-}" ] && cp -p "$BUILDS/status.json" "$BUILDS/$B_NOME.json" || true
}
trap fim EXIT

status fila 'esperando o cadeado'
exec 9>"$LOCK"; flock 9

etapa 'resolvendo a ref'
G="sudo -u danilo -H git -C $REPO"
[ "$REF" = main ] && REF=refs/heads/main
SHA=$($G rev-parse --verify "$REF^{commit}")
NOME="${SHA:0:10}-$(date -u +%Y%m%d-%H%M%S)"
DIR=$BUILDS/$NOME
ANTERIOR=$(readlink -f "$LIVE" 2>/dev/null || true)
export B_SHA=${SHA:0:10} B_MSG=$($G log -1 --format=%s "$SHA") B_NOME=$NOME B_LOG=$BUILDS/$NOME.log B_ANTERIOR=$(basename "${ANTERIOR:-?}")
exec > >(tee -a "$B_LOG") 2>&1
echo "build $NOME de $SHA ($B_MSG) pedido por $B_POR; no ar: ${ANTERIOR:-nada}"

etapa 'checkout limpo'
mkdir -p "$DIR"
$G archive --format=tar "$SHA" | tar -x --no-same-owner -C "$DIR"

etapa 'node_modules'
# Reaproveita por hardlink (cp -al) o node_modules mais novo cujo package-lock é idêntico; senão npm ci.
NM=
for c in $(ls -dt "$BUILDS"/*/ 2>/dev/null) "${ANTERIOR:-/nada}"; do
  c=${c%/}
  [ "$c" != "$DIR" ] && [ -d "$c/node_modules" ] && cmp -s "$c/package-lock.json" "$DIR/package-lock.json" && { NM=$c; break; }
done
chown -R $DONO "$DIR"
if [ -n "$NM" ]; then
  echo "node_modules por hardlink de $NM"
  cp -al "$NM/node_modules" "$DIR/node_modules"
  rm -rf "$DIR/node_modules/.vite" "$DIR/node_modules/.cache" # ponytail: caches que o build reescreve; nada mais é gravado em node_modules
else
  como npm ci --no-audit --no-fund
fi

etapa 'typecheck';  como npm run typecheck
etapa 'testes';     como npx vitest run
etapa 'build';      como npm run build
chown -R $DONO "$DIR"

etapa "trocando $LIVE para $NOME"
trocar_link "$DIR"
systemctl restart orion-central
etapa 'esperando o painel responder'
if ! saudavel; then
  echo "painel não respondeu em 40 s"
  if [ -n "$ANTERIOR" ] && [ -d "$ANTERIOR" ]; then
    etapa "voltando para $B_ANTERIOR"
    trocar_link "$ANTERIOR"
    systemctl restart orion-central
    saudavel && echo "voltou: $B_ANTERIOR no ar" || echo "ATENÇÃO: nem o anterior respondeu; olhe journalctl -u orion-central"
  fi
  ETAPA_ATUAL="health falhou; voltei para $B_ANTERIOR"
  exit 1
fi

etapa 'gateway do WhatsApp'
# orion-wa não reinicia a cada publicação (é o que segura o webhook da Evolution); só quando o código dele muda.
wa_hash() { cat "$1"/dist/server/wa/*.js "$1"/dist/server/whatsapp.js "$1"/dist/server/tools/evolution.js "$1"/dist/server/settings.js "$1"/dist/server/db.js 2>/dev/null | sha256sum; }
if [ -z "$ANTERIOR" ] || [ "$(wa_hash "$ANTERIOR")" != "$(wa_hash "$DIR")" ]; then systemctl try-restart orion-wa || echo "ATENÇÃO: orion-wa não reiniciou"; fi

etapa 'helper root'
# Ponte de root do chat (server/claude/rootTool.ts): cópia root do helper fora do alcance do danilo,
# pastas de pedido/resposta do danilo, units instaladas/atualizadas só quando mudam.
install -d -m 0755 /usr/local/lib/orion
# Scripts que rodam como root saem de cópias root, nunca de uma pasta que o danilo edita. cp+mv
# (inode novo) porque o bash deste build ainda está lendo o build.sh antigo.
for f in root-run.py build.sh deploy-run.sh; do
  install -m 0755 -o root -g root "$DIR/deploy/$f" "/usr/local/lib/orion/.$f.novo"
  mv -f "/usr/local/lib/orion/.$f.novo" "/usr/local/lib/orion/$f"
done
install -m 0644 -o root -g root "$DIR/deploy/root-perigo.json" /usr/local/lib/orion/.root-perigo.json.novo
mv -f /usr/local/lib/orion/.root-perigo.json.novo /usr/local/lib/orion/root-perigo.json
install -d -m 0770 -o danilo -g orion /srv/root /srv/root/pedidos /srv/root/respostas
MUDOU=
for u in orion-root.service orion-root.path orion-deploy.service orion-wa.service; do
  cmp -s "$DIR/deploy/$u" "/etc/systemd/system/$u" || { install -m 0644 "$DIR/deploy/$u" "/etc/systemd/system/$u"; MUDOU=1; }
done
[ -n "$MUDOU" ] && systemctl daemon-reload
systemctl enable --now orion-root.path || echo "ATENÇÃO: orion-root.path não subiu"
systemctl enable --now orion-wa || echo "ATENÇÃO: orion-wa não subiu"

etapa 'limpeza'
# Mantém os 3 builds mais novos; nunca apaga o que está no ar nem o anterior. Logs e .json ficam (histórico).
for d in $(ls -dt "$BUILDS"/*/ 2>/dev/null | tail -n +4); do
  d=${d%/}
  [ "$d" = "$DIR" ] || [ "$d" = "$ANTERIOR" ] || [ "$d" = "$(readlink -f "$LIVE")" ] || { echo "apagando $d"; rm -rf "$d"; }
done
echo "ok: $NOME no ar"
