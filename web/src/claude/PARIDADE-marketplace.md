# Paridade — trilha par/marketplace (29/09/2026)

Anexo do PARIDADE.md (arquivo separado de propósito: várias trilhas paralelas editando o PARIDADE.md
principal dariam conflito garantido; o integrador anexa). Duas janelas grandes do inventário da
seção 13 portadas nesta trilha, lendo a referência canônica em `/srv/orion-reference-2.1.283/`
(webview/index.js e index.css minificados): o diálogo **Manage Plugins** (plugins + marketplaces),
a lista de **servidores MCP** e o menu/assistente de **Output styles**.

## 1. Marketplace de plugins ("Gerenciar plugins")

### O que a extensão real tem (webview v2.1.283, decompilado)

- Um diálogo `overlay`+`dialog` com título **"Manage Plugins"**, `tabBar` com abas **Plugins** e
  **Marketplaces** (badge de contagem na aba), e aviso "Restart Claude to apply plugin changes".
- Métodos da conexão: `listPlugins({includeAvailable})`, `listMarketplaces()`,
  `installPlugin(id, scope)`, `uninstallPlugin(id)`, `updatePlugin(id, scope)`,
  `setPluginEnabled(id, enabled)`, `addMarketplace(source)`, `removeMarketplace(id)`,
  `refreshMarketplace(id)`, `reloadPlugins()` — todos requests pro processo da extensão
  (`{type:"install_plugin"}` etc.).
- Aba Marketplaces: formulário `addMarketplaceForm` (input com placeholder
  `"GitHub repo, URL, or path…"` + botão `Add`/`Adding…`), empty state
  `"No marketplaces configured. Add one above to discover plugins."`, lista `pluginList` com
  `pluginItem` por marketplace (nome + badge `officialBadge` com title
  `"Official Claude Code marketplace"`, descrição/link da fonte `Source:`), ações com
  `ariaLabel:"Refresh marketplace"` e `"Remove marketplace"`/`"Removing…"`.
- Aba Plugins: busca (`searchContainer`/`searchInput`), seção **Available** (plugins dos
  marketplaces ainda não instalados), instalação com `scopeSelector` e o AVISO de confiança
  (`scopeWarning`): "Make sure you trust a plugin before installing… Anthropic does not control
  what MCP servers, files, or other software are included in plugins…", botões de
  atualizar/desinstalar (`"Uninstall and remove plugin"`), dot de estado
  (`statusDotEnabled`/`statusDotDisabled`).
- Servidores MCP: OUTRO diálogo (`mcpServerList`/`mcpServerItem`, status
  `connected`/`failed`/`needs-auth`/`pending`, `serverDetail` com `"← Back to list"`, formulário
  "Add MCP server", `"No MCP servers configured."`).

### O que o Orion tem por baixo (e por que a porta é DIFERENTE da real)

A extensão real gerencia o `~/.claude` de UM usuário. O Orion é multi-usuário com um único login
Linux (danilo) — a sessão Base (main `690b817`) já tinha resolvido isso assim:

- Plugins instalados ficam no **catálogo do sistema**: `/srv/claude/catalog/plugins/<nome>`
  (cada um com `.claude-plugin/plugin.json`).
- A composição POR PESSOA (`server/tools/skillPrefs.ts`) monta `/srv/claude/compose/<user_id>` a
  cada turno e entrega ao SDK via `Options.plugins` + `disallowedTools` (`Skill(plugin:nome)` pra
  skill desligada). Preferências em `skill_prefs` (pessoa > padrão "todos" do admin > ligada).

A UI portada monta o diálogo real EM CIMA dessa infra (um painel, três abas — mesmo precedente do
SkillsHooksPanel, que já fundiu dois diálogos reais em um painel com abas):

- **Plugins** (`GET /api/claude/marketplace/plugins`): os plugins do catálogo, com descrição/versão/
  autor do `plugin.json`, contagem de skills/commands/agents (da MESMA varredura `scanRaiz` que a
  composição usa) e o estado por pessoa. O `setPluginEnabled` real virou
  `PUT /api/claude/marketplace/plugins/:nome` gravando a chave **`plugin:<nome>`** em `skill_prefs`
  (escopo "eu" qualquer usuário; "todos" só admin — igual à aba Tools).
  `planoDeComposicao` ganhou UMA linha: plugin com `plugin:<nome>` efetivamente `false` pra pessoa
  não carrega (nem hooks), mesmo com skills individualmente ligadas. Testes em
  `tests/marketplace.test.ts` (precedência pessoa > todos inclusa).
- **Marketplaces** (`GET/POST/DELETE /api/claude/marketplace/marketplaces`, `POST …/:nome/refresh`):
  a lista vem de `~/.claude/plugins/known_marketplaces.json` + o
  `.claude-plugin/marketplace.json` clonado de cada um (nome, descrição, fonte, plugins
  oferecidos). Mutações rodam o CLI real: `claude plugin marketplace add|remove|update` — via
  `execFile` com array de args e **whitelist de subcomandos** (`server/tools/marketplace.ts`,
  `runClaudePlugin`), NUNCA shell arbitrário. Só admin.
