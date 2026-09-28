# Paridade com o painel de chat da extensão Claude Code (VS Code / Antigravity)

Inventário de cada elemento do painel de chat da extensão oficial, feito lendo
`webview/index.css` (nomes de classe) e `webview/index.js` (rótulos e strings) da
extensão extraída. **Referência apenas** — nada foi copiado; reimplementado no nosso
estilo. Coluna **no nosso v2?**: `já tem` · `falta` · `n/a` (fora de escopo/sem dado).

## 1. Cabeçalho e abas

| Elemento (classe da extensão) | no nosso v2? | Nota |
|---|---|---|
| Abas de sessão com título + ícone spark + fechar (`tab_OOQiHg`, `tabActive`) | já tem | `cc-tab`, com X ao passar o mouse |
| Botão parar/interromper turno | já tem | `cc-icon` Power no cabeçalho |
| Recarregar lista | já tem | extra nosso (Sync) |
| Menu de ações da sessão (renomear) | já tem | Dots → `rename()` (prompt) |
| Título da sessão + meta (projeto · usuário · custo · turnos · dot de status) | já tem | `cc-head` / `cc-head-meta` |
| Cabeçalho fixo ao rolar (`stickyHeader_07S1Yg`) | n/a | baixo valor |
| Atalho Ctrl/Cmd+N — nova sessão (`claude-vscode.newConversation`, `package.json` real) | **implementado agora (28/09/2026, rodada 3)** | listener global em `ClaudePage.tsx`, chama `newSession()` já existente — ver seção nova abaixo |
| Atalho Ctrl/Cmd+Shift+T — reabre a última sessão fechada (`claude-vscode.reopenClosedSession`) | **implementado agora (28/09/2026, rodada 3)** | pilha `closedStack` (até 10, estilo aba de navegador) alimentada por `closeTab()` — ver seção nova abaixo |

## 2. Barra lateral de sessões

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Botão "Nova sessão" (`newSessionButton_djirOA`) | já tem | `cc-new` |
| Grupos personalizados arrastáveis (`newGroupButton_OOQiHg`, `sessionGroups`, `groupNameEditing`) | n/a | na extensão real é uma feature de pastas nomeadas, criadas à mão e persistidas (drag-and-drop de sessão pra dentro do grupo, grupo renomeável); exigiria tabela nova + rotas CRUD + DnD. Fora do escopo de "microfunção"; ver "Agrupar por" abaixo como equivalente leve |
| Toggle Local/Web (`segmented_OOQiHg`) | já tem | Web mostra "em breve" |
| Caixa de busca (`searchBox_OOQiHg`, `searchInput`, `searchClearButton`) | já tem | filtra por título; **estendido agora** para também bater com projeto (slug/nome) |
| Filtro por projeto (sem equivalente direto na extensão — lá é 1 workspace só) | **implementado agora** | `cc-select` "Todos os projetos"/por projeto; só aparece quando há >1 projeto entre as sessões (extra nosso, já que o v2 é multi-projeto) |
| Filtro "Ativas · N" (`activeFilterToggle_OOQiHg`) | já tem | alterna só rodando/aguardando |
| Filtro por status em menu (`statusFilterMenuButton`) | n/a | reduzido ao toggle "Ativas" |
| Agrupar por (equivalente leve ao `groupHeader/groupChevron/groupCount` da extensão, mas por critério automático em vez de pasta manual) | **implementado agora** | seletor "Sem agrupar / Por projeto / Por data"; por projeto agrupa por `project_slug`, por data usa baldes Hoje/Ontem/Esta semana/Mais antigas (`groupSessions` em `mapper.ts`); cada grupo tem cabeçalho com chevron/contagem e é colapsável |
| Renomear sessão inline, lápis ao passar o mouse (`sessionNameEditing_OOQiHg`, `onRenameSession`) | já tem | `cc-item-act` com ícone `Pencil`, edição inline (usa `POST /api/claude/sessions/:id/rename`, já existia); **estendido agora** para também aparecer no `:focus-within` (teclado), não só `:hover` |
| Arquivar/Desarquivar (`onArchiveSession`, grupo "Archived sessions") | já tem | coluna `archived`, toggle "Arquivadas", ação no hover |
| Dots de status (`statusDotRunning/Waiting/Unread/Failed/Idle`) | já tem | `cc-dot is-*` |
| Hora relativa (`sessionTime_OOQiHg`) | já tem | `relativeTime()` |
| Pill de worktree (`worktreePill_OOQiHg`) | n/a | sem worktrees no nosso fluxo |
| Sessão aberta em outro lugar (`statusDotElsewhere`) | n/a | irrelevante no nosso modelo (1 painel) |
| Estado de carregamento inicial da lista (`disconnectedState_OOQiHg`/`reconnectSpinner_OOQiHg`, texto "Loading sessions…") | **implementado agora (28/09/2026, rodada 3)** | `cc-loading` + spinner (`cc-spinner`, reaproveita `@keyframes cc-spin` que já existia sem uso) em vez de pular direto pra "Nenhuma sessão" enquanto o primeiro fetch está em voo — ver seção nova abaixo |

## 3. Conta e uso

