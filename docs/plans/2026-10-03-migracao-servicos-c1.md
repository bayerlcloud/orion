# Plano: trazer da c1 para a c3 só o que presta

> 03/10/2026: Danilo cogitou apagar a c1 (86.48.28.10) inteira em poucos dias; em 04/10/2026
> decidiu manter a c1 no ar e migrar um projeto por vez, sem revolução. A triagem abaixo
> continua valendo como mapa do que existe lá e para onde cada coisa vai, só sem prazo.
> Rede de segurança já feita: backup frio em `/srv/migracao/c1-backup-frio/` (dumps do Postgres da
> Evolution e do BayerlPress, volumes de n8n/Evolution/uploads/Caddy, /opt, /root, cron). O
> config do code-server (~17 GB) ficou pela metade quando o Orion reiniciou no meio do turno;
> refazer antes de desligar a c1 de verdade. Arquivos chmod 600: contém /config/.secrets.
>
> Arquitetura decidida em 04/10/2026 (nível 3, "Arquitetura de servidores por papel"): c3 só
> para o Orion; uma VPS nova "clientes" substitui a c1 para Evolution, livekit, CMS e sites
> estáticos; c2 continua com Supabase self-hosted; Hostinger/Coolify para apps em produção.
> Ordem recomendada de migração: 1) SEO, 2) BayerlPress, 3) sites estáticos, 4) livekit
> (depende da VPS de clientes), 5) Evolution (crítico, depende do TM passar a guardar as
> próprias mensagens), 6) família tracking por demanda.

## Triagem da máquina inteira

### Precisa migrar antes do desligamento (vivo, alguém usa)
| Item | Domínio | Destino | Cuidado |
|---|---|---|---|
| Evolution API + Postgres (2,4 GB) + Redis | evo.bayerl.cloud | c3 (docker compose) | instâncias de clientes (5 TM, 3 Brandspace, Orion); levar dump + volume de instâncias, testar se as sessões voltam sem QR, DNS por último |
| BayerlPress CMS + Postgres + uploads | cms.bayerl.cloud | c3 | site do Dr. Alexandre (Laís); dump do banco |
| Sites estáticos de `landing-pages` | bayerl.cloud (apex), studio, buenas, mundomaker, pages, seo | c3 Caddy file_server | rsync simples; apex é a LP institucional |
| seo-engine (processo) | seo.bayerl.cloud/painel-api | c3 systemd | onda 1 abaixo |
| tonavez | tonavez.bayerl.cloud | c3 systemd | confirmar se ainda é usado |
| `/config/.secrets` (57 chaves) | n/a | c3, arquivo root 600 fora de repo | env dos serviços acima |
| cron de cookies do YouTube (academix) | n/a | c3, usando o cofre | o academix já roda na c3 |

### A confirmar com o Danilo
- livekit (livekit.bayerl.cloud responde 200): quem usa?
- container litellm da c1 (o gateway oficial é o da c2): alguém aponta para ele?
- Código parado com valor possível: bayerl-tracker(+edge), bayerl-heat, dc-sync, sirius-brain, scraping/pdf/searxng-service, metodo-central, bayerlsaas, bayerlpress-sites, seo, seo-painel. Vira projeto na c3 ou fica só no backup frio.

### Morre com a c1 (fica só no backup frio)
n8n (1 workflow "WhatsApp Hub - Envio", sem execuções), code-server e previews dev (code, dev, brandspace-prod, wt01, bayerlstudio, ralab), chromium-shared e playwright-mcp (o cofre da c3 substitui), hermes (502), claude-proxy, bayerl-copilot, cron de backup da própria c1.

### Fim
Apagar os A records da c1 na Hostinger: @, agentic, bayerlstudio, brandspace-prod, buenas, claude-proxy, cms, code, dev, evo, hermes, livekit, mundomaker, pages, ralab, seo, sirius-brain, studio, tonavez, workflow, wt01 (os migrados passam a apontar para a c3).

---

# Anexo: levantamento dos serviços soltos (início do dia)

Levantamento feito em 03/10/2026 (workspace do code-server, PM2, cron do host, Caddy da c1, portas vivas).

## Retrato do que roda hoje na c1

Processos vivos dentro do container `stack-code-server-1`:

| Porta | Processo | Domínio | Situação |
|---|---|---|---|
| 3620 | seo-engine (PM2) | seo.bayerl.cloud/painel-api | VIVO, código já em /srv/projects/seo-engine, processo ainda na c1 |
| 3001 | tonavez (PM2) | tonavez.bayerl.cloud | VIVO |
| 8088 | orion v1 (PM2) | orion-antigo.bayerl.cloud | VIVO, recebe /webhook/evolution repassado pela c3 |
| 8082 | ralab vite dev | ralab.bayerl.cloud | VIVO (dev server; ralab já na c3) |