- **Instalar** (`POST /api/claude/marketplace/install`, só admin, com diálogo de confirmação na UI
  contendo o aviso de confiança do `scopeWarning` real traduzido): `claude plugin install
  nome@marketplace` (SEM `-y`: se o marketplace declara comando de instalação, o CLI recusa e a
  recusa aparece crua pro admin — nunca aceitamos comando declarado automaticamente), cópia de
  `~/.claude/plugins/cache/<mp>/<plugin>/<versão mais nova>` pro catálogo, e `claude plugin
  uninstall` de volta (melhor esforço) pra casa do danilo ficar limpa — a ativação é da preferência
  por pessoa, não do settings dele.
- **Servidores MCP** (`GET /api/claude/marketplace/mcp`): a lista real `mcpServerList` + detalhe
  `serverDetail` ("← Voltar pra lista"), montada do que o runner REALMENTE injeta em toda sessão
  (`turnMcpServers` em `server/routes/claude.ts`): os 8 MCPs da Hostinger (com token em
  Configurações), um GitHub e um Cloudflare por conta da aba Tools, e o `orion-memory` (em
  processo, sempre). Tokens nunca aparecem.

### Fontes de validação (`server/tools/marketplace.ts`, testadas)

- `nomeValido`: `[A-Za-z0-9][A-Za-z0-9._-]{0,99}` — nada de `/`, espaço, `;` etc.
- `fonteValida`: `dono/repo` do GitHub ou URL git **https**. O charset estreito é a barreira de
  injeção; caminho local é recusado de propósito (no placeholder real existe "path", mas aqui
  seria leitura de qualquer pasta do servidor por quem tem o painel).
- `ehOficial`: fonte sob `anthropics/` ganha o badge (title "Marketplace oficial do Claude Code").

### Simplificações deliberadas (documentadas, upgrade path claro)

1. **Sem "Restart Claude to apply plugin changes"**: cada turno recompõe a sessão do zero
   (`composicaoPara` roda a cada turno, cache de 30 s) — não existe processo vivo pra reiniciar.
2. **Sem `scope` user/project na instalação** (o `scopeSelector` real): o destino é sempre o
   catálogo compartilhado; o escopo de VERDADE é o liga/desliga por pessoa.
3. **Status MCP é "configurado", não connected/failed ao vivo**: o estado vivo só existe dentro de
   uma Query rodando (`mcp_status` control request). Upgrade: pedir `mcpServerStatus()` numa sessão
   ativa e cruzar com a lista. Sem formulário "Add MCP server" na UI: os canais de adicionar MCP do
   Orion já existem e são as contas da aba Tools + token Hostinger em Configurações (cada um com
   validação própria) — um formulário genérico duplicaria isso com menos validação.
4. **`claude plugin uninstall` pós-cópia é melhor esforço**: se falhar, sobra um plugin habilitado
   no settings do danilo (efeito: skills dele apareceriam duplicadas na aba Tools até limpar à
   mão). A cópia no catálogo, que é o que importa, já aconteceu.
5. **Remover marketplace não remove plugins já copiados** pro catálogo (o real também não
   desinstala plugins ao remover o marketplace; ele só some da lista de fontes).

## 2. Output styles

### Investigação (como o Claude Code representa)