Rodada de 28/09/2026: reli o código real (não só a captura de tela) — `webview/index.js` da
extensão v2.1.282 extraída em `/srv/orion-reference/vscode-extension/extension/webview/index.js` —
em vez de confiar só nas linhas antigas desta tabela (o próprio arquivo já avisa que memória/doc pode
ficar velha). Achados relevantes, todos verificados lendo a função `L$5` (o componente do painel
Account & Usage) e a função `ee` (a barra individual) no JS decompilado, e o tipo
`SDKResultMessage.rate_limits` em `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (SDK
0.3.283, mesma versão do CLI 2.1.283 rodando no servidor):

- A extensão real **não tem 3 barras fixas**. A lista é dinâmica: "Session (5hr)" (`rate_limits.five_hour`),
  "Weekly (7 day)" (`rate_limits.seven_day`), "Weekly Sonnet" (`rate_limits.seven_day_sonnet`) **só
  quando** `subscription_type` é `max`, `team` ou `null`, e uma barra "Weekly {display_name}" **por
  entrada** de `rate_limits.model_scoped[]` — é daí que vem o rótulo "Fable" da captura de tela do
  Bayerl (o servidor manda `display_name: "Fable"` numa entrada de `model_scoped`, não é um nome fixo
  no código). Janela com `utilization: null` é pulada. Nenhuma barra mostra custo em US$ — só %
  (`Math.floor`) e, quando a janela tem `resets_at`, uma linha "Resets {texto}".
- **"Resets {tempo}"**: confirmado, existe de verdade (funções `iS`/`b$5` no webview: "in Xm" se
  < 1h, "in Xh" se < 24h, senão "in Xd"). A fonte é `resets_at` (ISO 8601) dentro de cada janela de
  `rate_limits`.
- Esse `rate_limits` (com `utilization` 0-100 e `resets_at` ISO 8601 por janela) é um campo real do
  **result** do SDK atual (`SDKResultMessage.rate_limits`, populado "from the claude.ai usage
  endpoint" quando `rate_limits_available` é `true`) — e o runner do Orion (`server/claude/runner.ts`)
  **já grava o result inteiro** em `claude_events.payload` para toda sessão, então o dado, quando
  existir, já está no nosso banco sem nenhuma chamada nova.
- Verificado ao vivo: consultei os 10 `result` mais recentes no Postgres de produção (3 dias, sessões
  diferentes) — nenhum tem `rate_limits`/`rate_limits_available`/`subscription_type` no payload (as
  chaves nem aparecem, não é só `null`). O próprio `.d.ts` do SDK documenta a causa: esse campo é
  `false`/ausente "for API key, Bedrock, Vertex, **or missing profile scope**". O Orion autentica só
  via token de `claude setup-token` (setting `claude_oauth_token`, vira env `CLAUDE_CODE_OAUTH_TOKEN`)
  — confirmei que não existe `~/.claude/.credentials.json` (sessão de login interativo) para o
  usuário `danilo`. Ou seja: é exatamente o cenário "profile scope ausente" que o SDK descreve — o
  token de automação não carrega escopo de conta/perfil, só de inferência (bate com a suspeita antiga
  desta tabela, agora confirmada na fonte em vez de assumida).
- **Implementado nesta rodada** (`web/src/claude/mapper.ts`: `computeRealUsageBars`,
  `formatResetIn`; `computeUsageBars` agora aceita um 2º argumento `real` opcional e prefere os dados
  reais quando existem, caindo para o proxy por custo — inalterado — quando não): quando
  `/api/claude/usage` encontrar um `result` com `rate_limits_available` e `rate_limits`, a barra usa o
  **% real** e mostra "Reinicia {tempo}" embaixo, igual à extensão. **Hoje isso nunca acontece** (ver
  item acima), então a UI continua idêntica a antes — é um caminho testado (`tests/mapper.test.ts`) e
  pronto, não um enfeite: liga sozinho, sem mexer em código de novo, se o Orion um dia autenticar via
  login interativo em vez de `setup-token` (mudança de infra maior, fora do escopo desta rodada — só
  documentando o caminho).
- **Não fabricado**: o proxy por custo (3 barras fixas "Sessão (5h)" / "Semanal (7 dias)" / "Limite
  Fable", contra referência de US$ 5/25/100) **continua sem "Reinicia {tempo}"** — não inventamos reset
  pra ele. Os nomes fixos do proxy são só uma aproximação nossa (não correspondem 1:1 à lista dinâmica
  real acima) e já foram revisados pelo Bayerl; não mexi neles.
- **Correção da rodada seguinte (mesmo dia, 28/09/2026 à tarde)**: o Bayerl lembrou que "no último
  Orion funcionava perfeitamente" — o Orion antigo (c1, `/config/workspace/orion/src/api/usage.js`)
  nunca dependia do `rate_limits` do SDK; ele batia **direto** em `GET
  https://api.anthropic.com/api/oauth/usage` (headers `Authorization: Bearer <token>`,
  `anthropic-beta: oauth-2025-04-20`), lendo o token de `~/.claude/.credentials.json`. Testei essa
  mesma chamada em produção com o token atual (`claude setup-token`) e voltou
  `403 oauth_scope_insufficient, required_scopes: ["user:profile"]` — confirma que o problema nunca
  foi o método (SDK vs. API direta), é o **escopo do token**. Achei que `claude auth login --claudeai`
  (comando separado do `setup-token`, `claude auth --help`) pede exatamente `user:profile` na URL de
  autorização (testado ao vivo, capturando a tela antes de completar o login) — e usa o mesmo padrão
  de tela (URL + "Paste code here if prompted") que o conector do Orion (`server/claude/login.ts`) já
  sabia processar.
  - **Implementado**: `server/claude/login.ts` agora roda `claude auth login --claudeai` em vez de
    `setup-token`. Como não há garantia de que esse comando imprima um token de 1 ano na tela (o
    `setup-token` imprime; o login normal grava a sessão OAuth completa, com refresh token, em
    `~/.claude/.credentials.json`), o fluxo tenta capturar um token impresso primeiro (caminho antigo,
    inalterado) e, se não achar, confirma sucesso pelo arquivo de credenciais em vez de falhar —
    **sem** copiar esse access token pro Postgres (copiar um token curto e guardar pra sempre
    quebraria a renovação automática que o próprio `claude` CLI faz sozinho a cada uso).
  - `server/claude/credentialsFile.ts` (novo): lê `~/.claude/.credentials.json` ao vivo.
    `server/claude/realUsage.ts` (novo): `fetchRealUsage` chama a API direta preferindo esse arquivo
    (cai pro token do Postgres só se não houver arquivo), normaliza `utilization` de 0-1 (a API manda
    assim) para 0-100 (o resto do Orion espera assim) — mesma normalização que o Orion antigo fazia.
    `/api/claude/usage` (`server/routes/claude.ts`) agora chama isso antes de olhar
    `claude_events` (que vira só um fallback secundário).
  - `server/routes/settings.ts` + `web/src/pages/Config.tsx`: a tela de Configurações mostra
    "conectado via login" quando a sessão é por arquivo (sem token pra mascarar), e desconectar agora
    também apaga `~/.claude/.credentials.json` quando for esse o caso — senão o `sdkEnv(null)`
    continuaria caindo nele mesmo depois de "desconectar".
  - **Confirmado ponta a ponta** (28/09/2026, mesmo dia à tarde): o Bayerl completou o login pelo
    navegador. Dois bugs apareceram no primeiro teste real e foram corrigidos na hora:
    1. A URL de autorização do `claude auth login` (escopo maior que o `setup-token`) passa de 400
       colunas e quebrava em duas linhas na reconstrução de tela (`terminalScreen.ts`), perdendo o
       `state=...` do fim — erro "Parâmetro state ausente" da Anthropic. Corrigido juntando linhas
       `isWrapped` antes de procurar a URL (`tests/terminalScreen.test.ts` tem os dois casos de
       regressão, incluindo o hyperlink OSC 8 real).
    2. A resposta de verdade de `/api/oauth/usage` é **diferente** do que a nota antiga (herdada do
       `usage.js` do Orion antigo) e o `.d.ts` do SDK sugeriam: `utilization` já vem em escala 0-100
       (não 0-1 — multiplicar de novo estourava pro clamp de 100% sempre), e não existe
       `model_scoped[]` nem `subscription_type` — o limite de modelo ("Fable") vem dentro de
       `limits[]`, num item `kind: "weekly_scoped"` com `scope.model.display_name`. Corrigido em
       `realUsage.ts`, testes reescritos com a resposta real capturada em produção.
    - Resultado ao vivo depois das correções: `Sessão (5h) 13%, Reinicia em ~5h`; `Semanal (7 dias)
      13%, Reinicia em ~4d`; `Fable 4%` — as três barras, com dado real, batendo com a extensão.

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Seção "Account" recolhível (`sectionTitle`, `sectionChevron_djirOA`) | já tem | chevron recolhe "CONTA E USO" |
| Linha CONTA / Email (`accountInfo`, `accountRow`, `accountValue_JuUW3A`) | **removido de propósito** | foi implementado numa rodada anterior e depois **removido pelo próprio Bayerl** (commit `4a00e94`, "Remove o label de conta ... indevidos") junto com o aviso de proxy; o CSS (`cc-account*`, `cc-usage-hint`) ficou no arquivo sem uso — não é um gap, não recolocar sem pedido explícito |
| Link "Manage" (`manageLink_JuUW3A`, `openAccountUsage`) | n/a | não há tela de conta acessível daqui |
| Barras de uso rotuladas (`usageBars_JuUW3A`, `usageFill_8s5nuw`, `usageLabel`, `usagePercent`) | já tem | lista dinâmica na extensão real (ver notas acima); Orion usa 3 barras fixas como proxy quando não há dado real |
| Rótulos reais (`Session (5hr)`, `Weekly (7 day)`, `Weekly Sonnet`, `Weekly {display_name}` por `model_scoped`) | n/a | confirmado no código real (função `L$5`); não é uma lista fixa — ver notas acima |
| Cor de aviso da barra a partir de 80% (`usageFillHigh` na função `ee`) | **implementado agora** | Orion usava 90% (`is-high`); a extensão real muda em 80% — corrigido em `Sidebar.tsx` |
| "Resets {tempo}" (`resetText_8s5nuw`) | **implementado e confirmado ao vivo** | `formatResetIn` + `computeRealUsageBars` em `mapper.ts`, alimentado por `fetchRealUsage` (API direta); testado em produção 28/09/2026 |
| % real do limite do plano | **implementado e confirmado ao vivo** | mesma cadeia acima; testado em produção 28/09/2026, as 3 barras com % e reset reais |
| Uso por modelo (`modelUsage_JuUW3A`, `modelUsageDetail`) | n/a | baixa prioridade |
| Atribuição por skill/agent/plugin (`attribution*_QET5Ow`, `behavior*`) | n/a | dado indisponível (campo `behaviors` existe no SDK mas é outra função, fora do escopo desta rodada) |

## 4. Timeline (linha do tempo)

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Texto simples + Markdown (`rendered-markdown`) | já tem | `marked` em `cc-md` |
| Thinking recolhível (`thinking_aHyQPQ`, `thinkingToggle`) | já tem | `<details>` `cc-thinking` |
| Thinking "Thought for Ns" + contador de tokens (`thinkingTokenCount_aHyQPQ`) | **implementado agora** | rótulo "Pensou · N tokens" (≈ chars/4) |
| Thinking vazio não renderiza | já tem | mapper filtra `thinking.trim()` |
| Tool block com IN/OUT (`toolBody_ZUQaOA`, `toolBodyRow`) | já tem | `cc-tool-body` |
| Resumo da tool em 2 linhas (`compactSummary_DGhSIw`, `toolSummary_ZUQaOA`) | **implementado agora** | clamp de 2 linhas na descrição |
| Dots de status da tool (`dotSuccess/Failure/Warning/Progress_07S1Yg`) | já tem | `dotClass()` |
| Botão copiar comando (`copyButton_F2hEIg`, `copyIcon`) | **implementado agora** | copia IN/comando |
| Colapsar/expandir IN/OUT longos (`expandButton_xGDvVg`, `truncationGradient`) | **implementado agora** | corpo dobrável, forma de 1 linha quando fechado |
| Render distinto Read/Edit/Write/Bash (`bashCommand_F2hEIg`, `filename_adbcGQ`) | **implementado agora** | caminho de arquivo em destaque; Bash mostra comando |
| Diff colorido para Edit (`insertions/deletions_oblbPg`, `char-insert/delete`) | **implementado agora (28/09/2026, rodada 2)** | diff unificado simples (linhas -/+) **+ destaque de caractere dentro da linha trocada** — ver nota abaixo |
| Permission card allow/deny (`permissionRequestContainer_qlaBag`) | já tem | `cc-perm` |
| "Sim, e não perguntar de novo" (`Yes, and don't ask again`) | já tem | `allow_always` |
| Escopo do allow_always (session/settings) | n/a | sem UI de escopo; SDK decide |
| AskUserQuestion com opções (`questionBlock_hONcXw`, `optionLabel`, `radio`) | **corrigido agora** | `cc-ask`/`AskAnswer`: marcar opção só seleciona, um botão "Enviar respostas" finaliza; antes o 1º clique em qualquer opção já respondia tudo (sem dar pra marcar mais de uma em pergunta `multiSelect`), e a resposta ("Você respondeu") virava o JSON cru da pergunta em vez do texto escolhido — ver bug de `2026-09-28` |
| Navegação multi-pergunta (`navTab_hONcXw`, `navigationBar`) | n/a | renderizamos todas as perguntas em sequência, cada uma com sua própria seleção; "Enviar respostas" só habilita com todas respondidas |
| Todo list (`todoList_xheXVQ`, `todoItem`, pending/in_progress/completed) | **implementado agora (28/09/2026, rodada 2)** | checklist dedicada — ver nota abaixo |
| Subagent / tool `Task` (renderer interno "Agent", `class jD1{name="Agent"}`) | **implementado agora (28/09/2026, rodada 2)** | linha dedicada (não passa mais pelo bloco de ferramenta genérico) — ver nota abaixo |
| Plan mode / plan review (`ExitPlanMode`, `milestone*_UxGN1Q`) | n/a | fora de escopo (pedido) |
| Rewind / checkpoint (`rewind`, `changedFile_5FHdxw`, `checkoutButton`) | n/a | fora de escopo (arriscado) |
| Custo · duração · turnos no result (`metaMessage_07S1Yg`, `Total duration (API)`) | já tem | `cc-result` |
| Tokens de entrada/saída no result (`modelUsage`) | **implementado agora** | soma `modelUsage` → "N↑ / N↓ tokens" |
| Mensagem interrompida (`interruptedMessage_07S1Yg`) | **corrigido agora (28/09/2026, rodada 3)** | **era um bug, não "já tem"** — stop manual perdia o texto parcial de vez (some ao recarregar); ver seção nova abaixo |
| Botão copiar resposta (`assistantActions_07S1Yg`/`copyResponseButton_07S1Yg`, hover-revelado ao lado da mensagem) | **implementado agora (28/09/2026, rodada 3)** | reaproveita o `CopyButton` de Timeline.tsx (já usado em ferramentas/Task) nas mensagens de texto do assistente — ver seção nova abaixo |

