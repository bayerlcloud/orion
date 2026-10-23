# Projetos de referência (Design) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** aba "Projetos" dentro da página Design, com upload de arquivos/zip por cliente,
usados como referência multimodal (imagens de verdade + texto) ao gerar um design.

**Architecture:** duas tabelas novas (`design_projects`, `design_project_files`) e armazenamento
em disco igual ao Drive; `gerarHtmlReal` passa a receber blocos de conteúdo (texto + imagem) em
vez de uma string, via `prompt: AsyncIterable<SDKUserMessage>` do SDK; `gerarOuAjustarDesign`
monta esses blocos a partir do texto do prompt mais, se o design tiver `project_id`, os arquivos
do projeto.

**Tech Stack:** Fastify + pg, `adm-zip` (nova dependência — zip é formato binário com diretório
central, não dá em poucas linhas sem lib), `@anthropic-ai/claude-agent-sdk` (`SDKUserMessage`
multimodal), React, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-design-projetos-design.md`

## Global Constraints

- Sem limite de quantidade de imagens nem de tamanho de texto por geração, e sem limite de
  tamanho/quantidade de entrada de zip (pedido explícito do Guilherme, 23/10/2026) — risco
  aceito, sem mitigação nesta v1.
- A API de imagem da Anthropic só aceita `image/jpeg`, `image/png`, `image/gif`, `image/webp`
  (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`, `Base64ImageSource`) —
  **`.svg` não é um desses formatos** (é texto/XML). Correção sobre a spec: `.svg` entra no
  balde de TEXTO (o modelo lê o XML direto), nunca como bloco de imagem.
- Arquivo físico em disco sempre com nome único via `randomUUID()` + `safeFilename(basename)`
  (padrão de `server/routes/drive.ts`); o nome "bonito" com pastas do zip fica só no campo
  `nome` do banco.
- Igual ao Drive: `app.pool.query` direto, sem ORM; `preHandler` só checa `req.user` (sem
  `ownerOnly` — é pro time todo); exclusão restrita a autor ou owner (`podeApagar`, já existe
  em `server/routes/design.ts`, reaproveitar).

## Review Focus

- **Zip com entradas que são pastas (sem bytes):** `extrairZip` tem que ignorá-las, não gravar
  linha vazia nem quebrar.
- **Arquivo sem extensão ou extensão desconhecida:** `tipoDeArquivo` devolve `'ignorado'`, não
  lança e não entra no prompt — só fica guardado.
- **`.svg` entra como texto, nunca como bloco de imagem** (ver Global Constraints) — a API
  rejeitaria `media_type` inválido.
- **Gerar design com `project_id` de um projeto sem nenhum arquivo de referência utilizável**
  (só arquivos ignorados, ou projeto vazio): não pode quebrar a geração, só gera sem blocos
  extra.
- **Apagar um projeto que tem designs apontando pra ele** (`designs.project_id`): `ON DELETE
  SET NULL` tem que realmente deixar o design intacto, só perdendo a referência.

---

## Task 1: Dependência, migração e diretório

**Files:**
- Modify: `package.json` (dependência `adm-zip` + `@types/adm-zip`)
- Modify: `server/migrations.ts` (migração `022_design_projects`)

**Interfaces:**
- Produces: tabelas `design_projects(id, user_id, nome, created_at)` e
  `design_project_files(id, project_id, nome, caminho_disco, mime, size, created_at)`;
  `designs.project_id INT REFERENCES design_projects(id) ON DELETE SET NULL`.

- [ ] **Step 1: Instalar a dependência**

Run: `npm install adm-zip && npm install -D @types/adm-zip`
Expected: `package.json` e `package-lock.json` atualizados, sem erro.

- [ ] **Step 2: Adicionar a migração**

No array `MIGRATIONS` de `server/migrations.ts`, depois da entrada `021_designs`:

```ts
{
  id: '022_design_projects',
  sql: `
    CREATE TABLE IF NOT EXISTS design_projects (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id),
      nome TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS design_project_files (
      id SERIAL PRIMARY KEY,
      project_id INT NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      caminho_disco TEXT NOT NULL,
      mime TEXT NOT NULL,
      size BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE designs ADD COLUMN IF NOT EXISTS project_id INT REFERENCES design_projects(id) ON DELETE SET NULL;
  `,
},
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server/migrations.ts
git commit -m "feat(design-projetos): dependência adm-zip e migração das tabelas"
```

---

## Task 2: Classificação de arquivo, extração de zip e montagem de blocos (`server/design/projetos.ts`)

**Files:**
- Create: `server/design/projetos.ts`
- Test: `tests/designProjetos.test.ts`

**Interfaces:**
- Consumes: `DesignQuery` de `./gerar.js` (reexportado por `projetos.ts`, ver Step 3).
- Produces:
  - `export function projectsDir(): string` (env `DESIGN_PROJECTS_DIR`, padrão
    `/srv/design-projects`, igual ao `driveDir()` de `drive.ts`).
  - `export type TipoArquivo = 'imagem' | 'texto' | 'ignorado'`
  - `export function tipoDeArquivo(nome: string): TipoArquivo` — por extensão
    (`path.extname(nome).toLowerCase()`): imagem = `.png .jpg .jpeg .gif .webp`; texto =
    `.css .html .json .md .txt .yml .yaml .svg`; resto = ignorado.
  - `export type MediaTypeImagem = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'`
  - `export function mediaTypeDeImagem(nome: string): MediaTypeImagem | null`
  - `export type EntradaZip = { nome: string; dados: Buffer }`
  - `export function extrairZip(buffer: Buffer): EntradaZip[]` — usa `adm-zip`; `nome` =
    `entry.entryName` (mantém as barras, é só pra exibição); ignora entradas que são pasta
    (`entry.isDirectory`).
  - `export type ConteudoBloco = { type: 'text'; text: string } | { type: 'image'; media_type: MediaTypeImagem; data: string }`
  - `export async function montarBlocosReferencia(query: DesignQuery, projectId: number): Promise<ConteudoBloco[]>`
    — busca `nome, caminho_disco` de `design_project_files WHERE project_id = $1 ORDER BY
    created_at`; pra cada um, `tipoDeArquivo(nome)`: `'imagem'` → lê o arquivo de
    `projectsDir()/caminho_disco`, base64 (`readFile(...).then(b => b.toString('base64'))`),
    bloco `{ type: 'image', media_type: mediaTypeDeImagem(nome)!, data }`; `'texto'` → lê utf8,
    bloco `{ type: 'text', text: `== ${nome} ==\n${conteudo}` }`; `'ignorado'` → pula. Nunca
    lança por um arquivo que falhar ao ler (projeto com arquivo corrompido não pode quebrar a
    geração) — captura e pula esse arquivo.

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  extrairZip, mediaTypeDeImagem, montarBlocosReferencia, tipoDeArquivo, type DesignQuery,
} from '../server/design/projetos.js';

describe('tipoDeArquivo', () => {
  it('classifica imagem, texto e ignorado', () => {
    expect(tipoDeArquivo('logo.png')).toBe('imagem');
    expect(tipoDeArquivo('estilo.css')).toBe('texto');
    expect(tipoDeArquivo('icone.svg')).toBe('texto'); // svg é XML, não vira bloco de imagem
    expect(tipoDeArquivo('documento.pdf')).toBe('ignorado');
    expect(tipoDeArquivo('sem_extensao')).toBe('ignorado');
  });
});

describe('mediaTypeDeImagem', () => {
  it('mapeia extensão pro media_type aceito pela API', () => {
    expect(mediaTypeDeImagem('a.jpg')).toBe('image/jpeg');
    expect(mediaTypeDeImagem('a.png')).toBe('image/png');
    expect(mediaTypeDeImagem('a.svg')).toBeNull();
  });
});

describe('extrairZip', () => {
  it('lista os arquivos de dentro, ignora pastas', () => {
    const zip = new AdmZip();
    zip.addFile('assets/logo.png', Buffer.from('fake-png'));
    zip.addFile('estilo.css', Buffer.from('body{}'));
    zip.addFile('assets/', Buffer.alloc(0)); // entrada de pasta
    const entradas = extrairZip(zip.toBuffer());
    expect(entradas.map(e => e.nome).sort()).toEqual(['assets/logo.png', 'estilo.css']);
  });
});