- **Arquivo**: estilo custom = `.md` com frontmatter em `~/.claude/output-styles/` (usuário) ou
  `.claude/output-styles/` (projeto). O identificador é o NOME DO ARQUIVO sem `.md` (por isso o
  help real do assistente: "Shows in the Output styles menu and becomes the file name"). Chaves de
  frontmatter REAIS achadas no binário do CLI 2.x: `name`, `description` ("Shown in the Output
  style picker in /config") e **`keep-coding-instructions`** ("If true, the default coding
  instructions stay in the system prompt alongside the …") — exatamente o checkbox "Include the
  coding instructions" do assistente real.
- **Embutidos** do CLI 2.x (strings `outputStyle:<Nome>` no binário): `Explanatory`, `Learning`,
  `Concise`, `Proactive` (+ "default" = sem estilo).
- **Canal no Agent SDK — DIRETO, sem gambiarra de systemAppend**:
  - No início do turno: `Options.settings` (equivalente documentado do `--settings` do CLI,
    sdk.d.ts ~2209) aceita um objeto `Settings`, e `Settings.outputStyle` existe ("Controls the
    output style for assistant responses", sdk.d.ts ~8533). O runner manda
    `settings: { outputStyle }` quando a sessão tem estilo (TurnParams.outputStyle).
  - Ao vivo: `Query.applyFlagSettings({ outputStyle })` — mesma camada de settings de flag, mesmo
    caminho que o esforço já usava (`setEffortLive`); `null` volta pro padrão. Existe ainda
    `updateSettings('localSettings', {outputStyle})` (allowlist explícita do SDK) e
    `reloadOutputStyles()`, não usados aqui: gravam por PROJETO, e o Orion quer por SESSÃO.
- **Como a extensão real faz**: `getOutputStyle` → `{outputStyle, availableStyles}`;
  `setOutputStyle(nome)` grava na camada de settings; picker com "Select an output style" e a
  linha "Build a custom style"; assistente QW0 de 4 etapas `["name","description","instructions",
  "save"]` com "Step X of Y", validações (`Enter a name`, `A name can't contain / \ : * ? " < > |
  or ---`, `A description can't contain ---`), "Save to Project/User", "Switch to this style now",
  "Saved. The style will appear in the Output styles menu in new sessions.",
  `create_output_style {draft, level, replace}`.

### A porta no Orion

- **Catálogo compartilhado**: custom salvo em `/srv/claude/catalog/output-styles/<slug>.md`
  (`slugDeNome` do nome digitado = o arquivo, como a real) com `criado-por: <email>` no
  frontmatter (o CLI ignora chaves desconhecidas — criador registrado sem tabela nova). Um
  **symlink** em `~/.claude/output-styles/<slug>.md` faz o CLI resolver o nome em qualquer sessão
  (o runner usa `settingSources: ['user','project']`). Arquivo REAL preexistente no dir do usuário
  nunca é sobrescrito (só symlinks são refeitos) — `gravarEstilo`, testado.
- **Por sessão**: coluna `claude_sessions.output_style` (nullable; `ALTER TABLE IF NOT EXISTS` em
  `routes/claude.ts`, mesmo padrão do `archived` — sem disputar `migrations.ts`).
  `POST /api/claude/sessions/:id/output-style` segue o contrato EXATO das irmãs modo/modelo/
  esforço: valida contra a lista real (`estiloConhecido`), persiste primeiro, depois
  `Runner.setOutputStyleLive` em try/catch. O turno seguinte nasce certo via
  `Options.settings.outputStyle` (startFor lê a coluna).
- **UI**: pill "Estilo" no compositor (mesmo `cc-pop`/`Menu` dos vizinhos) com "Selecione um
  estilo de saída", check no atual, "Nenhum estilo de saída disponível" e a linha "Construir um
  estilo personalizado"; o assistente (`OutputStyles.tsx`) tem as 4 etapas na MESMA ordem, os
  textos traduzidos ("Etapa X de 4", "Voltar"/"Avançar"/"Salvar"/"Substituir"/"Concluído", helps e
  erros idênticos, placeholder "Diagrams first" mantido), o checkbox "Incluir as instruções de
  código", "Trocar para este estilo agora" e o 409 "Já existe um arquivo de estilo chamado X." →
  botão **Substituir**.
- **Permissões**: criar estilo é de QUALQUER usuário autenticado (a real deixa qualquer um
  construir; o catálogo registra o criador). SUBSTITUIR estilo existente: só admin ou o criador
  registrado — a parte destrutiva de mudar o catálogo compartilhado.

### Simplificações deliberadas

1. **"Save to Project/User" virou um destino só** (catálogo compartilhado): o "User" real seria o
   `~/.claude` do danilo (global pra todo mundo de qualquer forma) e o "Project" gravaria dentro
   do repo do projeto (poluiria worktrees/commits). A etapa 4 mostra o destino explicitamente.
2. **Rascunho de sessão não tem seletor de estilo** (o pill some): não existe linha no Postgres
   pra persistir antes do 1º turno. Upgrade: guardar no Tab local e mandar no create, como o
   worktreeName faz.
3. **Lista de embutidos é estática** (5 nomes conferidos no binário do CLI da c3): sem sessão viva
   não há `availableStyles` pra perguntar — mesma decisão de escopo do seletor de modelo
   (PARIDADE.md seção 5). Upgrade: cruzar com `get_output_style` de uma Query ativa.
4. **Sem excluir estilo pela UI** (a real também não tem delete no assistente); apagar =
   remover o .md do catálogo à mão.

## 3. Arquivos da trilha

- `server/tools/marketplace.ts` (novo) + `server/tools/outputStyles.ts` (novo) — puras + disco/CLI.
- `server/routes/marketplace.ts` (novo) + `server/routes/outputStyles.ts` (novo) — registradas em
  `server/index.ts`.
- `server/tools/skillPrefs.ts` — `chavePlugin` + gate de plugin inteiro em `planoDeComposicao`.
- `server/claude/runner.ts` — `TurnParams.outputStyle` → `Options.settings`; `setOutputStyleLive`.
- `server/routes/claude.ts` — coluna `output_style`, SELECTs, `startFor`, rota
  `POST /:id/output-style`.
- `tests/marketplace.test.ts`, `tests/outputStyles.test.ts` (novos; os existentes continuam verdes).
- `web/src/claude/Marketplace.tsx`, `web/src/claude/OutputStyles.tsx` (novos);
  `ClaudePage.tsx` (gatilho + estado + restauração por sessão), `Composer.tsx` (seletor "Estilo"),
  `api.ts` (tipos + chamadas), `icons.tsx` (Puzzle), `claude.css` (blocos cc-mkt-*/cc-style-*).