Containers fora do code-server que importam aqui: `bayerlpress` + `bayerlpress-db` (cms.bayerl.cloud, backup diário 04:00), `searxng`, `agentic-redis`.

Serviços com rota no Caddy mas SEM processo (502 ou mortos):

| Pasta | O que é | Porta | Último sinal de vida |
|---|---|---|---|
| bayerl-tracker | gateway de tracking server-side (substituto Stape/sGTM), Meta CAPI + GA4, chat do Malvese | 3560 (bayerl.cloud/px) | evento em 15/09; hoje 502 |
| bayerl-tracker-edge | mesmo tracker como Cloudflare Worker + D1 (px.bayerl.cloud) | n/a | nunca publicado (px sem DNS, wrangler com placeholders) |
| bayerl-heat | heatmap self-hosted (cliques/scroll) | 3558 (mundomaker/hm) | dado em 23/09; hoje 502 |
| mundomaker-leads | captação de leads da LP MundoMaker | 3557 (mundomaker/api, /admin) | lead em 24/08 |
| dc-sync | espelho DataCrazy -> TrackingMachine (tenant DDC) | n/a (poll 90 s) | state.json em 21/09 |
| claude-proxy | assinatura Claude como endpoint OpenAI para edge functions do TM | 3610 | morto |
| agentic | motor de agentes atendimento/vendas/follow-up | 3600 | morto |
| sirius-brain | memória multi-tenant / cérebro (PM2 stopped) | 3200 | stopped |
| scraping-service, pdf-service | browser-as-a-service + proxy de PDF | n/a | sem processo |

### Removido em 04/10/2026
- `sirius-brain`: superado pelo `brandspace-sirius` na c3 (porta 3200), já ativo. A pasta já não existia mais na c1 (removida em migração anterior do Sirius para o Brandspace); só restava o processo PM2 parado, o bloco `sirius-brain.bayerl.cloud` no Caddy e o DNS, todos removidos.
- `claude-proxy`: removido junto com hermes e bayerl-copilot, mesma rodada desta sessão.
- `bayerl-tracker`, `bayerl-tracker-edge`, `bayerl-heat`: apagados por decisão do Danilo, sem migrar (não valiam o esforço). Pastas removidas da c1, backup local em `/srv/migracao/code-server/arquivo/bayerl-tracker-edge-heat-2026-10-04.tgz` (inclui os dados reais: leads do Malvese e eventos do heat do MundoMaker). Bloco `/px/*` tirado do apex `bayerl.cloud` e `/hm/*` tirado do `mundomaker.bayerl.cloud` no Caddy da c1.
- `academix-worker`: pasta movida (convenção, não apagada) para `/root/migrado-c3/academix-worker` na c1; já roda 100% na c3 dentro do Brandspace (`brandspace-academix.service`).
- `bayerlsaas` e `dc-sync`: já não existiam mais na c1 quando fui apagar (o Danilo mesmo apagou pelo code-server, em paralelo, durante esta sessão). `dc-sync` morreu porque o DDC já está dentro do dashboard do FisioExpert. `bayerlsaas` não rodava em VPS nenhuma (Supabase cloud + Lovable), nada a recuperar.
- `mundomaker-leads`: **antes de apagar, verifiquei se os 31 leads precisavam de migração manual para o BayerlPress e não precisavam** — o `cms-sync.mjs` que morava dentro da própria pasta já tinha sincronizado os 31 para a tabela `leads` do BayerlPress (tenant `mundomaker`) em 24/08/2026. Cheguei a inserir os 31 de novo a partir do `leads.jsonl` local, percebi a duplicata pelo e-mail (33 batendo) e desfiz antes de prosseguir. Pasta apagada da c1, backup em `/srv/migracao/code-server/arquivo/mundomaker-leads-2026-10-04.tgz`. Bloco `/api/*` e `/admin*` (porta 3557) tirados do `mundomaker.bayerl.cloud` no Caddy da c1; a landing (`/encontro/*`) continua servindo normalmente, só a captação de lead antiga (evento já encerrado em 26/08) saiu do ar.
- `brandspace`: pasta apagada da c1 (não era mais código fonte de nada, só sobra; produção, Sirius e academix já rodam 100% na c3). Backup gerado direto na c1 (`/root/backups/brandspace-2026-10-04.tgz`, 873 MB) para sobreviver a reinícios do Orion, depois copiado para `/srv/migracao/code-server/arquivo/brandspace-2026-10-04.tgz`.
- `litellm-gateway`: a pasta na c1 era só uma cópia de código; o gateway real roda na c2 e continua intocado, usado de verdade por Brandspace, seo-engine e TrackingMachine. Pasta da c1 apagada, backup em `/srv/migracao/code-server/arquivo/litellm-gateway-2026-10-04.tgz`.
- Lote `ddc-deck-tools`, `docs/superpowers`, `metodo-central`, `node_modules`, `notes`, `openbayerl-stack`:
  - `node_modules` (solto na raiz do workspace) e `docs/superpowers` (vazia): lixo, apagados sem backup.
  - `notes`: já estava vazia desde a remoção do SilverBullet (03/10), nada a fazer.
  - `ddc-deck-tools`: era só o `reindex.py` do deck DDC do Brandspace; trazido para `/srv/projects/brandspace/scripts/ddc-reindex.py` (commitado) e a pasta solta apagada da c1 (backup em `ddc-deck-tools-2026-10-04.tgz`).
  - `metodo-central` e `openbayerl-stack`: mesmo caso do litellm-gateway. `metodo.bayerl.cloud` e `open.bayerl.cloud` rodam de verdade no Coolify da Hostinger (72.61.135.82), confirmados no ar (200) antes e depois. A pasta na c1 era só cópia de trabalho; apagadas com backup em `metodo-central-2026-10-04.tgz` e `openbayerl-stack-2026-10-04.tgz`.
