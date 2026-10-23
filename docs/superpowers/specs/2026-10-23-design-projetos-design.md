# Projetos de referência (Design) — spec

Pedido do Guilherme (23/10/2026): dentro do módulo Design, um campo pra subir arquivos de um
cliente (zip ou avulso, "a maioria dos formatos"), pra servir de fonte de referência do design
system do cliente. A IA usa isso de verdade na hora de gerar: imagens entram como referência
visual (multimodal), arquivos de texto entram como contexto.

## Objetivo

Aba "Projetos" dentro da página Design: cada projeto é um cliente/marca, com arquivos soltos
(upload avulso ou .zip descompactado automaticamente). Ao gerar um design novo, a pessoa pode
escolher um projeto como referência; o Orion monta o prompt com as imagens e os textos desse
projeto.

## Escopo

- Projetos e arquivos são do time todo (igual designs), sem dono exclusivo pra visualizar —
  mas só quem criou ou o owner apaga (mesmo padrão de `podeApagar`).
- Upload: qualquer arquivo. `.zip` descompacta automaticamente; os demais entram como estão.
- Referência na geração: imagens (`png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`) via bloco de
  imagem de verdade (multimodal); texto (`css`, `html`, `json`, `md`, `txt`, `yml`, `yaml`)
  via conteúdo inline no prompt. Os demais formatos ficam guardados, mas não entram no prompt
  (fora de escopo ler PDF/Word/Figma nesta v1).
- Sem limite de quantidade de imagens nem de tamanho de texto por geração (pedido explícito do
  Guilherme, 23/10/2026): manda todas as imagens e todo o texto do projeto. Risco aceito:
  projeto grande pode estourar o contexto do modelo ou ficar lento/caro — sem mitigação nesta
  v1.

## Dados

Reaproveita o padrão de armazenamento do Drive (`server/routes/drive.ts`, `driveUtils.ts`):
arquivo físico com nome único em disco, nome de exibição no banco.

Tabela `design_projects`:

| coluna | tipo | nota |
|---|---|---|
| id | serial PK | |
| user_id | int, FK users | criador |
| nome | text | nome do cliente/projeto |
| created_at | timestamptz | |

Tabela `design_project_files`:

| coluna | tipo | nota |
|---|---|---|
| id | serial PK | |
| project_id | int, FK design_projects, ON DELETE CASCADE | |
| nome | text | caminho relativo de exibição (ex.: `logo/principal.svg`, ou só o nome se for upload avulso) |
| caminho_disco | text | nome físico único em disco (`${randomUUID()}-${safeFilename(basename)}`) |
| mime | text | |
| size | bigint | |
| created_at | timestamptz | |

Diretório: `DESIGN_PROJECTS_DIR` (padrão `/srv/design-projects`), um nível só (sem
subpastas em disco; a estrutura do zip vira só o campo `nome`, igual ao Drive já faz pra nomes
com acento/espaço vs. nome físico).

`ALTER TABLE designs ADD COLUMN project_id INT REFERENCES design_projects(id) ON DELETE SET
NULL` — guarda qual projeto foi usado como referência na geração inicial, pra um ajuste
posterior reaproveitar a mesma referência sem precisar escolher de novo. `ON DELETE SET NULL`:
apagar o projeto não apaga o design, só perde a referência (próximo ajuste vira sem imagem).

## Upload e extração de zip

`POST /api/design/projects/:id/files`, multipart. Pra cada parte recebida:
- se o nome termina em `.zip`: descompacta em memória (biblioteca nova `adm-zip` — não tem
  nada parecido instalado; zip é formato binário com diretório central, não dá pra fazer em
  poucas linhas sem lib) e grava uma linha por entrada (pasta dentro do zip vira parte do
  `nome`, ex.: `assets/logo.png`); entradas que são diretório (sem bytes) são ignoradas.
- senão: grava uma linha só, `nome` = nome original do arquivo.

Limite de tamanho: reaproveita `maxFileBytes()` do Drive (2 GB por arquivo, ou
`DRIVE_MAX_BYTES`) — mesmo teto, não cria configuração nova.

## Referência na geração