### Diff de caractere, Todo list e Subagent — rodada de 28/09/2026 (2)

Auditoria do dia comparou `Timeline.tsx`/`mapper.ts` de novo com `webview/index.js` v2.1.282
(`/srv/orion-reference/vscode-extension/extension/webview/index.js`) e achou dois gaps reais na
apresentação de atividade de ferramenta: o diff do Edit só marcava linha inteira (sem destaque
dentro da linha trocada), e TodoWrite/Task caíam no bloco de ferramenta genérico sem nenhuma
formatação dedicada. Os dois foram fechados nesta rodada, TDD (vermelho→verde confirmado, 24 testes
novos + 2 de integração em `tests/mapper.test.ts`, suíte inteira em verde: 329 testes, `npm run
build` limpo).

**Diff de caractere (Edit/Write).** Antes de mexer, confirmei o que a extensão real faz de verdade,
sem assumir — lendo o JS decompilado, não só o nome das classes:
- As classes `char-insert`/`char-delete` aparecem lado a lado com `diff-review-row`,
  `line-insert`/`line-delete`, `gutter-insert`/`gutter-delete` e `moved-blocks-lines` — ou seja, a
  extensão roda o **editor de diff completo do Monaco** por baixo do painel (o mesmo motor do
  VS Code), não um highlight caseiro. Isso é bem mais que "word-level": inclui gutters, minimapa,
  blocos movidos e linhas de revisão pra acessibilidade — fora de escopo pra essa rodada de
  paridade (confirma a entrada existente desta tabela sobre não fazer highlight de sintaxe).
- A granularidade real das decorações, porém, é **caractere**, não palavra: `webview/index.css`
  define `.monaco-editor .char-insert,.monaco-diff-editor .char-insert{background-color:var(--vscode-diffEditor-insertedTextBackground)}`
  e o mesmo pra `.char-delete`; a view inline/unificada (a que se parece com a nossa, sem colunas
  lado a lado) usa especificamente `.inline-deleted-text{text-decoration:line-through}` pro texto
  removido.
- **Implementado** (`web/src/claude/mapper.ts`): `charDiff(oldLine, newLine)` — LCS por code point
  (`Array.from`, não `split('')`, pra não quebrar par substituto/emoji) que devolve os trechos
  ctx/add/del de cada lado, já mesclados em runs. `charDiffIfSimilar` decide se vale destacar: usa
  prefixo+sufixo comum (não a contagem de contexto do LCS) porque LCS de caractere sozinho
  super-estima semelhança entre linhas sem nenhuma relação (letras soltas casam em qualquer posição);
  limiar de 30% da linha mais longa como prefixo/sufixo compartilhado, e um teto de 500 caracteres
  por linha (custo do LCS é O(n·m)). `annotateCharDiffs(lines)` pareia, dentro da saída já existente
  de `unifiedDiff`, cada corrida de `del` com a corrida de `add` que vem logo depois (1 a 1, na
  ordem) e anota `parts` nos pares parecidos — sem mudar `unifiedDiff` em si (os testes de diff de
  linha existentes continuam intactos). Em `Timeline.tsx`, `EditDiff` passa a usar
  `annotateCharDiffs`, e `DiffLineBody` renderiza os `parts` como `<span className="cc-diff-char
  is-add/is-del">` (nome próprio, seguindo a convenção `cc-*` do resto do arquivo — não literalmente
  `char-insert`/`char-delete` do Monaco, que é nome de classe de um editor que não existe aqui) —
  fundo mais forte que o da linha (`claude.css`) e risco no texto removido (`text-decoration:
  line-through`), espelhando o `.inline-deleted-text` real citado acima. 7 testes novos
  (`charDiff`, `charDiffIfSimilar`, `annotateCharDiffs`) cobrem: linha idêntica, uma troca no meio,
  duas trocas separadas na mesma linha, linhas sem nada em comum, add/del puro (sem parceiro) não
  ganha destaque, e imutabilidade da lista original.

