# Plano: trazer o BayerlPress para a c3

Investigação feita em 04/10/2026. Não é um balaio de gato: é um CMS multi-tenant com tracking
próprio, mais uma coleção de sites estáticos que o consomem. A confusão vem de ele ter nascido
perto de ferramentas soltas (seo, bayerl-tracker, bayerl-heat) que, pelo que achei, ele já substituiu.

## O que é, de fato

**`bayerlpress/`** (o motor, monorepo pnpm/turbo):
- `packages/core`: API em Hono + Postgres (`pg`), porta 3333. Rotas: `god` (API de máquina
  para criar tenant/conteúdo, usada por scripts/CI), `public` (conteúdo para os sites buildarem),
  `funnel` (chat de captação), `tracker` (pageview/evento, substituto do bayerl-tracker/heat),
  `widget` (3 scripts JS: `attribution.js`, `lead.js`, `hm.js`, embutidos nos sites), `whatsapp`, `auth`.
  Integrações prontas no código mas **nenhuma configurada** hoje: GA4, Meta CAPI, Google Ads, TikTok.
- `packages/admin`: SPA Vite, o painel em `cms.bayerl.cloud`.
- `packages/shared`: tipos e schemas Zod compartilhados.
- Banco Postgres (`bayerlpress-db`, container), 14 tabelas. Dados reais mas pequenos: 7 tenants,
  55 posts, 47 leads, 66 eventos, 4303 pageviews, 17 mídias. Dump comprimido: 650 KB.
- Deploy: `deploy.sh` com fila (flock), builda local (Mac/code-server) e faz rsync para
  `/opt/bayerlpress` na c1; o container só roda `node dist/index.js`.

**`bayerlpress-sites/`** (irmão do motor, cada site é uma pasta autossuficiente):
- `bayerlcloud`, `bayerlstudio`, `buenas`, `dralexandre`, `malvese` (+ `_template`).
- Cada site builda sozinho (`node build.mjs`, zero dependência) puxando conteúdo do CMS
  **no build**, não em runtime: `cms.bayerl.cloud/api/<tenant>`. Por isso o CMS pode cair que o
  site continua no ar. O HTML final embute os 3 widgets do CMS.
- O resultado do build vai por `rsync` para `/srv/pages/<algo>` na c1 (ex: `dralexandre` publica
  em `pages.bayerl.cloud/dralexandre/`), que é o que o Caddy realmente serve. Então **existem
  duas cópias**: o código-fonte (aqui) e o artefato já publicado (em `/srv/pages`, já mapeado
  no plano geral da c1 como "sites estáticos").

**Tenants no banco hoje:** bayerlstudio (plano "god", é o tenant admin), buenas, malvese,
mundomaker, bayerlcloud, dralexandre, smoke-bayerlpress (teste). Mundomaker tem tenant no CMS
mas o site dele é servido por um worker Node separado (fora do bayerlpress), não por
`bayerlpress-sites/` — ou seja, só uma parte do conteúdo de mundomaker vem daqui.

## Por que parece balaio de gato

`seo`, `seo-painel`, `seo-engine`, `bayerl-tracker`, `bayerl-heat`, `mundomaker-leads` nasceram
soltos ao lado do BayerlPress em épocas diferentes. Tracker e heat estão mortos (502, dado parado
desde ago-set) porque o `tracker.ts` e o `widget.ts` do próprio BayerlPress parecem ter assumido
esse papel. SEO é outra frente (ranqueamento), sem relação direta de código com o motor do CMS.
Migrar o BayerlPress não puxa essas outras peças: elas seguem no plano geral, em ondas separadas.

## Plano de migração (4 passos, pode ir devagar)

### 1. Trazer o código (sem tirar do ar na c1)
- `bayerlpress` e `bayerlpress-sites` pela skill `migrar`, cada um com seu slug.
- `.env` do container (`BP_DB_PASS`, `BP_JWT_SECRET`, `BING_WEBMASTER_API_KEY`) copiado à mão
  para fora do git, igual aos outros projetos.

### 2. Banco e container na c3
- `pg_dump` do `bayerlpress-db` (já testado no backup frio, 650 KB) e restore num Postgres
  novo na c3 (ou schema dentro do `orion-postgres`, a decidir).
- Subir o container `bayerlpress` na c3 apontando para esse banco, porta interna 3333.
- Volume `bayerlpress_uploads` (26 MB) vem junto.

### 3. Trocar o motor sem trocar os sites
- Bloco `cms.bayerl.cloud` no Caddy da c3 -> container novo.
- Como os sites buildam contra `cms.bayerl.cloud/api/<tenant>` (nome, não IP), nada muda nos
  sites estáticos só de mover o motor; eles continuam publicando onde publicam hoje.
- Testar: abrir `cms.bayerl.cloud` (admin), postar um lead de teste pelo tenant
  `smoke-bayerlpress`, conferir que caiu no banco novo.
- Virar DNS de `cms` para a c3. Manter o container da c1 parado (não apagar ainda) por alguns dias.

### 4. Sites (pode ser depois, em outra sessão, por site)
- Para cada site de `bayerlpress-sites`, rodar o build apontando pro CMS já na c3 e publicar o
  artefato num Caddy `file_server` da c3 (mesmo padrão dos outros sites estáticos do plano geral).
- Ordem sugerida pelo risco: `dralexandre` (baixo, time da Laís já mexe), `malvese`,
  `bayerlstudio`, `bayerlcloud`, `buenas` (tem domínio próprio, conferir DNS do
  `buenascarnes.com.br` à parte).

## Feito em 04/10/2026

- Projeto fundido em `/srv/projects/bayerlpress` (um repositório só, slug `bayerlpress` no painel):
  motor na raiz (`packages/*`), sites em `sites/*` (cada um segue autossuficiente, fora do
  workspace pnpm do motor, porque usam bun/zero-dep próprios). Histórico git do bayerlpress-sites
  foi descartado (era raso); o commit de fusão registra a origem.
- Banco restaurado num Postgres próprio na c3 (`bayerlpress-db`, volume `bayerlpress_db`, porta
  só em 127.0.0.1:55433). Dump fresco tirado da c1 antes de restaurar; 7 tenants, 55 posts batendo.
- `.env` em `/srv/projects/bayerlpress/.env` (chmod 600, fora do git): `DATABASE_URL`,
  `JWT_SECRET`, `BING_WEBMASTER_API_KEY`.
- Motor como `bayerlpress.service` (systemd, porta 3333, `MemoryMax=512M`), mesmo padrão do `agentic`.
- Bloco `cms.bayerl.cloud` no Caddy da c3; testado local antes de virar DNS; DNS trocado (tirado
  o A record antigo da c1, deixado só o da c3); certificado emitido; `/api/<tenant>/posts` responde
  com dado real (confirmado com `dralexandre` e `bayerlstudio`).
- **Não migrado ainda:** os sites de `sites/*` continuam buildando e publicando a partir da c1
  (fase 4 do plano). Como eles falam com `cms.bayerl.cloud` pelo nome, já estão lendo do motor
  novo na c3 sem precisar mexer neles.
- Container e banco antigos ficam ligados na c1 por alguns dias, sem nada apontando mais para eles,
  como rede de segurança. Apagar depois de confirmar uma semana estável.

## Fora do escopo deste plano
- `mundomaker-leads`, `bayerl-heat`, `bayerl-tracker(+edge)`: já tratados no plano geral da c1,
  não dependem do BayerlPress.
- `seo` / `seo-painel` / `seo-engine`: onda própria (onda 1 do plano geral), sem relação de
  código com o CMS.