describe('montarBlocosReferencia', () => {
  it('monta bloco de imagem (base64) e bloco de texto, pula ignorado', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'design-projetos-'));
    process.env.DESIGN_PROJECTS_DIR = dir;
    await writeFile(path.join(dir, 'img.png'), Buffer.from('fake-png-bytes'));
    await writeFile(path.join(dir, 'texto.txt'), 'conteúdo de referência');
    const query: DesignQuery = async () => ({
      rows: [
        { nome: 'logo.png', caminho_disco: 'img.png' },
        { nome: 'notas.txt', caminho_disco: 'texto.txt' },
        { nome: 'planilha.xlsx', caminho_disco: 'nao-existe' },
      ], rowCount: 3,
    });
    const blocos = await montarBlocosReferencia(query, 1);
    expect(blocos).toHaveLength(2);
    expect(blocos.find(b => b.type === 'image')).toMatchObject({ type: 'image', media_type: 'image/png' });
    expect(blocos.find(b => b.type === 'text')).toMatchObject({ type: 'text' });
    expect((blocos.find(b => b.type === 'text') as any).text).toContain('conteúdo de referência');
  });

  it('nunca lança se um arquivo não existir em disco', async () => {
    const query: DesignQuery = async () => ({ rows: [{ nome: 'sumiu.png', caminho_disco: 'nao-existe-mesmo' }], rowCount: 1 });
    await expect(montarBlocosReferencia(query, 1)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/designProjetos.test.ts`
Expected: FAIL (`server/design/projetos.ts` não existe ainda).

- [ ] **Step 3: Implementar `server/design/projetos.ts`**

Seguir as assinaturas do bloco Interfaces acima. `DesignQuery` É REEXPORTADO de `./gerar.js`
(`export type { DesignQuery } from './gerar.js';`) — o teste da Task 2 importa `DesignQuery` de
`projetos.js` diretamente, então precisa estar disponível por ali, não só importado pra uso
interno.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/designProjetos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/design/projetos.ts tests/designProjetos.test.ts
git commit -m "feat(design-projetos): classificação de arquivo, extração de zip e blocos multimodais"
```

---

## Task 3: Geração multimodal (`server/design/gerar.ts`)

**Files:**
- Modify: `server/design/gerar.ts`
- Modify: `tests/designGerar.test.ts` (a assinatura de `GeradorHtml` muda — os mocks hoje
  passam `async (prompt: string) => ...`, precisam virar `async (blocos: ConteudoBloco[]) =>
  ...`)

**Interfaces:**
- Consumes: `ConteudoBloco`, `montarBlocosReferencia` de `./projetos.js` (Task 2).
- Produces (substitui o que já existe no arquivo):
  - `export type GeradorHtml = (blocos: ConteudoBloco[], token: string | null) => Promise<string>`
    (era `(prompt: string, token) => ...`).
  - `gerarHtmlReal` passa a montar `prompt` como `AsyncIterable<SDKUserMessage>` (um gerador
    que emite uma única mensagem com `message.content` = os blocos, no formato da Messages API:
    `{ type: 'text', text }` ou `{ type: 'image', source: { type: 'base64', media_type, data } }`),
    em vez de `prompt: string`.
  - `gerarOuAjustarDesign` ganha mais uma coisa no `SELECT` (`project_id`): monta o texto do
    prompt como hoje (`montarPromptInicial`/`montarPromptAjuste`, sem mudança nelas), e se
    `project_id` não for nulo, chama `montarBlocosReferencia(query, project_id)` e concatena:
    `[{ type: 'text', text: promptTexto }, ...blocosReferencia]`; chama
    `gerador(blocosFinais, token)`.

- [ ] **Step 1: Atualizar os testes existentes pra nova assinatura**

Em `tests/designGerar.test.ts`, trocar os mocks de gerador: onde hoje é
`async () => '<html>novo</html>'` ou `async (p) => { promptRecebido = p; ... }`, o segundo
vira `async (blocos) => { blocosRecebidos = blocos; return '<html>ajustado</html>'; }` e as
asserções de conteúdo do prompt (`toContain('<html>velho</html>')` etc.) passam a checar o
bloco de texto: `(blocosRecebidos.find(b => b.type === 'text') as any).text` em vez da string
direta. Adicionar também:

```ts
it('com project_id: inclui os blocos de referência do projeto depois do texto do pedido', async () => {
  const query: DesignQuery = async (sql) => {
    if (sql.includes('FROM designs')) return { rows: [{ tema: 'tema', html: null, historico: [], project_id: 7 }], rowCount: 1 };
    if (sql.includes('design_project_files')) return { rows: [{ nome: 'ref.txt', caminho_disco: 'x' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  let blocosRecebidos: any[] = [];
  await gerarOuAjustarDesign(query, 1, null, null, async (blocos) => { blocosRecebidos = blocos; return '<html>ok</html>'; });
  expect(blocosRecebidos[0]).toMatchObject({ type: 'text' });
  expect(blocosRecebidos.length).toBeGreaterThan(1);
});
```

(Esse teste usa um arquivo que não existe em disco de propósito — `montarBlocosReferencia`
pula arquivo que falha ao ler, ver Task 2 — então o bloco de referência pode não aparecer; o
que importa aqui é confirmar que `gerarOuAjustarDesign` CHAMA `montarBlocosReferencia` quando
há `project_id`. Ajuste a asserção pra conferir isso via um gerador de blocos falso, se for mais
simples que montar arquivo real em disco: ver Step 3.)

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/designGerar.test.ts`
Expected: FAIL (assinatura antiga não bate mais com os testes atualizados).

- [ ] **Step 3: Implementar as mudanças em `server/design/gerar.ts`**

Importar `type { ConteudoBloco } from './projetos.js'` e `{ montarBlocosReferencia }` — CUIDADO
com import circular: `projetos.ts` (Task 2) só importa o TYPE `DesignQuery` de `gerar.ts`, nunca
uma função; `gerar.ts` importa `montarBlocosReferencia` (função) de `projetos.ts`. Isso evita
ciclo real (só um lado importa valor do outro).

Trocar `query({ prompt, options })` por um gerador assíncrono que emite a `SDKUserMessage`:

```ts
async function* umaMensagem(blocos: ConteudoBloco[]) {
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: blocos.map(b => b.type === 'text'
        ? { type: 'text' as const, text: b.text }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: b.media_type, data: b.data } }),
    },
    parent_tool_use_id: null,
  };
}
```

`gerarHtmlReal` passa a receber `blocos: ConteudoBloco[]` e usar `query({ prompt:
umaMensagem(blocos), options: {...mesmas opções de hoje...} })`.

`gerarOuAjustarDesign`: no `SELECT`, trocar `'SELECT tema, html, historico FROM designs WHERE
id = $1'` por `'SELECT tema, html, historico, project_id FROM designs WHERE id = $1'`; depois
de montar `prompt` (texto, como hoje), montar `blocos: ConteudoBloco[] = [{ type: 'text', text:
prompt }]` e, se `rows[0]?.project_id` existir, `blocos.push(...(await
montarBlocosReferencia(query, rows[0].project_id)))`; chamar `gerador(blocos, token)` no lugar
de `gerador(prompt, token)`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/designGerar.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add server/design/gerar.ts tests/designGerar.test.ts
git commit -m "feat(design-projetos): geração multimodal (texto + imagens de referência)"
```

---

## Task 4: Rotas de projetos (`server/routes/designProjects.ts`)

**Files:**
- Create: `server/routes/designProjects.ts`
- Modify: `server/index.ts` (registrar `designProjectsRoutes`)
- Test: `tests/designProjectsRoutes.test.ts`

**Interfaces:**
- Consumes: `extrairZip`, `projectsDir`, de `../design/projetos.js`; `podeApagar` de
  `./design.js` (Task já existente, reaproveitar em vez de duplicar); `safeFilename` de
  `../driveUtils.js`; `maxFileBytes` de `./drive.js`.
- Produces: `export async function designProjectsRoutes(app: FastifyInstance): Promise<void>`.

Rotas (todas com `preHandler` só autenticação):
- `POST /api/design/projects` `{ nome }`: 400 se `nome` vazio; `INSERT INTO design_projects
  (user_id, nome) VALUES ($1, $2) RETURNING id`; devolve `{ id }`.
- `GET /api/design/projects`: `SELECT p.id, p.nome, p.created_at, u.name AS autor,
  COUNT(f.id)::int AS arquivos FROM design_projects p JOIN users u ON u.id = p.user_id LEFT
  JOIN design_project_files f ON f.project_id = p.id GROUP BY p.id, u.name ORDER BY
  p.created_at DESC`.
- `GET /api/design/projects/:id`: projeto + `SELECT id, nome, mime, size, created_at FROM
  design_project_files WHERE project_id = $1 ORDER BY created_at`; 404 se o projeto não
  existir.
- `POST /api/design/projects/:id/files`: multipart (`req.isMultipart()`, 400 senão); 404 se
  projeto não existe; pra cada `part` de `req.files()`: lê os bytes inteiros (`await
  part.toBuffer()`); se `part.filename` termina em `.zip` (case-insensitive), `extrairZip(buf)`
  e grava uma linha + um arquivo em disco por entrada; senão, grava uma linha + um arquivo só.
  Gravação em disco: `path.join(projectsDir(), `${randomUUID()}-${safeFilename(basename)}`)`
  (mesmo padrão do Drive); `mkdir(projectsDir(), { recursive: true })` antes. Devolve
  `{ arquivos: [...] }` (os criados).
- `DELETE /api/design/projects/:id/files/:fileId`: busca o arquivo + o `user_id` do projeto
  dono; 404 se não existir; 403 se `!podeApagar(req.user!, { user_id: <dono do projeto> })`;
  apaga a linha e o arquivo físico (`unlink`, ignora erro se já não existir).
- `DELETE /api/design/projects/:id`: 404/403 iguais; `DELETE FROM design_projects WHERE id =
  $1` (cascade cuida das linhas de arquivo); apaga os arquivos físicos de todos os arquivos
  do projeto ANTES do DELETE (precisa dos `caminho_disco` primeiro).
- `GET /api/design/projects/:id/files/:fileId/view`: 404 se não existir; serve o arquivo
  (`createReadStream`, `reply.type(mime)`), mesmo padrão de `GET /api/drive/files/:id/view`.

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, it, expect } from 'vitest';
import { podeApagarProjeto } from '../server/routes/designProjects.js';

describe('podeApagarProjeto', () => {
  it('autor do projeto pode apagar', () => {
    expect(podeApagarProjeto({ id: 5, role: 'member' }, { user_id: 5 })).toBe(true);
  });
  it('owner pode apagar projeto de qualquer um', () => {
    expect(podeApagarProjeto({ id: 1, role: 'owner' }, { user_id: 5 })).toBe(true);
  });
  it('member não pode apagar projeto de outra pessoa', () => {
    expect(podeApagarProjeto({ id: 2, role: 'member' }, { user_id: 5 })).toBe(false);
  });
});
```

