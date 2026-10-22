# Módulo Design — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** página nova "Design" no Orion onde a pessoa descreve um tema, o Claude gera um HTML
autocontido em segundo plano, e o resultado fica salvo com histórico de ajustes.

**Architecture:** tabela `designs` nova; geração/ajuste reaproveitam o padrão de turno único
já usado em `server/claude/titulo.ts` (chamada direta a `query()` do SDK, fora da sessão de
chat), disparada sem `await` pela rota (fire-and-forget) pra não travar a resposta; front faz
polling enquanto algum item estiver `gerando`.

**Tech Stack:** Fastify + pg (server), React + `web/src/api.ts` (front), `@anthropic-ai/claude-agent-sdk` `query()`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-design-module-design.md`

## Global Constraints

- HTML gerado é conteúdo não confiável: preview SEMPRE em `<iframe sandbox="allow-scripts">` sem `allow-same-origin`.
- Geração/ajuste nunca bloqueia a resposta HTTP (rota dispara sem `await`, como `server/routes/claude.ts:662` já faz com `tituloCurto`).
- Timeout de geração: 90s (`AbortController`), mesmo padrão de `titulo.ts` (que usa 30s).
- Exclusão: só `design.user_id === req.user.id` ou `req.user.role === 'owner'`.
- Um tipo de criação só (HTML). Sem categorias, sem versionamento de HTML, sem export PDF/PPTX, sem link público — fora do escopo desta v1 (ver spec).

## Review Focus

- **Tema vazio ou só espaço:** `POST /api/design` com `tema` vazio deve recusar com 400, não criar linha nem disparar geração.
- **Ajuste enquanto já está gerando:** `POST /api/design/:id/ajustar` chamado com o design ainda em `status='gerando'` deve recusar (409), pra não disparar duas gerações concorrentes sobre a mesma linha.
- **Geração que falha (exceção ou timeout):** a linha tem que terminar em `status='erro'` com mensagem curta em `erro`, nunca ficar presa em `gerando` para sempre nem apagar o `html` anterior (em caso de ajuste que falha, mantém o HTML anterior).
- **Preview de id inexistente ou ainda sem html:** `GET /api/design/:id/preview` com id que não existe, ou `html` ainda `null` (status `gerando`/`erro`), devolve 404 — nunca manda `text/html` vazio ou quebrado pro iframe.
- **Apagar design de outra pessoa:** usuário comum tentando `DELETE` um design que não é seu (e não é owner) recebe 403 e a linha continua no banco.

---

## Task 1: Tabela `designs`

**Files:**
- Modify: `server/migrations.ts` (adicionar entrada no array `MIGRATIONS`, id `021_designs`)

**Interfaces:**
- Produces: tabela `designs(id SERIAL PK, user_id INT NOT NULL REFERENCES users(id), titulo TEXT NOT NULL, tema TEXT NOT NULL, html TEXT, status TEXT NOT NULL DEFAULT 'gerando' CHECK (status IN ('gerando','pronto','erro')), erro TEXT, historico JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`

- [ ] **Step 1: Adicionar migração**

No array `MIGRATIONS` de `server/migrations.ts`, depois da entrada `020_chat_orion`, adicionar:

```ts
{
  id: '021_designs',
  sql: `
    CREATE TABLE IF NOT EXISTS designs (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id),
      titulo TEXT NOT NULL,
      tema TEXT NOT NULL,
      html TEXT,
      status TEXT NOT NULL DEFAULT 'gerando' CHECK (status IN ('gerando', 'pronto', 'erro')),
      erro TEXT,
      historico JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `,
},
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add server/migrations.ts
git commit -m "feat(design): migração da tabela designs"
```

---

## Task 2: Geração/ajuste de HTML (`server/design/gerar.ts`)

**Files:**
- Create: `server/design/gerar.ts`
- Test: `tests/designGerar.test.ts`

**Interfaces:**
- Consumes: `sdkEnv` de `../settings.js` (mesmo helper que `titulo.ts` usa).
- Produces:
  - `export type DesignQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>`
  - `export type HistoricoItem = { role: 'pedido' | 'ajuste'; texto: string; ts: string }`
  - `export type GeradorHtml = (prompt: string, token: string | null) => Promise<string>`
  - `export const gerarHtmlReal: GeradorHtml`
  - `export function montarPromptInicial(tema: string): string`
  - `export function montarPromptAjuste(htmlAtual: string, historico: HistoricoItem[], instrucao: string): string`
  - `export async function gerarOuAjustarDesign(query: DesignQuery, id: number, instrucao: string | null, token: string | null, gerador?: GeradorHtml): Promise<void>` — nunca lança (captura erro internamente e grava `status='erro'`).

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, it, expect } from 'vitest';
import { gerarOuAjustarDesign, montarPromptAjuste, montarPromptInicial, type DesignQuery, type HistoricoItem } from '../server/design/gerar.js';

function fakePool(estado: { html: string | null; status: string; historico: HistoricoItem[] }) {
  const updates: any[] = [];
  const query: DesignQuery = async (sql, params) => {
    if (sql.startsWith('SELECT')) return { rows: [estado], rowCount: 1 };
    updates.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  return { query, updates };
}

describe('montarPromptInicial', () => {
  it('inclui o tema literal', () => {
    expect(montarPromptInicial('cartão de visita minimalista')).toContain('cartão de visita minimalista');
  });
});

describe('montarPromptAjuste', () => {
  it('inclui o html atual, o histórico e a instrução nova', () => {
    const p = montarPromptAjuste('<html>X</html>', [{ role: 'pedido', texto: 'tema A', ts: '2026-01-01' }], 'deixa o fundo escuro');
    expect(p).toContain('<html>X</html>');
    expect(p).toContain('tema A');
    expect(p).toContain('deixa o fundo escuro');
  });
});

describe('gerarOuAjustarDesign', () => {
  it('pedido inicial: grava html, status pronto e acrescenta ao histórico', async () => {
    const { query, updates } = fakePool({ html: null, status: 'gerando', historico: [] });
    await gerarOuAjustarDesign(query, 1, null, null, async () => '<html>novo</html>');
    const upd = updates.find(u => u.sql.includes("status = 'pronto'"));
    expect(upd.params).toContain('<html>novo</html>');
  });

  it('ajuste: usa o html atual no prompt do gerador', async () => {
    const { query } = fakePool({ html: '<html>velho</html>', status: 'pronto', historico: [{ role: 'pedido', texto: 'tema', ts: '2026-01-01' }] });
    let promptRecebido = '';
    await gerarOuAjustarDesign(query, 1, 'deixa mais escuro', null, async (p) => { promptRecebido = p; return '<html>ajustado</html>'; });
    expect(promptRecebido).toContain('<html>velho</html>');
    expect(promptRecebido).toContain('deixa mais escuro');
  });

  it('erro do gerador: grava status erro e mensagem, nunca lança', async () => {
    const { query, updates } = fakePool({ html: null, status: 'gerando', historico: [] });
    await expect(gerarOuAjustarDesign(query, 1, null, null, async () => { throw new Error('timeout'); })).resolves.toBeUndefined();
    const upd = updates.find(u => u.sql.includes("status = 'erro'"));
    expect(upd.params.join(' ')).toContain('timeout');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/designGerar.test.ts`
Expected: FAIL (`server/design/gerar.ts` não existe ainda).

- [ ] **Step 3: Implementar `server/design/gerar.ts`**

- `montarPromptInicial(tema)`: instrução fixa pedindo "gere um único arquivo HTML autocontido (CSS e JS inline, sem dependência externa obrigatória), devolva só o HTML, sem texto em volta, para o pedido a seguir" + o `tema`.
- `montarPromptAjuste(htmlAtual, historico, instrucao)`: mesma instrução fixa adaptada pra "ajuste o HTML a seguir conforme o pedido novo, devolva o HTML completo revisado"; inclui `htmlAtual`, os `texto` dos itens de `historico` (resumidos, um por linha) e a `instrucao` nova.
- `gerarHtmlReal: GeradorHtml`: mesmo padrão de `tituloCurto` em `server/claude/titulo.ts` — `query()` com `cwd: '/tmp'`, `maxTurns: 1`, `tools: []`, `permissionMode: 'default'`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `plugins: []`, `skills: []`, `env: { ...(sdkEnv(token) ?? process.env), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }`, `abortController` com timeout de 90_000ms; concatena os blocos de texto da resposta; extrai só o HTML (se vier cercado por ```html ou ```, tira a cerca).
- `gerarOuAjustarDesign(query, id, instrucao, token, gerador = gerarHtmlReal)`:
  1. se `instrucao` é `null`: busca `tema` da linha (`SELECT tema FROM designs WHERE id = $1`) e monta prompt com `montarPromptInicial`; senão busca `html, historico` (`SELECT html, historico FROM designs WHERE id = $1`) e monta com `montarPromptAjuste`.
  2. chama `gerador(prompt, token)` dentro de `try/catch`.
  3. sucesso: `UPDATE designs SET html = $2, status = 'pronto', historico = historico || $3::jsonb, updated_at = now() WHERE id = $1`, com o novo item de histórico (`role: instrucao ? 'ajuste' : 'pedido'`, `texto`: a instrução ou o tema, `ts: new Date().toISOString()`).
  4. erro: `UPDATE designs SET status = 'erro', erro = $2, updated_at = now() WHERE id = $1` (mensagem do `Error`, cortada em 300 caracteres).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/designGerar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/design/gerar.ts tests/designGerar.test.ts
git commit -m "feat(design): geração e ajuste de HTML via turno único do SDK"
```

---

## Task 3: Rotas (`server/routes/design.ts`)

**Files:**
- Create: `server/routes/design.ts`
- Modify: `server/index.ts` (importar e registrar `designRoutes`)
- Test: `tests/designRoutes.test.ts`

**Interfaces:**
- Consumes: `DesignQuery`, `gerarOuAjustarDesign` de `../design/gerar.js`; `getSetting`, `KEYS` de `../settings.js`.
- Produces: `export function podeApagar(user: { id: number; role: string }, design: { user_id: number }): boolean` (exportada separada pra testar sem subir o Fastify); `export async function designRoutes(app: FastifyInstance): Promise<void>`.

Rotas (todas com `preHandler` checando só `req.user` — sem `ownerOnly`, é pro time todo):
- `POST /api/design` `{ tema }`: 400 se `tema` vazio/só espaço; senão `INSERT INTO designs (user_id, titulo, tema) VALUES ($1, $2, $3) RETURNING id` (`titulo` = `tema.trim().slice(0, 60)`); dispara `void getSetting(app.pool, KEYS.claudeToken).then(tk => gerarOuAjustarDesign(query, id, null, tk))` (mesmo idioma de `server/routes/claude.ts:662`); devolve `{ id }`.
- `GET /api/design`: `SELECT d.id, d.titulo, d.status, d.created_at, u.name AS autor FROM designs d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC`.
- `GET /api/design/:id`: linha completa (inclui `html`, `historico`, `erro`); 404 se não existir.
- `POST /api/design/:id/ajustar` `{ instrucao }`: 404 se não existir; 400 se `instrucao` vazia; 409 se `status === 'gerando'`; senão `UPDATE designs SET status = 'gerando' WHERE id = $1`, dispara `gerarOuAjustarDesign(..., instrucao, ...)`, devolve `{ ok: true }`.
- `DELETE /api/design/:id`: 404 se não existir; 403 se `!podeApagar(req.user, design)`; senão `DELETE FROM designs WHERE id = $1`.
- `GET /api/design/:id/preview`: 404 se não existir ou `html` é `null`; senão `reply.type('text/html').send(html)`.

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, it, expect } from 'vitest';
import { podeApagar } from '../server/routes/design.js';

describe('podeApagar', () => {
  it('autor pode apagar o próprio design', () => {
    expect(podeApagar({ id: 5, role: 'member' }, { user_id: 5 })).toBe(true);
  });
  it('owner pode apagar design de qualquer um', () => {
    expect(podeApagar({ id: 1, role: 'owner' }, { user_id: 5 })).toBe(true);
  });
  it('member não pode apagar design de outra pessoa', () => {
    expect(podeApagar({ id: 2, role: 'member' }, { user_id: 5 })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/designRoutes.test.ts`
Expected: FAIL (`server/routes/design.ts` não existe ainda)

- [ ] **Step 3: Implementar `server/routes/design.ts`**

Seguir o padrão de `server/routes/drive.ts` (hook `preHandler` só autenticação, handlers com `app.pool.query` direto). `podeApagar` como função pura exportada, usada dentro da rota `DELETE`.

- [ ] **Step 4: Registrar a rota em `server/index.ts`**

Adicionar `import { designRoutes } from './routes/design.js';` junto dos outros imports de rota, e `await app.register(designRoutes);` junto dos outros `app.register(...Routes)`.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run tests/designRoutes.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add server/routes/design.ts server/index.ts tests/designRoutes.test.ts
git commit -m "feat(design): rotas de CRUD, geração e ajuste"
```

---

## Task 4: Página "Design" no front

**Files:**
- Create: `web/src/pages/Design.tsx`
- Create: `web/src/pages/design.css`
- Modify: `web/src/icons.tsx` (adicionar `IcoDesign`)
- Modify: `web/src/App.tsx` (menu, rota, `KEEP`)

**Interfaces:**
- Consumes: `api` de `../api.js` (mesmo wrapper usado em `Drive.tsx`); `confirmar` de `../dialogo.js` pro apagar (regra do painel: nunca `confirm()` nativo).
- Produces: `export default function Design({ user }: { user: User }): JSX.Element`.

- [ ] **Step 1: Ícone `IcoDesign` em `web/src/icons.tsx`**

Seguir o padrão das outras (`export const IcoDesign = ({ size, className }: P) => <svg {...b(size)} className={className}>...</svg>;`), um ícone simples de "paleta" ou "quadro" (dois retângulos sobrepostos, por exemplo).

- [ ] **Step 2: Implementar `web/src/pages/Design.tsx`**

Seguindo a estrutura de `web/src/pages/Drive.tsx`:
- Estado: lista de designs (`id, titulo, status, created_at, autor`), item aberto (detalhe completo), campo de tema novo, campo de instrução de ajuste, `busy`, `msg`.
- `useEffect` inicial: carrega a lista (`GET /api/design`).
- Polling: `useEffect` com `setInterval` de 3s que recarrega a lista SE algum item tiver `status === 'gerando'`; limpa o intervalo quando não tiver mais nenhum.
- Formulário topo: textarea de tema + botão "gerar" → `POST /api/design`, limpa o campo, recarrega lista.
- Grade de cards: título, badge de status, data, autor; clique abre o detalhe (`GET /api/design/:id`).
- Detalhe: `<iframe sandbox="allow-scripts" src={\`/api/design/${id}/preview\`} />` (só quando `status === 'pronto'`; enquanto `gerando`, mostra "gerando…"; se `erro`, mostra a mensagem), campo de ajuste + botão "ajustar" (`POST /api/design/:id/ajustar`), histórico listado abaixo, botão "apagar" (só se `user.id === item.user_id || user.role === 'owner'`) que chama `confirmar(...)` antes do `DELETE`.

- [ ] **Step 3: CSS `web/src/pages/design.css`**

Reaproveitar classes/variáveis já usadas em `drive.css` (grid de cards, cores do tema) — import no topo de `Design.tsx` (`import './design.css';`).

- [ ] **Step 4: Registrar em `web/src/App.tsx`**

- Import lazy: `const Design = lazy(() => import('./pages/Design'));`
- Menu (`MENU`, antes de `Drive` ou depois de `Tools` — sem `ownerOnly`): `{ to: '/design', label: 'Design', Icon: IcoDesign }`
- `KEEP`: `{ path: '/design', el: <Design user={user} /> }`
- Import do ícone em `IcoArquivos, IcoClaude, ...` (acrescentar `IcoDesign`).

- [ ] **Step 5: Typecheck do front**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Design.tsx web/src/pages/design.css web/src/icons.tsx web/src/App.tsx
git commit -m "feat(design): página Design no painel"
```

---

## Task 5: Verificação final

- [ ] **Step 1: Rodar a suíte inteira**

Run: `npx vitest run`
Expected: todos os testes (incluindo os novos) passam.

- [ ] **Step 2: Typecheck completo (server + front)**

Run: `npx tsc --noEmit -p tsconfig.server.json && npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 3: Publicar na raiz (preview) e checar visualmente**

Usar a ferramenta `publicar` do MCP orion-publicar (nunca `git push`/`vite build` manual). Depois, abrir `/design` no preview e testar: gerar um design, ver ele aparecer `gerando` → `pronto`, abrir o preview, pedir um ajuste, apagar.

- [ ] **Step 4: Perguntar se pode dar deploy**

Só depois da checagem visual: perguntar "Posso publicar na raiz?" / confirmar deploy, conforme a regra do painel.