- **BayerlPress já tem motor de captação de lead pronto** (`POST /funnel/start|answer`, widget `/widget/lead.js`, tabela `leads`, dispatch para Meta CAPI/webhook por tenant). O tenant `mundomaker` já existe no banco. Falta, quando o Danilo for mexer na landing: trocar o formulário por esse widget (ou ajustar o funil padrão) e decidir um webhook de saída, se quiser repor o reenvio pro Microsoft Forms que o `mundomaker-leads` fazia.

Já resolvidos: academix-worker roda na c3 (`brandspace-academix.service`, DNS na c3); seo-engine (só o código).

## Não migra como projeto

- `litellm-gateway`: roda na c2; `openbayerl-stack`: IaC do Coolify na Hostinger. Só repositório, podem vir depois como projeto de infra se quiser editar daqui.
- `bayerl-copilot`: extensão do code-server, morre junto com ele (Orion já cobre ditado/alarme).
- `orion` (v1), `hermes`, `notes`, `docs`, `tools`, `pages`, `wp-old`, `scratchpad-*`, `ddc-deck-tools` (um script), `vps-backup` (infra).

## Ondas

Regra de toda onda: código vem pela skill `migrar` (um slug por pasta), `.env` copiado à mão para fora do repo, processo vira unit systemd na c3 (porta 127.0.0.1), bloco no Caddy da c3, DNS A para 217.76.55.249, conferir com curl, só então parar o processo na c1 (nada é apagado lá).

### Onda 1: SEO (único com tráfego vivo)
1. Trazer `seo` e `seo-painel` (slugs próprios).
2. `seo-engine.service` na c3 (porta 3620), `.env` da c1 copiado.
3. Caddy da c3 replica o bloco `seo.bayerl.cloud`: `/painel-api/*` -> 3620, `/painel/*` -> dist do seo-painel, resto -> dist do seo.
4. DNS `seo` -> c3, curl nos três caminhos, `pm2 stop seo-engine` na c1.

### Onda 2: tracking (tudo morto hoje, então sem pressa de corte)
1. Decidir Node (`bayerl-tracker`) ou Edge (`bayerl-tracker-edge`). Recomendação: Edge na Cloudflare (sites de volume nunca tocam a VPS), Node só se o chat do Malvese ainda for usado.
2. Trazer as duas pastas; `data/*.jsonl` (leads do Malvese, eventos) vem junto, fora do git.
3. `bayerl-heat` e `mundomaker-leads`: trazer só se o MundoMaker ainda capta; senão arquivar os JSONL (31 leads) e encerrar.
4. `dc-sync` -> slug `tm-dc-sync`, unit systemd com `DATACRAZY_API_KEY`, se o DDC ainda precisa do espelho.
5. `claude-proxy`: não trazer até confirmar uso; na c3 ele dividiria o limite do Max com o Orion inteiro.

### Onda 3: plataforma
1. `bayerlpress` + `bayerlpress-sites` (cms.bayerl.cloud, container + Postgres + cron de backup): maior risco, precisa dump do banco e janela.
2. `tonavez` (vivo, 211 MB): trazer e subir como unit; DNS por último.
3. `sirius-brain`, `scraping-service`/`pdf-service`/`searxng-service`: só por demanda.
4. `metodo-central`, `bayerlsaas`: por demanda.

### Feito em 03-04/10/2026: agentic migrado
`agentic` já está em `/srv/projects/agentic`, registrado no painel (slug `agentic`), migração concluída em outra sessão. Falta só confirmar na c1 se o processo e o Redis (`agentic-redis`) podem ser desligados e tirar o bloco `agentic.bayerl.cloud` do Caddy/DNS da c1 quando o novo estiver validado.