`POST /api/design` ganha campo opcional `project_id`. Quando vier:
1. Busca os arquivos do projeto (`design_project_files`).
2. Separa por tipo (extensão): imagens vs. texto vs. ignorado (por extensão, ver Escopo).
3. Imagens: lê todas, converte pra base64, monta um bloco
   `{ type: 'image', source: { type: 'base64', media_type, data } }` por imagem.
4. Texto: lê e concatena todo o conteúdo (`nome do arquivo` + conteúdo, um após o outro, sem
   corte).
5. O prompt deixa de ser uma string simples: vira uma mensagem com blocos (texto do pedido +
   blocos de imagem + bloco de texto de referência). O SDK aceita isso via
   `prompt: AsyncIterable<SDKUserMessage>` (um gerador que emite uma única `SDKUserMessage`
   com `message.content` como array de blocos, igual ao formato da Messages API) em vez do
   `prompt: string` usado hoje em `gerarHtmlReal`.
6. Ajuste (`montarPromptAjuste`) também pode levar `project_id` herdado do design (guardado
   na própria linha do design), mesma montagem multimodal.

`gerarHtmlReal` muda de assinatura: recebe blocos de conteúdo (texto + imagens) em vez de só
uma string de prompt; quem chama (`gerarOuAjustarDesign`) monta esses blocos a partir do texto
do prompt atual mais, se houver `project_id` no design, os blocos de referência.

## API

- `POST /api/design/projects` `{ nome }` → cria projeto, devolve `{ id }`.
- `GET /api/design/projects` → lista (`id, nome, created_at, autor`, contagem de arquivos).
- `GET /api/design/projects/:id` → detalhe + lista de arquivos (`id, nome, mime, size,
  created_at`).
- `POST /api/design/projects/:id/files` → multipart, extrai zip, grava arquivo(s).
- `DELETE /api/design/projects/:id/files/:fileId` → remove um arquivo (autor do projeto ou
  owner).
- `DELETE /api/design/projects/:id` → remove o projeto inteiro e os arquivos em disco (autor
  ou owner).
- `GET /api/design/projects/:id/files/:fileId/view` → serve o arquivo bruto (mesmo padrão de
  `/api/drive/files/:id/view`), pra pré-visualizar imagem na UI.
- `POST /api/design` ganha `project_id?: number` no corpo (opcional).

## UI

Aba nova "Projetos" dentro da página Design (`web/src/pages/Design.tsx` ganha abas:
"Designs" / "Projetos", estado local, sem rota nova). Projetos: lista + botão "novo projeto"
(nome) + zona de upload por projeto (arrasta/solta ou escolhe arquivo, aceita `.zip` e avulso)
+ grade de arquivos (miniatura se for imagem, ícone de extensão senão) + apagar arquivo/projeto.

No formulário de gerar design novo: seletor opcional "usar projeto como referência" (lista os
projetos existentes, "nenhum" por padrão).

## Segurança

Upload de zip: biblioteca `adm-zip` lê em memória antes de gravar. Sem limite de tamanho de
entrada nem de quantidade de entradas (pedido explícito do Guilherme, 23/10/2026) — risco
aceito de zip-bomb (disco/memória); sem mitigação nesta v1. Nome de cada entrada passa por
`safeFilename` igual ao Drive (evita `../` na gravação em disco; o caminho "bonito" com pastas
fica só no campo `nome` do banco, nunca vira caminho real em disco) — essa parte é correção de
segurança básica, não um limite de tamanho/quantidade, e fica mantida.

## Testes

- `tests/designProjects.test.ts`: extração de zip (mock do `adm-zip`, confere que cada entrada
  vira uma linha com `nome` = caminho relativo); separação de arquivos por tipo (imagem/texto/
  ignorado); montagem dos blocos multimodais (todas as imagens do projeto viram bloco, todo o
  texto entra concatenado, sem corte); apagar projeto remove os arquivos do disco; autorização
  (autor/owner).

## Fora de escopo (v1)

- Ler conteúdo de PDF, Word, Figma export (`.fig`), fontes — ficam guardados, não entram no
  prompt.
- Subpastas reais em disco (a estrutura do zip vira só texto no campo `nome`).
- Vincular um projeto a vários designs ao mesmo tempo além do campo único `project_id` por
  design (não tem "projetos múltiplos" numa geração só).
- Edição/renomeação de arquivo dentro do projeto.
