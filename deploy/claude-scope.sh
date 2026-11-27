#!/bin/bash
# Lança o `claude` de uma sessão do painel num scope próprio do systemd --user (27/11/2026).
#
# Como filho direto do painel, cada processo claude (e todo Bash que ele roda: tsc de 900 MB, vite build de
# 5 GB) entra no cgroup do orion-central e estrangula o painel inteiro. Aqui o runner (server/claude/
# isolamento.ts) aponta o SDK pra este wrapper, que registra um scope fora do serviço com teto de memória
# por sessão e faz `exec` do binário real. Mesmo precedente do deploy.sh (server/integracao/turno.ts).
#
# `exec` duas vezes: o systemd-run --scope também faz exec do comando, então o pid que o SDK criou é o
# próprio claude (Parar/abort continua matando o processo certo, provado na c3 com ps e /proc/pid/cgroup).
# Sem systemd-run ou com o bus do usuário fora do ar, roda direto, como antes.
#
# Env esperado (vem do runner): ORION_CLAUDE_BIN (binário do SDK), ORION_SESSION_ID. Opcionais:
# ORION_SESSAO_MEMMAX (3G), ORION_SESSAO_MEMHIGH (2560M), XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS.
set -u
bin=${ORION_CLAUDE_BIN:?ORION_CLAUDE_BIN ausente}
uid=$(id -u)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$uid}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$uid/bus}

if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  # id curto: primeiro bloco do uuid da sessão, só [a-z0-9]; o pid garante nome único.
  id=${ORION_SESSION_ID:-sem-id}; id=$(printf %s "${id%%-*}" | tr -cd 'a-zA-Z0-9' | cut -c1-12)
  exec systemd-run --user --scope --quiet --collect --unit="orion-sessao-${id:-x}-$$" --slice=orion-sessoes.slice \
    -p "MemoryMax=${ORION_SESSAO_MEMMAX:-3G}" -p "MemoryHigh=${ORION_SESSAO_MEMHIGH:-2560M}" -p CPUWeight=80 \
    -- "$bin" "$@"
fi
exec "$bin" "$@"