### Feito em 03/10/2026: Orion v1 e SilverBullet removidos
- Arquivo antes de apagar: `/srv/migracao/code-server/arquivo/orion-v1-2026-10-03.tgz` e `silverbullet-notes-2026-10-03.tgz`.
- c1: `pm2 delete orion`, pasta `workspace/orion` e `orion-knowledge.js` apagados, cron removido, blocos `notas`, `orion` e `orion-antigo` fora do Caddy, container e imagem do SilverBullet removidos, `/opt/stack/notes` esvaziado (a pasta fica porque o code-server ainda monta `./notes`; a linha sai no próximo recreate do code-server).
- c3: repasse `/webhook/evolution*` para o v1 removido do Caddy (nenhuma instância usava). DNS `notas` e `orion-antigo` apagados.
- Notas: `Orion/` e `Global/` em `docs/notas-c1/`; as dos outros projetos esperam em `/srv/migracao/code-server/notas-sb/` para a sessão de cada projeto.

### Limpeza na c1 depois das ondas
- Cron `refresh-cookies-cron.sh` ainda grava cookies do YouTube no academix da c1, mas o academix vivo está na c3: mover o cron para cá ou apontar para a c3.
- 138 processos órfãos `mcp-server-ssh` no code-server somando ~8 GB de RSS (swap da c1 em 4,7 GB): matar libera a máquina já.

### Onda 1 (SEO) concluída em 04/10/2026
- `seo-engine`: serviço systemd na c3 (porta 3620, `.env` trazido), código já estava no painel.
  Tinha 1 arquivo não commitado na c1, mas já estava coberto pela "foto da raiz" anterior.
- `searxng-service`: container `seo-searxng` na c3 (127.0.0.1:8081), config trazida; o seo-engine
  usava para a função de GEO, não dava pra matar sem substituir.
- `seo` e `seo-painel`: trazidos como projetos próprios (slugs `seo`, `seo-painel`), zero mudanças
  não commitadas na c1. Builds publicados em `/srv/sites/seo` e `/srv/sites/seo-painel`.
- Bloco `seo.bayerl.cloud` replicado no Caddy da c3 (`/painel-api/*` -> seo-engine local,
  `/painel/*` -> dist do seo-painel, resto -> dist do seo). DNS trocado, testado com tráfego real
  antes e depois de desligar a c1 (health check, site e painel, todos 200).
- c1: processo PM2 `seo-engine` parado, container `searxng` removido, as 4 pastas apagadas
  (backup em `/srv/migracao/code-server/arquivo/{seo,seo-painel,seo-engine,searxng-service}-2026-10-04.tgz`).

### Lote `.vscode / notes / tools / vps-backup / wp-old` limpo em 04/10/2026
- `.vscode`, `wp-old`: lixo/vazio, apagados sem backup.
- `notes`: já estava vazia desde a remoção do SilverBullet.
- `tools/InstaAnalyser`: ferramenta de verdade (análise de Instagram via Apify), trazida como
  projeto próprio `instaanalyser`. Pasta `tools` apagada da c1 com backup.
- `vps-backup`: era só o código-fonte de dev; o cron real usa `/root/vps-backup` no host,
  independente e intocado. Pasta da c1 apagada com backup.

### code-server apagado em 04/10/2026
- Container `stack-code-server-1` parado e removido. Workspace estava essencialmente vazio
  (3 zips antigos, 1 nota de UI obsoleta, pasta `notes` vazia) — backup em
  `/srv/migracao/code-server/arquivo/workspace-residual-2026-10-04.tgz`.
- Volumes `stack_codeserver_config` (27 GB, quase tudo cache/extensões, conteúdo real já
  extraído ao longo da migração) e `codeserver_config` (órfão, vazio) removidos.
  **Disco da c1 caiu de 82% para 55%.**
- Caddy: blocos `dev.bayerl.cloud`/`code.bayerl.cloud` (a própria IDE) e `wt01.bayerl.cloud`
  (já não tinha nada escutando) removidos. DNS `dev`, `code`, `wt01`, `brandspace-prod` apagados.
- Sobraram ~12 referências a `code-server:PORTA` no Caddyfile da c1, todas órfãs (domínio já
  migrado pro DNS da c3, ou processo já morto) — inofensivas, ficam pra uma limpeza fina depois.
- **`mundomaker.bayerl.cloud` continua no ar**: a landing `/encontro/*` é servida direto pelo
  Caddy a partir de `/srv/pages`, nunca dependeu do container do code-server. Só os endpoints
  dinâmicos `/mundomaker/api` e `/admin` (já mortos desde a remoção do `mundomaker-leads`) ficaram
  ainda mais mortos.
- Testado depois de apagar: mundomaker, buenas, cms, ralab e seo, todos no ar normal.
