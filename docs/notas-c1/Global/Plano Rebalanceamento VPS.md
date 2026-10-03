# Plano de Rebalanceamento de VPSs (C1 -> Hostinger)

> Status: PLANO, nada executado. Auditoria de 2026-09-08.

## 1. Realidade atual (auditada, nao presumida)

| Host | IP | RAM total | RAM disponivel | Swap usado | Load (6/4 vCPU) | Disco livre | Papel |
|---|---|---|---|---|---|---|---|
| **C1** Contabo 1 | 86.48.28.10 | 11.7G | ~3.6G | 8.1G/15G | ~3.5 (picos 10) | 26G (74%) | code-server + stack pessoal |
| **C2** Contabo 2 | 212.47.70.170 | 11.7G | ~3.4G | 3.6G/4G | **10.9** | 45G (54%) | 4x Supabase prod + gateway LLM |
| **Hostinger** | 72.61.135.82 | 15.6G | **9.4G** | 0.16G/19G | **1.0** | 61G (69%) | LLMs (Ollama), Coolify, legado |

**Conclusao central:** C1 e C2 estao AMBOS no talo de RAM/CPU. A premissa antiga "C2 folgado"
(CLAUDE.md, jul/2026) morreu quando o C2 virou host de 4 Supabase + gateway. A unica VPS com
folga real e a **Hostinger** (9.4G RAM livre, CPU ociosa). Portanto:
- Rebalancear = **C1 -> Hostinger**. O C2 nao da nem recebe carga.
- Objetivo real nao e "MB idle": e tirar do C1 os servicos que dao PICO de CPU/RAM (browsers,
  WebRTC), que sao o que compete com os builds do Brandspace e causa os OOM (exit 137).

## 2. Restricoes e principios

- **Hostinger tem 4 vCPU (menos que os 6 do Contabo) e roda os LLMs (Ollama).** Nao empilhar
  carga PESADA de CPU la, senao throttla os modelos. Mover cargas leves-medias.
- **Os 3 hosts estao em datacenters diferentes** (2 Contabo + 1 Hostinger): nao ha rede privada
  entre eles. Comunicacao cross-host = internet publica com TLS/auth, ou tunel WireGuard.
  => Candidato BOM = servico que ja tem front publico proprio (dominio + Caddy + auth) e cujo
  consumo ja e via rede, nao via `localhost`/nome-de-container.
- Cada migracao e **reversivel** e feita **uma por vez**: preparar no destino -> validar ->
  cortar DNS -> so depois desligar na origem. DNS sempre via MCP hostinger (registro A explicito).
- Backup ja cobre os dados (restic); ainda assim, snapshot/rsync do volume antes de mover.

## 3. Candidatos (priorizados por ganho/risco)

### Onda 1 (baixo acoplamento: ja sao publicos, migrar = mudar o A record)

**1.1 chromium-shared** (`browser.bayerl.cloud`, CDP :9222 + noVNC, basic_auth)
- Por que: browser headless, pico de CPU/RAM; a Hostinger ja roda um `chromium-*`.
- Consumo C1: 17M idle, centenas de MB + CPU sob uso.
- Migrar: subir o mesmo container na Hostinger (Coolify ou docker), sem estado a preservar
  (browser efemero). Apontar A `browser` -> 72.61.135.82. Ajustar basic_auth.
- Acoplamento: quem usa? Confirmar na execucao (scraping-service ja e na C2; ver se algo no C1
  chama `chromium-shared` por nome de container -> se sim, passa a chamar via dominio).
- Risco: baixo. Rollback: A record de volta.

**1.2 n8n pessoal** (`workflow.bayerl.cloud`, :5678, volume `stack_n8n_data` 5.6M)
- Por que: automacao isolada, sem dependencia do resto do C1.
- Migrar: a Hostinger JA TEM n8n (da agencia, `n8n-editor-...` via Coolify). Duas opcoes:
  (a) subir uma 2a instancia n8n dedicada (isolar do da agencia) via Coolify; (b) importar os
  workflows no n8n existente. Preferir (a) para nao misturar. Migrar o volume `stack_n8n_data`
  (backup restic ja tem) -> restore no destino. Apontar A `workflow` -> Hostinger.
- Cuidado: `N8N_ENCRYPTION_KEY` tem que vir junto (credenciais dos workflows sao cifradas com
  ela; sem a chave, as credenciais quebram). Esta no compose/env do n8n no C1.
- Risco: medio (chave de cifra + volume). Rollback: A record + religar no C1.

**1.3 livekit** (`livekit.bayerl.cloud`, :7880, config `/opt/stack/livekit/config.yaml`)
- Por que: WebRTC, pico de CPU sob chamada (voz do Brandspace / orion-voice).
- Cuidado: o `orion-voice` (pm2 no code-server do C1) CONECTA no livekit. Se o livekit for pra
  Hostinger, o orion-voice passa a conectar via `livekit.bayerl.cloud` publico (ja e assim? ou
  usa nome interno? confirmar). WebRTC exige portas UDP abertas no firewall da Hostinger.