(Ruling permitido aqui: se ao implementar você perceber que `podeApagar` de `design.ts` já
serve sem adaptação — mesma assinatura `(user, {user_id}) => boolean` — reaproveite-a
diretamente e pule `podeApagarProjeto`; ajuste o teste acima pra importar de `design.js` em vez
de duplicar. Ledger essa decisão.)

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/designProjectsRoutes.test.ts`
Expected: FAIL (`server/routes/designProjects.ts` não existe ainda).

- [ ] **Step 3: Implementar `server/routes/designProjects.ts`**

Seguir o padrão de `server/routes/drive.ts` (upload multipart, `safeFilename`, `randomUUID`,
`maxFileBytes`) e o bloco Interfaces acima.

- [ ] **Step 4: Registrar em `server/index.ts`**

`import { designProjectsRoutes } from './routes/designProjects.js';` junto dos outros imports
de rota; `await app.register(designProjectsRoutes);` junto dos outros `app.register`.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run tests/designProjectsRoutes.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add server/routes/designProjects.ts server/index.ts tests/designProjectsRoutes.test.ts
git commit -m "feat(design-projetos): rotas de CRUD e upload de projetos"
```

---

## Task 5: `project_id` em `POST /api/design`

**Files:**
- Modify: `server/routes/design.ts`
- Modify: `tests/designRoutes.test.ts` (se necessário, ver Step 1)

