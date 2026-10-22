# Módulo Design — spec

Pedido do Guilherme (22/10/2026): trazer pro Orion algo parecido com o módulo "Design" do
claude.ai/artifacts (que é feature só do site claude.ai, sem API pública — não dá pra puxar
de lá). Decisão: construir do zero, reaproveitando o motor de IA que o Orion já tem.

## Objetivo

Página nova no menu do Orion onde a pessoa descreve um tema e o Claude gera um HTML
autocontido (design/apresentação), que fica salvo e visível no painel como preview, com
histórico de ajustes.

## Escopo

- Todo o time usa (item novo no menu, como Drive/Tarefas).
- Um tipo de criação só: HTML. Sem as categorias do claude.ai (Apresentação, Sistema de
  design, Design na base de código) — extensível depois, fora do escopo agora.
- Ajuste por instrução (chat curto) sobre o design já gerado.
- Geração em segundo plano (a pessoa não fica travada esperando); front faz polling.
- Exclusão: só quem criou ou o owner.

## Dados

Tabela `designs` (migrations.ts, `CREATE TABLE IF NOT EXISTS`):

| coluna | tipo | nota |
|---|---|---|
| id | serial PK | |
| user_id | int, FK users | criador |
| titulo | text | derivado do tema (reaproveita o padrão de `claude/titulo.ts`) |
| tema | text | pedido original da pessoa |
| html | text, nullable | resultado atual (null enquanto `gerando`) |
| status | text | `gerando` \| `pronto` \| `erro`, check constraint |
| erro | text, nullable | mensagem curta quando `status = erro` |
| historico | jsonb | `[{ role: 'pedido'|'ajuste', texto, ts }]`, cresce a cada geração/ajuste |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Geração e ajuste

Reaproveita o padrão de turno único já usado em `server/claude/titulo.ts` (chamada direta a
`query()` do `@anthropic-ai/claude-agent-sdk`, fora do `Runner`/sessão de chat): `cwd: '/tmp'`,
`maxTurns: 1`, `tools: []`, `permissionMode: 'default'`, `settingSources: []`,
`strictMcpConfig: true`, `mcpServers: {}`, timeout via `AbortController` (90s — HTML pode ser
maior que um título, dar mais fôlego que os 30s do título).

Prompt de sistema fixo: gerar um único arquivo HTML autocontido (CSS e JS inline, sem
dependência externa que possa quebrar — nada de CDN obrigatório), devolver só o HTML, sem
texto em volta.

Pedido inicial: `tema` da pessoa.
Ajuste: contexto = HTML atual + até os últimos N itens do `historico` + instrução nova. O
modelo devolve o HTML revisado inteiro (substitui `html`, mantém o anterior só no histórico
como texto do pedido, não guarda o HTML de cada versão — sem diff/versionamento nesta v1).

Função central: `gerarOuAjustarDesign(pool, id, instrucao | null)` — roda assíncrona (chamada
sem `await` pela rota), grava `status='gerando'` antes de começar, e ao fim grava `html` +
`status='pronto'` ou `status='erro'` + `erro`.

## API (`server/routes/design.ts`, padrão de `drive.ts`)

Hook `preHandler` só autenticação (sem `ownerOnly` — é pro time todo).

- `POST /api/design` `{ tema }` → cria linha (`status='gerando'`), dispara geração sem
  `await`, devolve `{ id }` na hora (202-like, mas 200 simples como o resto do Orion).
- `GET /api/design` → lista (`id, titulo, status, created_at, user_id`, nome do autor via
  join), mais recente primeiro.
- `GET /api/design/:id` → detalhe completo (inclui `html` e `historico`).
- `POST /api/design/:id/ajustar` `{ instrucao }` → só se `status != 'gerando'`; grava
  `status='gerando'`, dispara ajuste sem `await`.
- `DELETE /api/design/:id` → 403 se `req.user.id != design.user_id` e `role != 'owner'`.
- `GET /api/design/:id/preview` → `reply.type('text/html').send(html)`; 404 se não existir
  ou `html` nulo.

## Segurança

HTML gerado por IA é conteúdo não confiável (pode vir com script indesejado, de propósito ou
por injeção no prompt). `GET /api/design/:id/preview` é consumido num
`<iframe sandbox="allow-scripts">` **sem** `allow-same-origin` — isola o HTML numa origem
opaca, sem acesso a cookie/sessão do Orion mesmo sendo servido do mesmo domínio.

## Front (`web/src/pages/Design.tsx`, padrão de `Drive.tsx`)

- Formulário: textarea de tema + botão "gerar".
- Grade de cards: título, status (badge), data, autor.
- Polling: `setInterval` 3s enquanto a lista tiver algum item `status='gerando'`; para quando
  não tiver mais.
- Clique abre detalhe: iframe grande (sandbox), campo de ajuste + botão, histórico de pedidos
  abaixo, botão apagar (só visível se autor ou owner).
- Registro em `App.tsx` (menu, lazy import, rota) e ícone novo em `icons.tsx`, igual aos
  demais itens do menu.

## Testes

- `tests/design.test.ts`: geração (mock da `query()`) grava `html`/`status` certos; ajuste
  usa contexto do histórico; erro de geração grava `status='erro'`; exclusão recusa quem não
  é autor nem owner; preview serve `text/html` e 404 quando não existe.

## Fora de escopo (v1)

- Categorias tipo claude.ai (Apresentação, Sistema de design, código).
- Versionamento/diff de HTML entre ajustes.
- Exportar pra PDF/PPTX.
- Compartilhar fora do Orion (link público).