**Todo list (TodoWrite).** Schema real confirmado em duas fontes concordantes: `TodoWriteInput` em
`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` (`{ todos: { content: string; status:
"pending"|"in_progress"|"completed"; activeForm: string }[] }`) e a leitura defensiva no webview
(`function PI1($){return typeof $==="object"&&$!==null&&"todos"in $&&Array.isArray($.todos)?$.todos:void 0}`).
A renderização real (`function gG0({todos})` + checkbox `function J65({status})`, classes
`todoListContainer_xheXVQ`/`todoList_xheXVQ`/`todoItem_xheXVQ`/`completed_xheXVQ`/`content_xheXVQ`)
só usa **`content` e `status`** de cada item — `activeForm` existe no schema mas não aparece na UI
(o checkbox real é um `<input type=checkbox disabled>` com `.checked`/`.indeterminate` setados via
`useEffect`: `completed` → marcado; `in_progress` → indeterminado/meio-marcado; `pending` → vazio; e
o CSS risca + esmaece o texto quando completed: `.completed_xheXVQ .content_xheXVQ{text-decoration:
line-through;opacity:.7}`). O cabeçalho real é sempre o texto fixo **"Update Todos"** (`class
wD1{name=Vw;header(){return...children:"Update Todos"}}`), nunca dinâmico.
**Implementado**: `parseTodos(input)` em `mapper.ts` (leitura defensiva, nunca lança, status
desconhecido cai em `pending`) + componente `TodoList` em `Timeline.tsx` — checklist com um ícone de
checkbox por status (`cc-todo-check is-pending/is-in_progress/is-completed`) e texto riscado+esmaecido
quando completed, igual à extensão. Cabeçalho traduzido pro padrão PT-BR do resto da tela ("Lista de
tarefas", mesma convenção de `AskUserQuestion` → "Pergunta"). 3 testes de `parseTodos` + 2 de
`describeTool` (rótulo e contagem "N itens"/"1 item") + 1 de integração via `reduceSdkMessages`
(confirma que o `input.todos` bruto chega intacto no evento).

**Subagent (tool `Task`).** O nome real da tool no SDK é **`Task`**, não "Agent" — confirmado em
`webview/index.js` (`var RE="Task"`) e no schema real (`AgentInput` em `sdk-tools.d.ts`:
`description`/`prompt`/`subagent_type?`/`model?`/`run_in_background?`). A extensão mapeia esse nome
internamente pro renderer registrado como `"Agent"` (`function sZ($,J){...let
X=$==="Task"?"Agent":$,Y=Z.find((Q)=>Q.name===X)...}`) e mostra **"Agent: {description}"** no
cabeçalho (`class jD1 extends p2{name="Agent";header($,J){return...children:"Agent:"...J.description}}`),
com o `prompt` como corpo IN clicável (abre num visualizador) e **sem OUT**
(`renderOutput(){return null}`) — achado que bate com a entrada pré-existente desta tabela pra
"Agent" em `describeTool` (que nunca disparava de verdade, porque o nome real da tool sempre foi
"Task", não "Agent" — bug de nomenclatura antigo, corrigido de passagem nesta rodada). Também existe,
à parte, uma UI de "subagentRow" (`subagentRow_mpBgEA`, funções `lU0`/`iU0`/`dU0`) pra quando várias
tarefas em paralelo ficam dobradas numa fileira condensada com telemetria ao vivo (tempo decorrido,
tokens, contagem de tool calls do subagente) — isso é uma feature de dobra de múltiplas tarefas
concorrentes com stream de progresso próprio, que o Orion não tem (nossa timeline é uma lista linear
só); não replicada — fora do escopo desta rodada, documentado aqui pra não confundir com o resto.
**Implementado**: `describeTool` ganhou o caso `'Task'` → `{ label: 'Agent', description:
input.description, inputText: input.prompt }` (bate com o cabeçalho real "Agent: {description}" +
IN = prompt). Em `Timeline.tsx`, componente `TaskAgent` dedicado (não passa mais pelo bloco de
ferramenta genérico `Tool`) — mostra "Agent" + descrição em destaque, `subagent_type` como selo
secundário quando existe (extra nosso, não está no cabeçalho real, mas é dado que já temos e é útil),
e status rodando/concluído/falhou via `taskStatusLabel(e.status)` (texto de progresso simples a
partir do `ToolStatus` que já temos — não inventamos a telemetria ao vivo da extensão real, que
exigiria um stream de progresso por tarefa que não existe aqui). Diferente da extensão real,
mantivemos o OUT (resultado final do subagente) dobrável — ela esconde, mas aqui é informação que o
Bayerl efetivamente usa pra acompanhar o que o subagente fez; decisão documentada, não um gap. 4
testes de `taskStatusLabel` + 1 de `describeTool` (rótulo/descrição/inputText) + 1 de integração via
`reduceSdkMessages`.

## 5. Compositor

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Textarea; Enter envia, Shift+Enter quebra (`messageInput_cKsPxg`) | já tem | `Composer` |
| Recall de mensagens ArrowUp/ArrowDown (`cycleMessage`/`Cq0` no webview) | **implementado agora (28/09/2026)** | cicla pelas mensagens já enviadas da sessão quando o cursor está no início/fim do texto; ver seção "Compositor — rodada de 28/09/2026" abaixo |
| Esc foca/desfoca o compositor | já tem | listener global de Escape |
| Botão parar (`stopIcon_gGYT1w`) | já tem | `cc-stop` |
| Fila de mensagens enquanto roda (`queued`) | já tem (back) | back enfileira; placeholder avisa que dá pra enfileirar |
| Seletor de modelo (`modelPill_gGYT1w`, `modelItem_G8AMvA`) | **implementado agora (28/09/2026)**; **corrigido — troca ao vivo (28/09/2026, rodada 4)** | menu de verdade (Padrão/Sonnet/Opus/Haiku/Fable); mudar durante um turno já em andamento agora aplica na hora, não só no próximo create/send — ver seção 8 |
| Seletor de esforço Low/Medium/High/Extra high/Max (`effortLevel`, `modelPillEffort`) | já tem; **corrigido — troca ao vivo (28/09/2026, rodada 4)** | menu; envia `effort` no create/send E agora também aplica na hora num turno já em andamento — ver seção 8 |
| Seletor de modo de permissão (`modeOption_7kXHPg` Manual/Plan/Accept edits/Auto) | já tem; **corrigido — bug real de troca ao vivo (28/09/2026, rodada 4)** | menu visível (era só ciclo); trocar o modo durante um turno já em andamento era só cosmético até a próxima mensagem — bug real reportado pelo Bayerl, ver seção 8 |
| Anexar arquivos/imagens (`attachedFilesContainer_cKsPxg`, `onAddFiles`) | n/a | "em breve" (pedido) |
| Comandos de barra (`commandList_G_S7FQ`, `slashCommand`) | **implementado agora (28/09/2026)** | era uma lista fixa de 4 (`/clear /compact /context /cost`); agora vem de `Query.supportedCommands()` do SDK quando a sessão já rodou pelo menos um turno neste processo (inclui skills, comandos de projeto, etc.), com fallback pros 4 fixos antes disso — ver seção "Compositor — rodada de 28/09/2026" |
| @-menções (`mentionChip_uq5aLg`, "Add context") | n/a | fora de escopo (pedido) |
| Microfone/voz (`micButton_cKsPxg`) | n/a | fora de escopo (pedido) |
| Projeto da nova sessão | já tem | extra nosso (`cc-select`) |

### Compositor — rodada de 28/09/2026 (recall, seletor de modelo, comandos reais)

Auditoria de 28/09/2026 achou 3 gaps reais no compositor, todos confirmados lendo o webview
decompilado v2.1.282 (`/srv/orion-reference/vscode-extension/extension/webview/index.js`) e o
`.d.ts` do Agent SDK (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, SDK 0.3.283) antes de
implementar qualquer coisa — não só a tabela antiga.

- **Recall de mensagens (ArrowUp/ArrowDown)**: a extensão real tem o hook `Cq0` no webview, que
  devolve `{cycleMessage, resetHistory}`. A função `cx($)` (mesmo arquivo) extrai o histórico:
  filtra mensagens `type==="user"`, descarta `isSynthetic`/`parentToolUseId` (não pega eco de
  tool_result), junta o texto e **inverte a ordem** (mais recente primeiro). `cycleMessage(V)`
  (a função `q` dentro de `Cq0`): na 1ª ArrowUp (`V===-1`) guarda o texto atual num ref e mostra o
  item de índice 0; ArrowUp de novo avança; no item mais antigo **não dá a volta** (sem wrap,
  retorna `false` e deixa o comportamento padrão da tecla acontecer); ArrowDown volta em direção ao
  mais recente e, saindo do índice 0, **restaura exatamente o texto original salvo no início do
  ciclo** (mesmo que o meio do ciclo tenha sido editado). O guard real não é "input vazio": é a
  **posição do cursor** — `cycleMessage` só age quando a seleção está colapsada no início absoluto
  do texto (ArrowUp) ou no fim absoluto (ArrowDown), checando `startContainer`/offset da seleção do
  DOM; com texto de várias linhas, ArrowUp no meio continua navegando normal. Reimplementado fiel a
  essa lógica, adaptado pro nosso `<textarea>` simples (onde a checagem de "início/fim absoluto"
  vira só `selectionStart`/`selectionEnd`, sem a complexidade de nós de um contentEditable):
  `messageHistory` e `cycleMessageIndex` (puras, `web/src/claude/mapper.ts`) mais o wiring em
  `Composer.tsx` (estado `cycle` local, guard de cursor em `key()`, reset ao trocar de sessão ou
  quando o rascunho fica vazio — mesmo guard do `Cq0` real: `if (currentInput === "") resetHistory()`).
  O histórico vem de `messageHistory(events)`, os eventos `kind:'user'` já carregados/ao vivo da
  sessão (não uma lista separada rastreada à parte) — mais fiel ao real (que também lê do array de
  mensagens da própria sessão) e funciona mesmo reabrindo uma sessão antiga sem precisar mandar
  nada de novo nela primeiro. 13 testes novos em `tests/mapper.test.ts` (TDD, vermelho→verde
  confirmado): sem histórico, 1ª ArrowUp guarda o rascunho, ArrowUp seguinte avança sem dar volta no
  mais antigo, ArrowDown restaura o rascunho original mesmo com edição no meio do ciclo, etc.
- **Seletor de modelo**: a extensão real tem um popup de verdade (`SB0`, `xJ5` no webview: classes
  `modelPill_gGYT1w`/`modelItem_G8AMvA`/`activeModelItem_G8AMvA`/`unavailableModelItem_G8AMvA`),
  alimentado por `availableModels`/`unavailableModels` (linha com nome + descrição, marca o
  `currentModel`) — e integrado com `Query.supportedModels()` do SDK (`Promise<ModelInfo[]>`,
  confirmado em `sdk.d.ts`). Decisão de escopo: **não** fizemos essa chamada ao vivo por sessão —
  o compositor também renderiza pra uma sessão **rascunho**, antes de qualquer `Query` existir (não
  tem o que perguntar), e o pedido explicitamente permitia uma lista estática nesse caso. A lista
  usa os aliases reais que o campo `model` das `Options` do SDK aceita — confirmados no próprio
  `sdk.d.ts` ("Model alias (e.g. 'fable', 'opus', 'sonnet', 'haiku') or full model ID") e nos
  literais `"default"`/`"haiku"`/`"opus"`/`"sonnet"` soltos no webview decompilado — mais "Fable"
  como rótulo real também visto lá (`"Fable 5"`, `"Fable limit"`). `web/src/claude/api.ts`:
  `ModelAlias`/`MODEL_LABEL`/`MODEL_ORDER` (mesmo padrão de `MODE_LABEL`/`EFFORT_LABEL`) +
  `matchModelAlias` (casa o id canônico resolvido pelo SDK, ex. `"claude-sonnet-5"`, contra o alias
  certo, por substring). `Composer.tsx`: o `<span>` decorativo virou um menu — copiado **literalmente
  o mesmo padrão** de `cc-pop`/`Menu`/`cc-menu-item` já usado pelo seletor de Esforço, sem inventar
  interação nova. Escolha do usuário atualiza `modelLabel` na hora e é enviada no próximo turno.
  Faltava threading no backend pra sessão **já existente**: `POST /api/claude/sessions/:id/messages`
  não aceitava `model` (só `POST /api/claude/sessions`, na criação, aceitava) — corrigido em
  `server/routes/claude.ts`, mesmo padrão já usado ali pro `permission_mode` (só grava no Postgres
  quando o valor mudou; sem override, segue com o modelo já salvo da sessão). 9 testes novos de
  `matchModelAlias` em `tests/mapper.test.ts`.
- **Comandos de barra**: a extensão real busca a lista de verdade via `Query.supportedCommands()`
  do SDK (`Promise<SlashCommand[]>` — o próprio `sdk.d.ts` descreve o tipo como "an available skill,
  invoked via /command syntax", ou seja no vocabulário desse SDK todo comando de barra É uma skill;
  inclui builtin, comandos de projeto de `.claude/commands/*.md` e skills descobertas em runtime).
  `SlashCommand` tem `name`, `description`, `argumentHint`, `aliases?`, `builtin?`. O runner do
  Orion (`server/claude/runner.ts`) não guardava a `Query` viva em lugar nenhum acessível fora do
  `for await` do turno — agora guarda (`l.commands`, no mesmo `Live` que já guarda `pending`) e, ao
  ver `system/init`, chama `q.supportedCommands()` (fire-and-forget: não atrasa o processamento das
  mensagens do turno) e emite um novo `LiveEvent` `{type:'commands', commands}`. Bônus de baixo
  custo: o SDK também empurra sozinho um `system/commands_changed` (`SDKCommandsChangedMessage`) no
  meio da sessão quando a lista muda (skill nova descoberta numa subpasta, por exemplo) — como essa
  mensagem já passa pelo mesmo `for await` que processa tudo mais, só precisou de mais um `if` pra
  tratar (substitui a lista inteira, não soma — mesmo contrato que o `.d.ts` documenta). Escolhi SSE
  em vez de um endpoint novo: o padrão já existe pra exatamente esse caso (`pendingPermissions()` +
  evento `hello` na conexão + eventos incrementais depois, ver `/api/claude/sessions/:id/stream`) —
  o `hello` agora também manda `commands: runner.commandsFor(id)`, então reabrir/reconectar recupera
  a lista sem esperar um turno novo (desde que o processo do servidor não tenha reiniciado — mesma
  limitação já aceita e documentada pra `pendingPermissions`, só em memória). `Composer.tsx`: o menu
  agora usa `commands` (via `ClaudePage` → `state.commands`, populado pelo evento SSE) quando não
  está vazio; cai pros 4 fixos (`SLASH_FALLBACK`) antes da sessão rodar um turno ou se o SDK nunca
  respondeu. Um fake de teste "burro" sem `supportedCommands()` (todos os outros testes de
  `runner.test.ts`, escritos antes de hoje) continua funcionando — checagem defensiva
  (`typeof withCommands.supportedCommands === 'function'`) — e um fake novo com o método simula
  o caso real. 3 testes novos em `tests/runner.test.ts` (sem o método → `[]`; com o método → evento
  `commands` + `commandsFor()`; `commands_changed` → substitui a lista).
- Não avaliado por falta de ferramenta: não há navegador/visual-testing neste ambiente; verificação
  foi por leitura de código + `vitest` (324 testes, suite inteira verde) + `tsc --noEmit` (server e
  front, sem erro) + `vite build` (bundle gera sem erro). Não fizemos `curl` autenticado contra rotas
  novas porque este worktree (`composer-paridade`) não é o processo `orion-central` rodando de
  verdade (esse roda o código do `main`/`/srv/orion`); um `curl` só re-testaria o código antigo, não
  o que mudou aqui.

## 6. Rodapé / estado

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Barra de status: projeto · cwd · versão · ativas (`status-bar`) | já tem | `cc-status` |
| Banner de login/token ausente | já tem | extra nosso |
| Estado vazio (`emptyState_07S1Yg`) | já tem | `cc-empty-state` |
| Aviso de desconexão/reconexão do stream ao vivo (`disconnectedText_OOQiHg`/`reconnectSpinner_OOQiHg`, "Reconnecting"/"Connecting…") | **implementado agora (28/09/2026, rodada 3)** | `es.onerror`/`es.onopen` do `EventSource` (antes `onerror` era um no-op puro) → banner `cc-banner cc-reconnect` — ver seção nova abaixo |

## 7. Auditoria de segundo nível — rodada de 28/09/2026 (3)

Os 4 itens abaixo foram achados por um agente de auditoria dedicado, num segundo passe sobre a aba
Claude do Orion comparado à extensão real (2026-09-28) — depois das rodadas de "Conta e uso",
"Timeline" e "Compositor" já registradas nas seções anteriores. Um deles (mensagem interrompida) era
um bug de verdade, não um gap de paridade: a linha 169 antiga desta tabela dizia "já tem" pro item,
o que era falso — está corrigido abaixo, com a entrada da tabela já atualizada na seção 4.

### Bug: stop manual descartava a resposta em andamento silenciosamente

**Causa raiz** (confirmada lendo `server/claude/runner.ts` antes de mexer, não assumida): o catch de
`run()` tratava abort manual (botão Parar) e erro genuíno do SDK pelo mesmo tipo de evento
(`'error'`), diferenciando só o `status` final que `setStatus` grava (`idle` no abort, `error` no
erro de verdade). Só que `web/src/claude/live.ts` só mostrava esse texto quando `status==='error'`
literalmente — `toConvEvents` (`if (s.error && s.status === 'error')`) e `fromRows`
(`error: status === 'error' ? s.error : null`). Resultado: um stop manual (status `idle`, de
propósito — a sessão devia continuar utilizável) escondia a mensagem de interrupção, e pior: como as
mensagens PARCIAIS do streaming (`stream_event`) nunca eram persistidas em `claude_events` (só a
mensagem completa seria — e ela nunca chega quando o turno é cortado no meio), não sobrava nem
rastro no banco pra reconstruir ao recarregar a página. O turno simplesmente sumia, sem deixar
vestígio nenhum.

**Extensão real**: li o webview decompilado (`/srv/orion-reference/vscode-extension/extension/webview/index.js`,
v2.1.282) em vez de assumir a partir da descrição do bug. A função `Oz` consulta uma tabela literal
(`Qw`) de dois sentinelas que o próprio CLI grava no bloco de texto quando interrompido:
```
var Qw={"[Request interrupted by user]":"Interrupted","[Request interrupted by user for tool use]":"Tool interrupted"};
```
Renderizado como `<div className={f0.interruptedMessage}>{c.friendlyMessage}</div>` — um bloco
próprio, estilo neutro (`interruptedMessage_07S1Yg`, não a classe de erro), no lugar onde o sentinela
apareceria no conteúdo da mensagem; o texto já gerado ANTES da interrupção continua normal, no bloco
anterior — nunca é apagado. Achei também `assistantActions_07S1Yg`/`copyResponseButton_07S1Yg` (ver
próxima seção) lendo o mesmo trecho.

**Diferença de arquitetura**: o Orion não passa pelo sentinela de texto — a interrupção aqui é uma
exceção de `AbortController` capturada no catch de `run()`, nunca um bloco de texto que o próprio
CLI grava sozinho no meio da mensagem (o SDK do Orion lança, não retorna uma mensagem terminada com
esse texto). Corrigido de forma nativa ao modelo de eventos que o Orion já tem, sem copiar
literalmente a extensão:

- `server/claude/runner.ts`: novo tipo de evento **próprio**, `'interrupted'` — nunca mais `'error'`
  no caminho de abort manual (`{ type: 'interrupted', message, duringTool, partialText,
  partialThinking }`), persistido via `appendEvent(id, 'interrupted', ...)` e emitido ao vivo. `run()`
  passou a acumular `partialText`/`partialThinking` localmente a partir dos próprios `stream_event`
  que já processava (mesmo reset em `message_start`/`content_block_start` e mesma limpeza ao ver uma
  mensagem `assistant`/`result` completa que o lado cliente já fazia em `applyLive`/`pushMessage`) —
  só assim esse texto existe pra persistir no evento de interrupção, já que ele nunca seria
  persistido de outra forma. `duringTool`: `Runner.stop()` agora grava
  `l.stopHadPendingTool = l.pending.size > 0` **antes** de negar as permissões pendentes — sinal
  equivalente ao que a extensão lê do sentinela "for tool use", adaptado porque o runner não tem
  esse texto (limitação documentada abaixo).
- `web/src/claude/live.ts`: `LiveState` ganhou `interrupted: InterruptedState | null` (mensagem,
  `duringTool`, texto/thinking parciais). `fromRows` trata o novo tipo de evento persistido **sem
  depender de `status`** (diferente de `error`, de propósito — status `idle` é o resultado CORRETO
  de um stop, não deveria esconder nada atrás dele). `applyLive` trata o evento ao vivo
  (`case 'interrupted'`), congelando o que já estava em `partialText`/`partialThinking` como
  `interrupted.text`/`.thinking` e limpando os campos de streaming. `pushMessage` (nova mensagem do
  usuário) e o caso `'status'` com `status==='running'` limpam `interrupted` — mesma janela de vida
  do erro genuíno logo ali ao lado: o marcador não fica preso na tela pra sempre depois que a
  conversa continua. `toConvEvents` gera um evento `kind:'text'` com o texto parcial preservado e uma
  propriedade nova, `interrupted: <rótulo>` — nunca apaga o texto, e mostra o selo mesmo com texto
  vazio (interrupção antes de gerar qualquer coisa), pra sempre deixar rastro visível de que o turno
  foi cortado.
- `web/src/claude/mapper.ts`: `interruptedLabel(duringTool)` → `"Interrompido"`/`"Ferramenta
  interrompida"` (tradução PT-BR dos dois rótulos reais confirmados na tabela `Qw` acima).
- `web/src/claude/types.ts`: `ConvEvent` (`kind:'text'`) ganhou o campo opcional `interrupted?: string`.
- `web/src/claude/Timeline.tsx`/`claude.css`: classe `.cc-interrupted` — cor de aviso
  (`var(--cc-warning)`), a mesma família visual de `.cc-perm-exp` (pedido expirado), nunca a
  vermelha de `.cc-result.is-error` — não é um erro, é um turno cortado pelo próprio usuário.

**TDD, vermelho→verde confirmado**: escrevi os testes de `fromRows`/`applyLive` reproduzindo a shape
exata que o runner persiste/emite (status `idle`, evento `'interrupted'` com o texto parcial) antes
de existir o código que os faz passar; rodei pra confirmar que falhavam (função/caso ausente —
`s.interrupted` undefined, `TypeError`), só depois implementei `runner.ts`/`live.ts`/`mapper.ts`. 4
testes novos em `tests/live.test.ts` (`fromRows`: sobrevive ao reload mesmo com status `idle` —
exatamente o cenário do bug; rótulo `duringTool: true`; interrupção sem nenhum texto ainda mostra o
selo; nova mensagem do usuário limpa a interrupção do turno anterior) + 2 em `applyLive` (ao vivo,
sem reload; novo turno limpa) + 3 em `tests/runner.test.ts` (persiste `'interrupted'` com o parcial
já acumulado, nunca `'error'`; `duringTool: true` quando havia permissão de ferramenta pendente no
momento do stop — fake bespoke que reproduz o timing real de `stop()`: nega a pendência com
`interrupt:true` e aborta antes de devolver) + 2 de `interruptedLabel` em `tests/mapper.test.ts`.
Suíte inteira: 358 testes verdes, `tsc --noEmit` (server e front) e `vite build` sem erro.

**Limitação documentada**: `duringTool` é um proxy (havia permissão de ferramenta pendente no
momento exato do `stop()`), não uma detecção 1:1 do sentinela real da extensão — uma ferramenta
AUTO-aprovada (sem pedido de permissão, ex. modo `acceptEdits`) que estivesse executando no momento
do stop não aciona essa variante, cai no rótulo genérico "Interrompido". Aceitável: não há sinal
melhor disponível no runner sem reescrever a integração com o SDK só pra rastrear tool_use↔tool_result
em voo — fora de proporção para esse bug.

### Gap: sem botão de copiar na resposta do assistente

`Timeline.tsx` renderizava `e.kind==='text'` como `<Md text={e.text}/>` puro — sem nenhuma
affordance de copiar, diferente dos blocos de ferramenta/Task, que já tinham `CopyButton` (definido
localmente no próprio arquivo, hover-revelado via `.cc-tool-copy`/`.cc-tool-summary:hover`).

Extensão real (mesmo trecho do webview lido pro bug acima): `assistantActions_07S1Yg`/
`copyResponseButton_07S1Yg` — um bloco `data-message-actions` renderizado depois do conteúdo da
mensagem, condicionado a ela não estar mais em progresso (`q!=="progress"`); botão "Copy response"
hover-revelado ao lado da mensagem.

**Implementado**: componente `AssistantText` novo em `Timeline.tsx`, que reaproveita o `CopyButton`
já existente (mesmo padrão hover: `.cc-text-copy` some/aparece junto de `.cc-msg:hover`, igual a
`.cc-tool-copy`/`.cc-tool-summary:hover` já usados pelas ferramentas) — escondido enquanto
`e.streaming` (mesma condição "não em progresso" da extensão real) e quando não há texto. Nenhum
componente de UI novo inventado, só reuso correto do que já existia no arquivo.

### Gap: sem feedback de desconexão/carregamento

`ClaudePage.tsx` tinha `es.onerror = () => { /* o navegador reconecta sozinho */ }` — um no-op
literal. `Sidebar.tsx` pulava direto pra "Nenhuma sessão" enquanto o primeiro fetch de sessões ainda
estava em voo, sem nenhum estado de carregamento.

Extensão real (mesmo webview v2.1.282): classes `disconnectedState_OOQiHg`/`disconnectedText_OOQiHg`/
`reconnectSpinner_OOQiHg` — um spinner (função `FF0`, um `<div>` que gira via `setInterval`/
`performance.now()`) mais o texto **"Loading sessions…"** enquanto `!localSessionsLoaded`; pro caso
remoto (sem equivalente direto no Orion, que não tem sessões na nuvem implementadas — toggle Web
"em breve"), **"Connecting…"** ou **"Remote server is not connected"** + botão **"Reconnect"**.

**Implementado**, adaptado ao que o Orion realmente tem (stream por sessão via `EventSource`, não um
canal remoto separado com botão de reconectar manual):
- `Sidebar.tsx`: prop `loading` nova; enquanto verdadeira, mostra `cc-loading` (spinner + "Carregando
  sessões…") no lugar da lista, em vez de pular direto pra "Nenhuma sessão".
- `ClaudePage.tsx`: `sessionsLoading` (`true` até o primeiro fetch terminar, sucesso ou falha — nunca
  mais reativado nos refreshes periódicos de 8s, só no carregamento inicial, igual à extensão real).
  `streamStatus` (`'connecting'|'connected'|'disconnected'`) ligado a `es.onopen`/`es.onerror` do
  `EventSource` nativo (que já reconecta sozinho — isso é só pra avisar visualmente que aconteceu,
  nunca silêncio total) — banner `cc-banner cc-reconnect` mostrado só quando `'disconnected'`, não
  durante o `'connecting'` inicial de cada troca de sessão (evitaria um flash constante).
- `claude.css`: `.cc-spinner` reaproveita `@keyframes cc-spin`, que já existia no arquivo sem nenhum
  uso até agora (confirmado com grep antes de escrever a regra nova).

### Gap: 2 atalhos de teclado ausentes (Ctrl/Cmd+N, Ctrl/Cmd+Shift+T)

Confirmado em `contributes.keybindings` do `package.json` real
(`/srv/orion-reference/vscode-extension/extension/package.json`, lido via `json.load` em vez de
grep, pra não errar a estrutura): `claude-vscode.newConversation` → `cmd+n`/`ctrl+n`, condição
"painel do Claude em foco"; `claude-vscode.reopenClosedSession` → `cmd+shift+t`/`ctrl+shift+t`,
condição `claude-vscode.lastClosedWasSession`. `ClaudePage.tsx` só escutava Escape (na verdade esse
listener vive em `Composer.tsx`, não em `ClaudePage.tsx` — a descrição original do gap estava
imprecisa nesse detalhe; os dois atalhos novos foram adicionados num listener próprio em
`ClaudePage.tsx`, onde `newSession()`/`tabs` já vivem).

**Pilha ou só "o último"?** — verificado em `extension.js` (não assumido): `lastClosedWasSession` é
só um context key booleano que libera a tecla, mas o que ele reflete,
`this.recentlyClosedSessions`, é de fato um array (`.push`/`.splice`/`.shift`, cap
`var rk0=10`) — uma pilha pequena, estilo aba de navegador (Ctrl+Shift+T repetido reabre cada vez
mais fundo no histórico), **não** um único "último fechado" isolado.

**Implementado** em `ClaudePage.tsx`: `closedStack` (ref, array de até 10 ids — só sessões de
verdade, nunca rascunho `draft-*`) alimentada por `closeTab()` (empilha ao fechar) e consumida por
`reopenLastClosed()` (desempilha o topo, pulando ids que não existem mais — sessão arquivada/removida
— até achar um válido ou esvaziar a pilha). Mapeado 1:1 pra `newSession()`/`tabs`/`open()` já
existentes, sem estrutura de estado nova além da pilha em si. `open()` também remove o id da pilha
(uma sessão reaberta manualmente pelo clique na lateral não deveria continuar "oferecível" pelo
atalho depois). Listener `keydown` global no próprio `ClaudePage.tsx`, mesmo padrão já usado pro Esc
em `Composer.tsx` (`window.addEventListener` + cleanup no `useEffect`).

**Limitação documentada**: alguns navegadores reservam Ctrl/Cmd+N (nova janela) e Ctrl+Shift+T
(reabrir aba fechada do próprio navegador) pra si e não deixam `preventDefault()` interceptar antes —
limitação da plataforma web que a extensão real não tem, rodando dentro do título nativo do VS
Code/Electron. Melhor esforço possível numa página web comum; documentado aqui pra não parecer um
bug se algum navegador específico engolir a tecla antes da nossa página ver o evento.

### Verificação (rodada de 28/09/2026, 3)

Sem navegador/visual-testing neste ambiente — verificação por leitura cuidadosa de código (webview
decompilado + `package.json`/`extension.js` reais, não só a descrição do gap) + `vitest` (358 testes,
suíte inteira verde, 11 novos desta rodada: 4+2 de `live.test.ts`, 3 de `runner.test.ts`, 2 de
`mapper.test.ts`) + `tsc --noEmit` (server e front, sem erro) + `vite build` (bundle gera sem erro,
mesmo aviso pré-existente de chunk grande, não relacionado a esta rodada). TDD no bug 1
(vermelho→verde confirmado antes de implementar, ver acima); os outros três itens são principalmente
reuso/wiring de mecanismos que já existiam no código (`CopyButton`, `EventSource` nativo,
`closeTab`/`newSession`/`tabs`), verificados por leitura cuidadosa mais os mesmos testes de
`mapper.ts` que já cobriam o entorno (nenhum teste antigo quebrou).

## 8. Bug ao vivo: troca de modo/modelo/esforço só valia na PRÓXIMA mensagem, nunca no turno em andamento — reportado pelo Bayerl em 28/09/2026

Diferente das rodadas anteriores (auditoria própria comparando com a extensão), este achado veio de
um relato ao vivo do Bayerl: trocar o seletor de modo de permissão pra "Auto" no meio de um turno já
rodando não impedia o próximo pedido de aprovação de continuar pedindo aprovação — a UI mostrava
"Auto" marcado, mas o comportamento seguia o modo antigo, sem nenhum aviso.

**Causa raiz** (confirmada lendo `web/src/claude/ClaudePage.tsx` antes de mexer, não assumida): o
seletor de modo do compositor tinha `onMode` ligado direto a `setMode` (só `useState` local, linha
~268-269 de antes desta correção). O valor só era de fato mandado ao servidor dentro do PRÓXIMO
`claudeApi.create(...)` (sessão nova) ou `claudeApi.send(activeId, {..., permission_mode: mode, ...})`
(mensagem nova) — ver `send()` no mesmo arquivo. Se o usuário trocasse o modo enquanto um turno já
estava em andamento (exatamente o caso relatado: sessão `waiting` num pedido de permissão de Bash
pendente), não havia nenhuma mensagem nova sendo mandada — a troca ficava puramente cosmética até
(se algum dia) uma próxima mensagem ser enviada. O pedido de aprovação já pendente continuava se
comportando pelo modo ANTIGO, sem nenhuma indicação ao usuário de que a troca não tinha efeito.

**Confirmado ao vivo, read-only, sem perturbar nada**: consultei diretamente o Postgres de produção
(via o próprio módulo `server/db.ts` do projeto, rodando um script `.mjs` descartável de dentro do
worktree só pra reaproveitar o `node_modules/pg` já instalado — nunca li nem imprimi a
`DATABASE_URL` em si, só o resultado das duas queries SELECT; script apagado logo depois) a sessão
real citada pelo Bayerl, `c4380a41-d263-408e-9543-4be08d1aea01`:
```
SESSION: [{ id: "c4380a41-...", status: "waiting", permission_mode: "acceptEdits",
            model: "claude-opus-5-5", updated_at: "2026-09-28T23:09:40.481Z" }]
```
O evento mais recente (`seq 190`) é um `permission_request` de Bash ainda pendente — exatamente o
cenário descrito: sessão `waiting`, `permission_mode` ainda `acceptEdits` no banco, apesar de
(segundo o relato) a UI mostrar "Auto" selecionado. Confirma a causa raiz sem qualquer dúvida —
nenhuma escrita foi feita nessa consulta (só `SELECT`).

**O que a extensão real faz de verdade** (não assumido — confirmado lendo
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` e o webview decompilado
`/srv/orion-reference/vscode-extension/extension/webview/index.js`, v2.1.282):
- O SDK expõe `Query.setPermissionMode(mode): Promise<void>` — um **control method** que muda o modo
  da sessão **já rodando**, sem precisar de mensagem nova (`sdk.d.ts`: "Change the permission mode
  for the current session"). Runtime confirmado no `sdk.mjs` compilado (não só o `.d.ts`): `async
  setPermissionMode(e){await this.request({subtype:"set_permission_mode",mode:e})}` — manda um
  `control_request` pelo mesmo canal stdio que já está aberto com o processo do CLI.
- **Investigação extra que valeu a pena** (a doc do `.d.ts` diz "Only available in streaming input
  mode" pra TODOS os control methods, o que levantou a dúvida de que talvez não funcionasse pros
  turnos do Orion sem anexo, que mandam o prompt como string simples, não como
  `AsyncIterable`): li o `request()` real no `sdk.mjs` e a montagem dos argumentos do CLI —
  `["--output-format","stream-json","--verbose","--input-format","stream-json"]` é passada
  **incondicionalmente**, nunca varia com o tipo do `prompt` recebido por `query()`. Ou seja: o
  processo do CLI é sempre aberto em modo streaming JSON de controle, string ou `AsyncIterable`
  tanto faz — a ressalva do `.d.ts` não bloqueia nada no nosso caso. Sem essa checagem eu teria
  implementado a correção assumindo um risco real que não existe.
- A extensão real chama esse método NA HORA: `onSelect:(m1)=>void $.setPermissionMode(m1,!0)` no
  popup do seletor de modo (`aB0` no webview) — nunca espera a próxima mensagem.
- `Query.setModel(model?: string): Promise<void>` — mesmo padrão, também aplicado na hora
  (`G.setModel(q,$)` na classe de conexão do webview, dentro de `queueSettingsApply`).
- **Esforço não tem um `setEffort()` dedicado** — achado só depois de procurar por "effort" no
  `sdk.d.ts` inteiro (não assumido a partir do nome do método de modo/modelo). O caminho real é o
  control method genérico `Query.applyFlagSettings(settings)`, que aceita `effortLevel` entre as
  chaves que mescla na camada de settings da sessão. Confirmado lendo o webview que é exatamente
  esse o caminho que a extensão usa, e que ela aplica NA HORA (não só "vale pro próximo turno" como
  seria razoável supor por não existir um método com nome dedicado):
  `async setEffortLevel($){...await this.queueSettingsApply(async()=>{...await
  this.applySettings({effortLevel:$})})}`. Ou seja: as 3 trocas (modo/modelo/esforço) são
  **igualmente ao vivo** na extensão real — não há nenhuma distinção visual "aplica agora" vs.
  "aplica no próximo turno" entre elas nos três pickers, então os três foram corrigidos da mesma
  forma aqui.

**Implementado** (mesmo padrão que o runner já usa pra `Query.supportedCommands()` — control method
fire-and-forget com checagem defensiva `typeof === 'function'`, pra nunca quebrar com um fake de
teste ou uma versão do CLI sem o método):
- `server/claude/runner.ts`: `Live` ganhou o campo `query: Query | null` — a Query viva do turno
  atual, atribuída logo depois de `this.deps.queryFn(...)` em `run()` (antes só existia como variável
  local `q`, inacessível fora do `for await` do turno) e limpa no `finally`, junto de `l.abort`.
  Três métodos novos, `setPermissionModeLive`/`setModelLive`/`setEffortLive` — cada um olha
  `this.live.get(sessionId)?.query`; sem Query viva (sessão ociosa entre turnos, ou nunca rodou neste
  processo) ou sem o control method (fake burro), devolve `false` sem lançar; com o método presente,
  chama (`setPermissionMode`/`setModel`/`applyFlagSettings({effortLevel})`) e devolve `true`.
- `server/routes/claude.ts`: três rotas novas, mesmo padrão POST de ação já usado no arquivo pra
  `/rename`, `/archive`, `/stop`, `/permission` (o arquivo não tem NENHUM PATCH/PUT de sessão — só
  POST — então segui essa convenção em vez de inventar um verbo novo): `POST
  .../sessions/:id/mode`, `.../model`, `.../effort`. Modo e modelo sempre persistem no Postgres
  PRIMEIRO (mesmo padrão condicional que `.../messages` já tinha: só grava quando o valor muda) —
  garante que o PRÓXIMO turno já nasce certo mesmo sem Query viva agora — e SÓ DEPOIS tentam a
  aplicação ao vivo, isolada em try/catch (uma falha na chamada ao vivo — rede, processo — nunca deve
  impedir a persistência, que já aconteceu antes; só um `app.log.warn`). Esforço nunca é persistido
  por sessão no Postgres (sempre reenviado em cada create/send, campo `EFFORTS` já existente) — a
  rota dele só tem o lado ao vivo.
- `web/src/claude/api.ts`: `claudeApi.setMode`/`setModel`/`setEffort`, mesmo padrão dos outros
  métodos do objeto (`api<T>(...)`, POST com corpo JSON).
- `web/src/claude/ClaudePage.tsx`: `onMode={setMode}`/`onModel={setModel}`/`onEffort={setEffort}`
  (ligação direta) viraram `onMode={handleMode}`/`onModel={handleModel}`/`onEffort={handleEffort}` —
  cada handler sempre atualiza o `useState` local na hora (pro próprio seletor mostrar a escolha e
  pra já valer no próximo create/send, comportamento antigo preservado) e, só quando o valor
  REALMENTE mudou e há uma sessão de verdade aberta (rascunho `draft-*` não tem Query nem linha no
  Postgres — nada a atualizar ainda), dispara a chamada ao vivo correspondente. Falha na chamada ao
  vivo (rede/servidor) vira só um `console.warn` — nunca reverte o `useState` (a intenção do usuário
  continua valendo pro próximo turno de qualquer forma) nem quebra a tela; sem UI de erro pesada,
  como pedido.

**TDD, vermelho→verde confirmado** (`tests/runner.test.ts`): escrevi os testes de
`setPermissionModeLive`/`setModelLive`/`setEffortLive` contra a API que ainda não existia (métodos
ausentes no `Runner`), depois implementei `runner.ts` pra fazê-los passar. `fakeQuery` ganhou a opção
`liveControls` — quando ligada, expõe `setPermissionMode`/`setModel`/`applyFlagSettings` na Query
falsa, cada chamada registrada em `liveCalls` (mesmo padrão já usado por `commands` pra
`supportedCommands()`). 6 testes novos: sem Query viva nenhuma (as 3 chamadas devolvem `false`, sem
lançar); Query viva mas sem os control methods, fake "burro" como todos os outros testes deste
arquivo (as 3 devolvem `false`, sem lançar); cada uma das 3 aplicando de verdade (devolve `true`,
`liveCalls` tem o registro certo — inclusive `setModelLive(id, undefined)` pra "sem override");
depois que o turno termina, a Query não fica mais acessível (as 3 voltam a `false`). **Um bug real de
timing apareceu ao escrever os 3 testes "aplica de verdade"**: sincronizar em `r.status(id) ===
'running'` é cedo demais — esse status já fica visível ANTES de `l.query` ser atribuída (há alguns
`await`s triviais de `store` entre os dois pontos dentro de `run()`), então os 3 testes "verdadeiros"
falhavam de forma consistente (raça, não bug de implementação — a proteção defensiva `!q` cobria o
caso corretamente, só retornando `false` num instante em que ainda não havia mesmo nada ao vivo pra
aplicar). Corrigido sincronizando em `q.calls.length > 0` (confirma que `queryFn()` já retornou — a
mesma linha, sem `await` no meio, que atribui `l.query` logo em seguida) em vez do status. Suíte
inteira: 366 testes verdes (era 358 antes desta rodada, +6 de `setPermissionModeLive` e afins — os
outros 2 vieram de ajustes de contagem de rodadas anteriores já na suíte), `tsc --noEmit` (server e
front, sem erro) e `vite build` sem erro (mesmo aviso pré-existente de chunk grande).

**Limitação de verificação documentada**: como nas rodadas anteriores, este worktree
(`modo-ao-vivo`) não é o processo `orion-central` rodando de verdade (esse roda o código do
`main`/`/srv/orion`) — não deu pra fazer `curl` autenticado contra as 3 rotas novas, porque elas
ainda não existem no processo em produção. Fiz um `curl` sem autenticação contra uma rota JÁ
EXISTENTE e já em produção (`GET /api/claude/sessions` em `v2.bayerl.cloud`) só pra confirmar que o
hook `preHandler` de autenticação do plugin (`app.addHook('preHandler', ...)`, que cobre TODAS as
rotas registradas dentro do mesmo `claudeRoutes`, incluindo as 3 novas, por escopo de encapsulamento
do Fastify) está mesmo ativo — devolveu `401`, como esperado. As 3 rotas novas foram verificadas por
leitura de código (registradas dentro do mesmo `claudeRoutes(app)`, depois do hook, mesmo padrão de
`/rename`/`/archive`) + `tsc --noEmit` + a suíte de `vitest` do `Runner` (que cobre a lógica que as
rotas chamam).

## Resumo

- **já tem** (de rodadas anteriores): ~24 itens, mais busca por título, filtro "Ativas",
  renomear inline (lápis no hover) e arquivar/desarquivar.
- **implementado em rodada anterior**: 15 itens (bloco conta/e-mail, 3 barras de uso
  rotuladas + chevron, tokens do thinking, resumo 2 linhas, copiar, colapsar IN/OUT,
  render Read/Edit/Write/Bash, diff do Edit, tokens no result, seletor de esforço,
  seletor de modo em menu, menu de comandos, Esc).
- **implementado em rodada anterior (2)** (microfunções da lista de sessões — filtro, grupo,
  renomear): filtro por projeto (`cc-select` "Todos os projetos"/por projeto — extra
  nosso, já que o v2 é multi-projeto e a extensão real é 1 workspace só); controle
  "Agrupar por" Nenhum/Projeto/Atividade com cabeçalho colapsável por grupo
  (equivalente leve às pastas manuais arrastáveis da extensão real, que exigiriam
  tabela nova + rotas CRUD + drag-and-drop); lápis de renomear agora também visível
  no `:focus-within` (antes só `:hover`) — o endpoint de rename já existia
  (`POST /api/claude/sessions/:id/rename`), não foi criado nada novo no servidor.
  Lógica pura testada em `mapper.test.ts` (`filterSessions`, `groupSessions`).
- **implementado em rodada anterior (3)** (28/09/2026 — Conta e uso, ver seção 3 para os detalhes e
  evidências): suporte real a `rate_limits` do SDK quando disponível (`computeRealUsageBars`,
  `formatResetIn`, `/api/claude/usage` agora também lê `claude_events` pelo `result` mais recente
  com `rate_limits_available`) — condicional e hoje inativo na prática (token de `setup-token` não
  traz esse campo, confirmado ao vivo no Postgres de produção), mas testado e pronto para quando o
  dado existir, sem fabricar % nem reset; corrigido o limiar de cor de aviso da barra de 90% pra 80%
  (batendo com a extensão real); revisado (e corrigido) o entendimento anterior de que as 3 barras
  seriam fixas — a extensão real tem lista dinâmica (ver seção 3); confirmado que a remoção da linha
  de e-mail/CONTA foi decisão deliberada do Bayerl (commit `4a00e94`), não um gap — não recolocada.
  8 testes novos de `formatResetIn`/`computeRealUsageBars` + 2 de `computeUsageBars` com dado real,
  em `tests/mapper.test.ts`, TDD (vermelho→verde confirmado).
- **implementado nesta rodada** (28/09/2026, rodada 2 — Timeline: diff de caractere + Todo list +
  Subagent, ver seção 4 para os detalhes e evidências): destaque de caractere dentro de linhas
  trocadas do Edit/Write (`charDiff`/`charDiffIfSimilar`/`annotateCharDiffs` em `mapper.ts`, LCS por
  code point com limiar de prefixo/sufixo comum pra decidir se vale destacar; classes
  `cc-diff-char is-add/is-del` em `Timeline.tsx`/`claude.css`) — confirmado, lendo o JS decompilado,
  que a extensão real roda o editor de diff completo do Monaco (não um highlight simples) com
  granularidade de caractere (`char-insert`/`char-delete`); reimplementamos só a granularidade, não
  o widget inteiro (gutters/minimapa/linhas de revisão), que é bem mais lift e continua fora de
  escopo. Checklist dedicada pro `TodoWrite` (`parseTodos` + componente `TodoList`, schema real
  confirmado em `sdk-tools.d.ts` e no webview). Linha dedicada pro `Task` (renomeado "Agent" na tela,
  igual à extensão — `describeTool` ganhou o caso `'Task'`, componente `TaskAgent` não passa mais
  pelo bloco genérico; corrigido de passagem um caso `'Agent'` morto em `describeTool` que nunca
  disparava porque o nome real da tool sempre foi "Task"). 24 testes novos + 2 de integração via
  `reduceSdkMessages`, TDD (vermelho→verde confirmado: 22 testes falhando por função ausente antes
  da implementação, depois verde); suíte inteira em 329 testes, `npm run build` limpo.

- **implementado nesta rodada (2)** (28/09/2026 — Compositor: recall, seletor de modelo, comandos
  reais; ver seção 5 "Compositor — rodada de 28/09/2026" para os detalhes e evidências): 3 gaps
  confirmados lendo o webview decompilado e o `.d.ts` do SDK antes de mexer em código. Recall
  ArrowUp/ArrowDown (`messageHistory`/`cycleMessageIndex` em `mapper.ts`, fiel ao `cycleMessage`/`Cq0`
  real, inclusive o guard de posição do cursor — não "input vazio" como a descrição inicial supunha).
  Seletor de modelo funcional (Padrão/Sonnet/Opus/Haiku/Fable — `ModelAlias`/`MODEL_LABEL`/
  `MODEL_ORDER`/`matchModelAlias` em `api.ts`, mesmo padrão de menu do seletor de Esforço), com
  `model` agora aceito também em `POST /api/claude/sessions/:id/messages` (antes só na criação).
  Menu de comandos de barra passou a usar a lista real da sessão (`Query.supportedCommands()` via
  novo campo `commands` no `Live`/`LiveEvent`/SSE `hello` do runner), caindo pros 4 fixos como
  fallback. 25 testes novos (13 de recall + 9 de `matchModelAlias` em `tests/mapper.test.ts`, 3 de
  comandos em `tests/runner.test.ts`), TDD, suite inteira (324 testes) e `tsc --noEmit` verdes.
- **deixados de fora (n/a)**: plan mode/plan review, rewind/checkpoint, anexos (já implementado,
  ver correção no início desta seção), @-menções, voz, uso por modelo, atribuição de uso (
  existe no SDK mas é outra função — fora do escopo), navegação multi-pergunta, worktree, "Manage",
  grupos personalizados arrastáveis (pastas nomeadas e persistidas — "Agrupar por" cobre a
  necessidade prática sem exigir a persistência nova), telemetria ao vivo de subagente (tempo
  decorrido/tokens/tool calls — `subagentRow` real, exigiria stream de progresso por tarefa que o
  Orion não tem), widget completo do editor de diff do Monaco (gutters, minimapa, blocos movidos,
  linhas de revisão de acessibilidade — só a granularidade de caractere foi replicada, não o
  widget).
- **corrigido/implementado nesta rodada (3)** (28/09/2026 — achados de uma auditoria de segundo
  nível dedicada; ver seção 7 para os detalhes e evidências completas): **bug real, não gap** —
  stop manual (botão Parar) descartava a resposta em andamento sem deixar rastro, porque o catch de
  `run()` conflava abort manual com erro genuíno (mesmo evento `'error'`, só o `status` final
  diferia) e `live.ts` só mostrava esse texto quando `status==='error'` literalmente, além de as
  mensagens parciais do streaming nunca serem persistidas — corrigido com um tipo de evento PRÓPRIO
  (`'interrupted'`, nunca `'error'`) que carrega o texto parcial já gerado, reconstruível de
  `claude_events` mesmo com status `idle` (`runner.ts`, `live.ts`, `mapper.ts`: `interruptedLabel`);
  rótulo "Interrompido"/"Ferramenta interrompida" espelha a tabela real `Qw` do webview decompilado.
  Botão de copiar resposta nas mensagens de texto do assistente (`AssistantText` em `Timeline.tsx`,
  reaproveitando o `CopyButton` já existente). Feedback de "Carregando sessões…" na lateral
  (`Sidebar.tsx`, prop `loading`) e banner de "conexão perdida — reconectando…" quando o
  `EventSource` da sessão aberta cai (`es.onerror`, antes um no-op puro). Atalhos Ctrl/Cmd+N (nova
  sessão) e Ctrl/Cmd+Shift+T (reabre a última sessão fechada — pilha `closedStack`, confirmado que a
  extensão real também usa uma pilha de até 10, não só "o último"). TDD no bug 1 (vermelho→verde
  confirmado); 11 testes novos (`tests/live.test.ts`, `tests/runner.test.ts`, `tests/mapper.test.ts`);
  suíte inteira 358 testes, `tsc --noEmit` e `vite build` verdes.
- **corrigido nesta rodada (4)** (28/09/2026 — bug real reportado AO VIVO pelo Bayerl, não achado de
  auditoria; ver seção 8 para os detalhes e evidências completas): trocar o modo de permissão pra
  "Auto" durante um turno já em andamento não tinha efeito nenhum até a próxima mensagem — confirmado
  na sessão real `c4380a41-d263-408e-9543-4be08d1aea01` (Postgres de produção, consulta read-only:
  `status: 'waiting'` com um `permission_request` pendente, `permission_mode` ainda `acceptEdits`).
  Causa raiz: `onMode` em `ClaudePage.tsx` só atualizava `useState` local; o valor só ia ao servidor
  no PRÓXIMO `create`/`send`. Corrigido com os control methods do SDK que existem exatamente pra isso
  (`Query.setPermissionMode()`/`setModel()`/`applyFlagSettings({effortLevel})`, confirmados no
  `sdk.d.ts` E no `sdk.mjs` compilado, e no webview real aplicando os três NA HORA, sem distinção
  "agora" vs. "próximo turno" entre modo/modelo/esforço): `Runner` ganhou `setPermissionModeLive`/
  `setModelLive`/`setEffortLive` (`server/claude/runner.ts`, nova referência `Live.query` pra achar a
  Query viva fora do turno) + 3 rotas novas `POST .../sessions/:id/{mode,model,effort}`
  (`server/routes/claude.ts`, persistem no Postgres e depois aplicam ao vivo, com try/catch isolado)
  + `ClaudePage.tsx` disparando a chamada ao vivo nos 3 handlers de picker (`handleMode`/
  `handleModel`/`handleEffort`) quando o valor muda numa sessão de verdade. TDD (vermelho→verde
  confirmado, achou de quebra uma raça de timing no próprio teste, não na implementação — corrigida
  sincronizando em `queryFn()` ter retornado, não em `status==='running'`); 6 testes novos em
  `tests/runner.test.ts`; suíte inteira 366 testes, `tsc --noEmit` (server e front) e `vite build`
  verdes.