**Interfaces:**
- Consumes: nada novo (coluna `designs.project_id`, já migrada na Task 1).
- Produces: `POST /api/design` aceita `{ tema, project_id? }` no corpo.

- [ ] **Step 1: Ajustar a rota**

Em `server/routes/design.ts`, o handler `POST /api/design`: tipar o `Body` como `{ tema?:
string; project_id?: number }`; o `INSERT` ganha a coluna `project_id` (`INSERT INTO designs
(user_id, titulo, tema, project_id) VALUES ($1, $2, $3, $4) RETURNING id`, com
`req.body?.project_id ?? null` no lugar). Nenhuma validação extra: se o `project_id` não
existir, a FK do banco recusa o INSERT e a rota devolve 500 — aceitável (ruling: não vale a
pena um SELECT extra só pra devolver 400 bonito aqui, FK já impede dado inconsistente).

- [ ] **Step 2: Typecheck e suíte completa**

Run: `npx tsc --noEmit -p tsconfig.server.json && npx vitest run`
Expected: sem erros, suíte inteira passa (nenhum teste existente deveria quebrar, é um campo
opcional novo).

- [ ] **Step 3: Commit**

```bash
git add server/routes/design.ts
git commit -m "feat(design-projetos): POST /api/design aceita project_id opcional"
```