- So mover se a voz estiver em uso ativo; se estiver ociosa, considerar so desligar no C1.
- Risco: medio (UDP/firewall + cliente orion-voice). Rollback: A record + religar.

### Onda 2 (internos hoje: precisam ser expostos com auth para migrar)

**2.1 Playwright MCP + MCP-p1** (`playwright-mcp:8931`, `playwright-mcp-p1:8932`, internos)
- Por que: 2 browsers headless, 431M idle + picos de Chromium (CPU/RAM) = competem com builds.
- Consumo C1: 240M + 191M idle.
- Migrar: subir os 2 na Hostinger; expor com TLS+auth (Caddy) OU tunel WireGuard C1<->Hostinger.
  Reapontar o `.mcp.json` (playwright / playwright-p1) para a nova URL.
- Cuidado: sao usados pelas sessoes Claude (este ambiente). O p1 tem perfil PERSISTENTE
  (volume `playwright_p1`, login sobrevive) -> migrar o volume junto. Latencia cross-host ok.
- Risco: medio (exposicao publica de browser = superficie; usar auth forte / mTLS / WireGuard).

### Onda 3 (nao e "mover", e "reduzir" no proprio C1, complementar, ganho rapido)

**3.1 Poda de pm2 no code-server** (o code-server sozinho = 5.2G RAM, ~34 processos)
- Ja parados: `abcprime-*` (4), `buenas-new`, `bayerl-site`. `hubla-videos-dl` = errored.
- Acao: `pm2 delete` nos errored/obsoletos; revisar quais precisam ser sempre-online vs
  on-demand (ex: previews). Cada preview Vite ligado = esbuild/node na RAM.
- Ganho: direto na RAM do C1, sem migrar nada. Risco baixo (previews religam sob demanda).
- 🔴 Nao mexer em: `brandspace`/`brandspace-watchdog` (area de outra sessao), `brandspace-prod`,
  `orion`, `sirius-brain`, `seo-engine`, `agentic`, `claude-proxy`, `pdf-service`, `bayerl-tracker`,
  `mm-leads`, `bayerl-heat`, `dc-sync` (producao/uso ativo).

## 4. O que NAO mover (e por que)
- **code-server** (o ambiente onde o Claude roda): e o coracao do C1, nao migra.
- **Evolution + evo-postgres + evo-redis** (WhatsApp): estado de sessao Baileys, canal de alerta
  do backup, muitos consumidores. Fica no C1.
- **Caddy do C1**: proxy de tudo que fica no C1.
- **pdf-service, claude-proxy, bayerl-heat, mm-leads, bayerl-tracker, seo-engine**: pm2 acoplados
  ao ambiente code-server ou consumidos via `localhost` por outros servicos do C1.
- **Qualquer coisa do C2**: C2 esta no talo; nao recebe. Se algo, o C2 e que deveria ALIVIAR
  (ver secao 6).

## 5. Procedimento padrao por servico (template, reversivel)
1. Preparar destino: subir o servico na Hostinger (Coolify de preferencia, ou docker-compose).
2. Migrar estado: restore do volume (do restic ou rsync direto), incluindo chaves de cifra/env.
3. Validar no destino por IP/porta ou dominio de teste, com o servico do C1 ainda no ar.
4. DNS: apontar o A record (MCP hostinger) do subdominio -> 72.61.135.82, TTL 300 na virada.
5. Observar (24h): logs, uso, health. Alerta configurado.
6. Desligar na origem (C1): `docker compose stop <svc>` (nao remover ainda) + tirar do Caddy do C1.
7. So depois de estavel: remover o container/volume antigo no C1 (libera RAM+disco).
8. Rollback a qualquer momento: A record de volta + religar no C1.

## 6. Observacao critica paralela: o C2 tambem esta no talo
Load 10.9 e swap 90% cheio no C2 e problema proprio (4 Supabase + gateway em 6 vCPU). Fora do
escopo deste rebalanceamento (C2 nao recebe carga), mas merece acao separada: avaliar mover 1
Supabase menos usado (ex: `ralab-staging`) para a Hostinger, ou desligar o `ralab-staging` se for
so staging. Isso alivia o C2. Tratar como plano proprio.

## 7. Ordem recomendada de execucao (quando aprovado)
1. Onda 3.1 (poda pm2) primeiro: ganho imediato de RAM no C1, risco minimo, nao depende de nada.
2. Onda 1.1 (chromium-shared): mais simples, valida o fluxo de migracao.
3. Onda 1.2 (n8n) e 1.3 (livekit): com cuidado de chave de cifra / UDP.
4. Onda 2.1 (playwright): so se o ganho justificar a exposicao publica; senao manter no C1.
5. Reavaliar C1 apos cada onda (free -h / load) antes de seguir.
