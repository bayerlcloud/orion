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