---

## Task 6: UI — aba Projetos e seletor de referência

**Files:**
- Modify: `web/src/pages/Design.tsx`
- Modify: `web/src/pages/design.css`

**Interfaces:**
- Consumes: `api` de `../api.js`; `confirmar` de `../dialogo.js`.
- Produces: nenhuma interface nova pra outro arquivo (é o topo da árvore).

- [ ] **Step 1: Estado de abas**

`Design.tsx` ganha `const [aba, setAba] = useState<'designs' | 'projetos'>('designs')`; dois
botões/abas no topo trocando o estado; o conteúdo atual (formulário + grade de designs) só
aparece quando `aba === 'designs'`.

- [ ] **Step 2: Tipos e estado de projetos**

```ts
type Projeto = { id: number; nome: string; created_at: string; autor: string; arquivos: number };
type ProjetoArquivo = { id: number; nome: string; mime: string; size: number; created_at: string };
type ProjetoDetalhe = Projeto & { arquivos_lista: ProjetoArquivo[] };
```

Estado: lista de projetos, projeto aberto (detalhe), nome do projeto novo, input de arquivo.

- [ ] **Step 3: Aba Projetos**

Quando `aba === 'projetos'`: formulário "nome do projeto" + botão "criar" (`POST
/api/design/projects`); grade de projetos (nome, autor, contagem de arquivos); clique abre
detalhe (`GET /api/design/projects/:id`) com `<input type="file" multiple>` pro upload
(`POST /api/design/projects/:id/files`, `FormData`, aceita `.zip` e avulso — sem filtro de
`accept` no input, já que "a maioria dos formatos" é o pedido) + grade de arquivos (nome,
tamanho; se `mime` começa com `image/`, `<img src="/api/design/projects/:id/files/:fileId/view">`
pequena) + botão apagar arquivo/projeto (com `confirmar(...)`, igual ao resto da página).

- [ ] **Step 4: Seletor no formulário de gerar**

No formulário de "gerar" (aba Designs): `<select>` opcional "usar projeto como referência"
(`<option value="">nenhum</option>` + um `<option>` por projeto carregado); ao chamar `POST
/api/design`, inclui `project_id: Number(valorSelecionado) || undefined` no corpo.

- [ ] **Step 5: CSS**

Adicionar em `design.css` as classes novas (abas, grade de projetos, grade de arquivos,
miniatura de imagem) seguindo as variáveis já usadas (`var(--line)`, `var(--bg2)`, etc.).

- [ ] **Step 6: Typecheck do front**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/Design.tsx web/src/pages/design.css
git commit -m "feat(design-projetos): aba Projetos e seletor de referência na UI"
```

---

## Task 7: Verificação final

- [ ] **Step 1: Suíte inteira**

Run: `npx vitest run`
Expected: todos os testes (novos e existentes) passam.

- [ ] **Step 2: Typecheck completo**

Run: `npx tsc --noEmit -p tsconfig.server.json && npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 3: Publicar e testar em produção com o modelo real**

Usar as ferramentas `publicar`/`deploy` do MCP orion-publicar. Depois do deploy: criar um
projeto de teste via API (ou UI), subir uma imagem pequena e um `.zip` com 2-3 arquivos,
confirmar que a extração gerou as linhas certas, gerar um design com `project_id` apontando
pro projeto de teste e confirmar (pelo HTML resultante, ou pelos logs) que a geração usou a
referência. Apagar os dados de teste depois.

- [ ] **Step 4: Perguntar se pode seguir no ar**

Reportar o que foi testado e perguntar se fica como está ou se precisa de ajuste antes de
considerar pronto.
