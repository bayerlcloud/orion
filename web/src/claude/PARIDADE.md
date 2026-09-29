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
| Indicador "pensando" — ícone em ciclo (glifo, dá impressão de pulsar de tamanho, inclui o asterisco literal) + palavra em inglês trocando periodicamente, enquanto o turno roda (`spinnerRow_07S1Yg`, componente `Re`) | **implementado agora (28/09/2026, rodada 4)** | `ThinkingIndicator` em Timeline.tsx, `SPINNER_*`/`pickSpinnerWord`/`spinnerGlyphAt`/`spinnerWordDelayMs` em mapper.ts — ver seção nova abaixo |
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
| Card de permissão **docado** acima do compositor (`position:absolute;bottom:16px`, fora da área que rola) — nunca dentro da lista de mensagens | **implementado agora (28/09/2026, rodada 6 — pedido ao vivo do Bayerl; mecânica `position:absolute` real adotada de verdade na rodada 7)** | `PermissionDock` (Timeline.tsx) montado por `ClaudePage.tsx` como irmão do `Composer`, dentro do MESMO `.cc-float` flutuante — fora da `cc-timeline`/`cc-scroll` — ver seção nova abaixo |
| Composer + área de mensagens não divididos em blocos separados: input flutuante, centralizado, sobrepondo a área que rola, texto esmaecendo atrás dele (`inputContainer_07S1Yg`/`messageGradient_07S1Yg`) | **implementado agora (28/09/2026, rodada 7 — pedido ao vivo do Bayerl, apontando pra esta MESMA extensão como referência)** | `.cc-float`/`.cc-fade`/`.cc-chat` em `claude.css`, `floatRef`/`floatHeight`/`ResizeObserver` em `ClaudePage.tsx` — ver seção nova abaixo |
| Status do tool_use enquanto aguarda decisão (não mostrar "executando…" antes da aprovação) | **corrigido agora (28/09/2026, rodada 4)** | novo `ToolStatus` `'waiting'`, ligado pelo `toolUseId` real do SDK — ver seção nova abaixo |
| "Sim, e não perguntar de novo" (`Yes, and don't ask again`) | já tem | `allow_always` |
| Escopo do allow_always (session/settings) | n/a | sem UI de escopo; SDK decide |
| AskUserQuestion com opções (`questionBlock_hONcXw`, `optionLabel`, `radio`) | **corrigido agora** | `cc-ask`/`AskAnswer`: marcar opção só seleciona, um botão "Enviar respostas" finaliza; antes o 1º clique em qualquer opção já respondia tudo (sem dar pra marcar mais de uma em pergunta `multiSelect`), e a resposta ("Você respondeu") virava o JSON cru da pergunta em vez do texto escolhido — ver bug de `2026-09-28` |
| Navegação multi-pergunta (`navTab_hONcXw`, `navigationBar`) | n/a | renderizamos todas as perguntas em sequência, cada uma com sua própria seleção; "Enviar respostas" só habilita com todas respondidas |
| Todo list (`todoList_xheXVQ`, `todoItem`, pending/in_progress/completed) | **implementado agora (28/09/2026, rodada 2)** | checklist dedicada — ver nota abaixo |
| Subagent / tool `Task` (renderer interno "Agent", `class jD1{name="Agent"}`) | **implementado agora (28/09/2026, rodada 2)** | linha dedicada (não passa mais pelo bloco de ferramenta genérico) — ver nota abaixo |
| Painel "Agent map" (árvore raiz→agentes com duração/tokens por subagente) | **implementado agora (28/09/2026, rodada 8)** | pedido ao vivo do Bayerl — ver seção 13 |
| Plan mode / plan review (`ExitPlanMode`, `milestone*_UxGN1Q`) | n/a | fora de escopo (pedido) |
| Rewind / checkpoint (`rewind`, `changedFile_5FHdxw`, `checkoutButton`) | n/a | fora de escopo (arriscado) |
| Custo · duração · turnos no result (`metaMessage_07S1Yg`, `Total duration (API)`) | já tem | `cc-result` |
| Tokens de entrada/saída no result (`modelUsage`) | **implementado agora** | soma `modelUsage` → "N↑ / N↓ tokens" |
| Mensagem interrompida (`interruptedMessage_07S1Yg`) | **corrigido agora (28/09/2026, rodada 3)** | **era um bug, não "já tem"** — stop manual perdia o texto parcial de vez (some ao recarregar); ver seção nova abaixo |
| Botão copiar resposta (`assistantActions_07S1Yg`/`copyResponseButton_07S1Yg`, hover-revelado ao lado da mensagem) | **implementado agora (28/09/2026, rodada 3)** | reaproveita o `CopyButton` de Timeline.tsx (já usado em ferramentas/Task) nas mensagens de texto do assistente — ver seção nova abaixo |
| Miniatura de anexo de imagem numa mensagem do usuário JÁ ENVIADA, clicável → popup (componente `AI0`/`yw`, classes `previewOverlay_vRjSkQ` etc.) | **implementado agora (28/09/2026, rodada 7 — pedido ao vivo do Bayerl)** | antes: só chip com ícone+nome, nenhuma miniatura no histórico (gap real, confirmado); agora: miniatura de verdade + `Lightbox` — ver seção 10 |

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
**Atualização (28/09/2026, rodada 8 — pedido ao vivo do Bayerl, ver seção 13 "Mapa de agentes" pro
achado completo)**: a frase acima ("exigiria um stream de progresso por tarefa que o Orion não tem")
valia pro `subagentRow` condensado da TIMELINE — mas existe, À PARTE, um painel dedicado real
("Agent map", diálogo próprio, não a fileira condensada) que mostra a MESMA telemetria (duração,
tokens) sem depender desse stream de progresso — a duração vem do `ts` que `claude_events` já grava
por linha, os tokens de um campo estruturado do próprio `tool_result` (`tool_use_result`). Esse painel
foi implementado; o `subagentRow` condensado dentro da timeline continua não replicado (permanece
fora do escopo, ver seção 13 pro detalhe do porquê).
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
| Seletor de esforço Low/Medium/High/Extra high/Max (`effortLevel`, `modelPillEffort`) | já tem; **corrigido — troca ao vivo (28/09/2026, rodada 4)**; **corrigido — persistência (28/09/2026, follow-up)** | menu; envia `effort` no create/send, aplica na hora num turno já em andamento (seção 8) E agora sobrevive a reload/troca de aba, igual modo/modelo (coluna `claude_sessions.effort` — seção 10) |
| Seletor de modo de permissão (`modeOption_7kXHPg` Manual/Plan/Accept edits/Auto) | já tem; **corrigido — bug real de troca ao vivo (28/09/2026, rodada 4)** | menu visível (era só ciclo); trocar o modo durante um turno já em andamento era só cosmético até a próxima mensagem — bug real reportado pelo Bayerl, ver seção 8 |
| Anexar arquivos/imagens (`attachedFilesContainer_cKsPxg`, `onAddFiles`) | já tem | **linha desatualizada** — anexo com upload/preview/envio já foi implementado numa sessão anterior a esta tabela ser revisada (`POST /api/claude/uploads`, `Composer.tsx` attachments); não corrigida aqui por estar fora do pedido desta rodada, só sinalizada pra não confundir |
| Miniatura de anexo pendente clicável → popup (componente real `AI0`/`yw` — mesmo componente usado tanto no compositor quanto na mensagem já enviada, classes `previewOverlay_vRjSkQ`/`previewContainer_vRjSkQ`/`previewImage_vRjSkQ`/`previewCloseButton_vRjSkQ`) | **corrigido agora (28/09/2026, rodada 7 — pedido ao vivo do Bayerl)** | antes abria a imagem em nova aba (commit `5b445b6`, de uma sessão diferente no mesmo dia — o Bayerl pediu ao vivo pra trocar por um popup, nunca implementado até agora); agora abre o mesmo `Lightbox` usado pelo histórico — ver seção 10 |
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
## 9. Indicador "pensando" + investigação do "padrão de mensagens diferente do plugin" — rodada de 28/09/2026 (4)

Duas coisas reportadas ao vivo pelo Bayerl no mesmo dia das rodadas 1-3 acima: (1) "não tem aquela
animaçãozinha... quando está pensando que fica trocando a palavra com asterisco pulsando" (pedido
específico, já sabíamos o que construir); (2) "dá uma olhada... como as mensagens estão sendo
devolvidas... não é o mesmo padrão aqui do plugin... tá diferente" (pedido vago — investigação de
verdade, não um gap conhecido; usei a sessão de produção real
`c4380a41-d263-408e-9543-4be08d1aea01` — lida read-only do Postgres via `DATABASE_URL` de
`/etc/orion/central.env` — como base, em vez de dado sintético).

### Indicador "pensando" (ícone + palavra pulsando)

Lido o componente real `Re` (spinner) do webview decompilado v2.1.282
(`/srv/orion-reference/vscode-extension/extension/webview/index.js`) função por função antes de
implementar qualquer coisa:

- **Ícone**: `var sU0=["·","✢","*","✶","✻","✽"]` — 6 glifos do menor ao maior, **inclui o asterisco
  literal** (exatamente o que o Bayerl descreveu). Ciclados num vai-e-volta de 12 passos
  (`oU0=[...sU0,...[...sU0].reverse()]`) via `setInterval(...,120)` — cresce até a maior estrela e
  volta, em loop contínuo; é isso que dá a impressão de "pulsar" de tamanho (não é opacidade/glow via
  CSS — é substituição de caractere, JS puro).
- **Palavra**: lista real `VA1`, **84** verbos/gerúndios inventados em inglês ("Pondering",
  "Marinating", "Percolating", "Discombobulating", "Flibbertigibbeting" etc.) — extraída do bundle via
  `json.loads` (não digitada à mão, pra não errar nenhuma; conferida 1:1 num teste). Sorteada **sem**
  evitar repetição (mesma função real `_e($){return $[Math.floor(Math.random()*$.length)]}`) e trocada
  num cronograma fixo: 2s depois de montar, +3s (5s), +5s (10s), e a cada 5s dali em diante — tabela
  real `let K=[2000,3000,5000];return B<K.length?K[B]:5000` dentro do hook `rx`/`Cq0`.
- **Quando aparece — achado que corrige a suposição inicial do pedido**: o pedido original supunha que
  o indicador só aparece "no intervalo entre o fim do turno do usuário e o 1º token/tool_use", sumindo
  assim que algo começa a streamar. **Isso é falso** — confirmado lendo o código, não assumido: a
  extensão real condiciona a exibição a `visiblyBusy.value && !permissionRequests.value.length`
  (`visiblyBusy = busy && !hostUnresponsive`; `busy` fica `true` do `system/init`/início do turno até
  `endTurn()`, ou seja, **o turno inteiro**, não só o intervalo antes do 1º conteúdo). O spinner é
  posicionado (`N5`) **depois** de todas as mensagens/grupos já renderizados desse turno, como uma
  linha persistente abaixo do que já streamou — só some quando (a) um pedido de permissão aparece (o
  card de permissão toma o lugar), ou (b) o turno termina. Reimplementado fiel a isso: no Orion,
  `status==='running'` já É exatamente essa condição (`'waiting'` só existe quando há permissão
  pendente — ver `runner.ts`), então não precisou de estado novo.
- **Diferente da extensão real**, que roda um efeito de "decodificação" caractere a caractere a cada
  troca de palavra (função `A85`: cursor de bloco + flicker de 2-3 caracteres via
  `requestAnimationFrame` a cada ~40ms até assentar no texto final — um motor de scramble completo):
  aqui a palavra troca com um fade CSS simples (`key={word}` + `@keyframes cc-fade-in`). Mesma ideia
  (a troca não é um corte seco), sem reimplementar o motor inteiro — decisão de escopo no mesmo
  espírito da já tomada pro diff de caractere (seção 4: granularidade replicada, não o motor completo
  do Monaco).

**Implementado**: `web/src/claude/mapper.ts` — `SPINNER_GLYPHS`/`SPINNER_GLYPH_SEQUENCE`/
`SPINNER_GLYPH_INTERVAL_MS`/`spinnerGlyphAt` (ciclo do ícone); `SPINNER_WORDS` (as 84 palavras);
`spinnerWordDelayMs`/`pickSpinnerWord` (cronograma e sorteio). `web/src/claude/types.ts`: `ConvEvent`
ganhou o caso sintético `kind:'busy'` (nunca persistido). `web/src/claude/live.ts`: `toConvEvents`
empurra esse evento por último quando `s.status==='running' && !s.interrupted` (o guard extra evita um
flash de 1 frame junto do bubble de interrupção, na janela entre o evento `'interrupted'` chegar — que
não mexe em `status` — e o `'status':'idle'` que o runner manda logo depois). `web/src/claude/
Timeline.tsx`: componente `ThinkingIndicator` (dois `useEffect`: um `setInterval` de 120ms pro glifo,
um `setTimeout` recursivo fiel ao cronograma `rx` real pra palavra) — como o React casa esse elemento
pela `key` fixa `'live-busy'`, ele só desmonta/remonta numa transição real de visibilidade (turno
começa/pausa em permissão/termina), nunca a cada streaming parcial, igual ao `Re` real (que só existe
enquanto `t0` é verdadeiro). `web/src/claude/claude.css`: `.cc-live`/`.cc-live-icon`
(`animation: cc-pulse`)/`.cc-live-word` + `@keyframes cc-fade-in` (nova).

**Mantido em inglês de propósito**: a lista de palavras não foi traduzida pro PT-BR, ao contrário da
maior parte do resto da tela — mesma convenção já usada pra "Agent"/"Task"/"Fable"/nomes de modelo
(seções 3-4 acima): é a personalidade "Claude-y" do produto, e boa parte da lista são portmanteaus
("Discombobulating", "Flibbertigibbeting") sem equivalente natural em PT-BR que preserve a graça.

**TDD**: 20 testes novos em `tests/mapper.test.ts` (`spinnerGlyphAt`: glifo em cada passo do ciclo,
volta, índice negativo; `SPINNER_WORDS`: 84 palavras, sem duplicata, contém as citadas no pedido;
`spinnerWordDelayMs`: tabela 2000/3000/5000/default; `pickSpinnerWord`: `rand` injetável,
determinístico, lista vazia) + 7 em `tests/live.test.ts` (`toConvEvents`: aparece com `status
running`, some com `waiting`/`idle`/`error`, continua visível com texto parcial já streamando —
regressão direta da suposição errada do pedido —, aparece/some ao vivo, guard da interrupção).

### Investigação: "o padrão de mensagens tá diferente do plugin"

Usei `superpowers:systematic-debugging` (Fase 1-2: evidência antes de hipótese) em vez de tentar
adivinhar o que "parece diferente". Reli as seções 4 e 7 desta tabela primeiro (já cobrem: resumo
tool de 2 linhas, colapsar IN/OUT, diff de caractere, Todo list, Task/Agent, AskUserQuestion — nenhuma
delas é o que falta aqui) e depois comparei, elemento por elemento, contra o webview decompilado
v2.1.282, grounded na sessão de produção real `c4380a41-d263-408e-9543-4be08d1aea01` (191 eventos
lidos via `claude_events`, node + `pg` — mesmo padrão de leitura read-only já usado noutras tarefas do
dia).

**Achado 1 (estrutural, não um bug de linha de código) — o card de permissão real é DOCADO, não faz
parte da lista que rola.** Confirmado em duas camadas independentes do bundle:
- JSX: o container do card de permissão (`F("div",{ref:q,className:f0.permissionsContainer,
  children:F(qW0,{request:N,...})})`) é renderizado **fora** do `messagesContainer` que rola — é
  filho de um `inputContainer` que vem **depois** do fim da lista de mensagens (`N5`/spinner,
  `heldPrompts`, o spacer de altura) e **antes** do composer de verdade (`F5`).
- CSS: `.inputContainer_07S1Yg{position:absolute;z-index:20;bottom:16px;left:16px;right:16px}` — um
  overlay fixo ancorado no rodapé da viewport, nunca move com o scroll do histórico.
  `.messagesContainer_07S1Yg{overflow-y:auto;...}` é a área que rola, separada.
- Consequência: a extensão real nunca deixa um card de permissão "perdido no meio do histórico" — só
  existe UM card interativo por vez, sempre visível, sem precisar rolar. E **não sobra bubble
  nenhuma** no histórico depois de decidir — o único rastro que fica é o próprio dot de status do
  tool_use (`waiting`→`running`/concluído, componente `c85`: `Z?F(iY,{state:"waiting"}):...`).
- O Orion faz diferente: `cc-perm` é um evento normal dentro de `cc-timeline`, que rola junto com
  tudo — numa sessão longa e cheia de Bash com aprovação (como a de produção usada aqui: 5 pedidos de
  permissão em 191 eventos), o usuário precisa rolar pra cima pra achar o card ativo, e o histórico
  acumula uma fileira de bubbles "Permitido, sem perguntar de novo · `<comando>`" (extra nosso — a
  extensão real não deixa NENHUM rastro assim; só o dot do tool_use muda). Bate com a descrição do
  Bayerl (as duas capturas de tela mostravam exatamente essa fileira acima do card ativo).
- **Não corrigido nesta rodada — documentado como item maior pra rodada futura, de propósito.** Mudar
  isso é uma mudança de arquitetura de UI (tirar o card de permissão da `cc-timeline`, decidir onde ele
  vive perto do compositor, decidir o que acontece com a fileira "Permitido..." que já existe hoje e
  se o Bayerl quer manter essa trilha de auditoria — ele não pediu pra remover), não uma correção
  pequena. Também esbarraria em `ClaudePage.tsx`/`Composer.tsx` — que um agente irmão está mexendo
  concorrentemente num bug não relacionado de troca de modo ao vivo, nesta mesma janela de tempo — e a
  instrução deste round foi explicitamente não tocar lá. Ver tabela na seção 4 acima (nova linha "Card
  de permissão docado").

**Achado 2 (bug real, raiz confirmada no `.d.ts` do SDK) — o tool_use mostrava "executando…" ANTES do
usuário aprovar.** Investigado a partir do Achado 1: como o `reduceSdkMessages` cria o bloco da
ferramenta (`kind:'tool', status:'running'`) assim que o SDK manda o `tool_use` — **antes** de
qualquer permissão ser concedida — e o `Tool`/`TaskAgent` em Timeline.tsx mostravam "executando…"
sempre que `status==='running'` e não havia `output` ainda, um comando esperando Sim/Não já aparecia
como se estivesse rodando. Rastreei a causa raiz (não um heurístico — o `.d.ts` real do SDK, não uma
suposição): `CanUseTool` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) documenta
`options.toolUseID: string` — "Unique identifier for this specific tool call within the assistant
message" — só que `server/claude/runner.ts` **descartava esse campo por completo**: o `canUseTool`
implementado ali usa `const pid = randomUUID()` (um id do próprio Orion, sem relação nenhuma com o id
do SDK) como identificador do pedido de permissão, e nunca lia/repassava `opts.toolUseID` pra lugar
nenhum. Sem esse id real, não havia NENHUMA forma de ligar o bloco de ferramenta ao pedido de
permissão que é dele de verdade (nem heurística por nome/input dava pra confiar — dois Bash seguidos
com comandos parecidos existem na sessão real usada aqui).

Grounding no exemplo real: sessão `c4380a41-d263-408e-9543-4be08d1aea01`, seq 29 (`assistant`,
tool_use Bash, id `toolu_01Rt1vpAf4CECJztM2s5gdqZ`) seguido em seq 30 de um `permission_request` pro
mesmo comando (`grep -n -i "nível\|nivel\|root\|level" web/src/pages/SpecMemoria.tsx | head -60; ...`)
— entre os dois, o bloco da ferramenta já mostrava "executando…" nessa sessão real, sem o usuário ter
decidido nada ainda (confirmado lendo o payload bruto dos dois eventos; a correlação `toolUseID ↔
tool_use.id` em si vem do `.d.ts` do SDK, não foi observável retroativamente nesses dados antigos —
são eventos persistidos ANTES da correção, e por isso nunca gravaram `toolUseId`).

**Implementado** (pequeno, escopado, não mexe em `ClaudePage.tsx`/`Composer.tsx`):
- `server/claude/runner.ts`: `opts.toolUseID` agora é repassado pro evento persistido
  (`appendEvent(..., 'permission_request', {..., toolUseId: opts.toolUseID})`) e pro evento ao vivo
  (`emit(..., {type:'permission_request', ..., toolUseId: opts.toolUseID})`) e guardado em `Pending`
  (`l.pending.set(pid, {..., toolUseId: opts.toolUseID})`). `LiveEvent`'s `'permission_request'` e o
  tipo `Pending` ganharam o campo (opcional — eventos antigos, persistidos antes desta correção, não
  têm). `store.createApproval`/a tabela `claude_approvals` **não** foram tocados — o campo só precisa
  existir no log de eventos, que é a única fonte que `fromRows`/`applyLive` leem.
- `web/src/claude/types.ts`: novo valor de `ToolStatus`, `'waiting'` — nunca vem direto de
  `reduceSdkMessages` (que só conhece `'running'`); é aplicado depois.
- `web/src/claude/mapper.ts`: `applyPendingToolWaitStatus(events, pendingToolUseIds)` — pura, corrige
  `status:'running'` pra `'waiting'` só no evento `tool` cujo `toolUseId` bate (não um heurístico) com
  algum pedido **ainda pendente**; nunca regride um evento que já tem `output` ou já terminou
  (`success`/`failure`/`warning`). `toolRunningLabel(status)` — "aguardando permissão…" pra `waiting`,
  "executando…" pro resto. `taskStatusLabel` ganhou o caso `waiting` também (sem ele, um Task ainda
  aguardando aprovação cairia no `else` final e apareceria rotulado "Concluído" — o oposto do que é
  verdade; bug que essa correção evita reintroduzir).
- `web/src/claude/live.ts`: `PermReq` ganhou `toolUseId?`; `fromRows`/`applyLive` capturam o campo do
  payload; `toConvEvents` aplica `applyPendingToolWaitStatus` com os `toolUseId` de `s.pending`
  (nunca `resolvedPerms` — uma vez resolvida, se ainda `running`, é porque está rodando de verdade).
- `web/src/claude/Timeline.tsx`/`claude.css`: `Tool`/`TaskAgent` tratam `status==='waiting'` igual a
  `'running'` pra mostrar o corpo OUT-pendente, mas com `toolRunningLabel` (rótulo diferente) e classe
  `.is-waiting` (cor `--cc-pending`, mesma da bolinha `cc-dot.is-waiting` que já existia, **sem** o
  pulso de "rodando de verdade" — é uma ferramenta parada esperando decisão, não em execução);
  `dotClass` mapeia `'waiting'` pro dot `dot-pending` (estático) em vez do `dot-progress` (piscando).

**TDD**: 1 teste novo em `tests/runner.test.ts` (o `toolUseId` real chega no evento ao vivo E no
persistido) + 9 em `tests/mapper.test.ts` (`toolRunningLabel`; `applyPendingToolWaitStatus`: caso real
grounded na sessão de produção, id diferente não mexe, não regride de success/failure/warning, ignora
eventos não-tool, aceita Set ou array, várias ferramentas na mesma timeline só a certa muda; 1 caso
novo de `taskStatusLabel`) + 4 em `tests/live.test.ts` (`toConvEvents`: reconstrução pós-reload vira
`waiting`, ao vivo vira `waiting` assim que o pedido chega, volta a refletir o resultado normal depois
de resolvido + tool_result, dado antigo sem `toolUseId` degrada bem sem quebrar — nunca regride pra
pior que o comportamento de sempre).

**O que NÃO foi encontrado/não é gap**: o formato "Você respondeu: {resposta}" do AskUserQuestion (já
corrigido numa rodada anterior do mesmo dia, confirmado funcionando nas duas capturas de tela do
Bayerl) e o card "Aguardando sua permissão" com comando completo + descrição + botões Sim/"Sim, e não
perguntar de novo"/Não + campo de texto livre (seção 4, "já tem") batem, elemento por elemento, com o
que a extensão real mostra dentro do próprio card — a diferença não estava no CONTEÚDO do card, estava
em ONDE ele fica (Achado 1) e no fato de o tool_use por trás mentir sobre já estar rodando (Achado 2).

### Verificação (rodada de 28/09/2026, 4)

Sem navegador/visual-testing neste ambiente — verificação por leitura cuidadosa do webview decompilado
+ `sdk.d.ts` real (não só a descrição dos pedidos) + a sessão de produção real via Postgres (read-only,
`DATABASE_URL` de `/etc/orion/central.env`) + `vitest` (403 testes, suíte inteira verde, 43 novos
desta rodada, confirmado via `git diff`: 31 de `mapper.test.ts` (20 do indicador "pensando" + 11 do
status `waiting`), 11 de `live.test.ts` (7 + 4), 1 de `runner.test.ts`) + `tsc --noEmit`
(server e front, sem erro) + `vite build` (bundle gera sem erro, mesmo aviso pré-existente de chunk
grande).

### Card de permissão docado — rodada de 28/09/2026 (6)

Pedido AO VIVO do Bayerl, nas próprias palavras: "conseguimos copiar a UI do plugin do Claude aqui...
que abre as perguntas... aquele box que sobe? e colocar lá no Claude do Orion v2" — fecha o gap
**estrutural** documentado no Achado 1 da rodada 5 acima ("Card de permissão docado"), que tinha sido
deixado de propósito pra uma rodada futura por ser mudança de arquitetura de UI, não uma correção
pequena.

**Reconfirmando o Achado 1** (não só confiando na rodada anterior) — reli `webview/index.js`/
`index.css` v2.1.282 direto (`/srv/orion-reference/vscode-extension/extension/webview/`), com foco
nos pontos que o pedido pedia explicitamente pra verificar:

- **Estrutura real**: dentro do componente que monta `inputContainer`, a ordem dos filhos é
  `[awsAuthInProgress banner, diálogos T6 (refusal_fallback etc.), h8 && permissionsContainer(qW0),
  hostUnresponsive banner, F5 (composer de verdade)]` — o card de permissão e o composer são
  IRMÃOS dentro do mesmo `inputContainer`, e esse `inputContainer` inteiro é irmão de
  `messagesContainer` (a área que rola), nunca filho dela. Confirmado lendo o JSX bruto, não só a
  descrição da rodada anterior.
- **CSS exato** (extraído com `grep -oP` do `index.css` minificado, não digitado de memória):
  `.inputContainer_07S1Yg{position:absolute;display:flex;z-index:20;flex-direction:column;
  max-width:680px;margin:0 auto;bottom:16px;left:16px;right:16px}` e
  `.permissionsContainer_07S1Yg{width:100%;max-width:680px;margin:0 auto}` (mais
  `.hostUnresponsive_07S1Yg .permissionsContainer_07S1Yg{display:none}` — o card some se o host VS
  Code parar de responder). `.messagesContainer_07S1Yg{overflow-y:auto;overflow-x:hidden;...}` é a
  área que rola, separada.
- **Animação de entrada — checado exaustivamente, não assumido**: a suposição inicial do pedido
  ("aquele box que sobe" pode sugerir uma animação de subida) foi verificada e **não existe nenhuma**
  ligada a esse card. Busquei três formas independentes de animação no bundle inteiro: (1) toda regra
  CSS de `permissionRequestContainer_qlaBag` (o card em si — 20+ declarações, nenhuma com
  `animation`/`transition`), `permissionsContainer_07S1Yg` e `inputContainer_07S1Yg` (idem); (2) todo
  `@keyframes` do arquivo (`grep -oP '@keyframes...'`) — existem vários `fadeIn_<hash>` com
  `translateY(10px)→translateY(0)` (que SERIAM a "subida"), mas nenhum deles é referenciado por
  NENHUMA classe do CSS (confirmado buscando cada hash isoladamente) — são CSS morto de outros
  componentes (menus/dropdowns do compositor), não usados no card de permissão; (3) `grep -c
  '\.animate\('` no JS inteiro (5.3MB decompilado) devolveu **zero** — nenhuma chamada de Web
  Animations API em lugar nenhum do bundle. Conclusão: o "sobe" que o Bayerl descreveu é o efeito
  ESTRUTURAL de `position:absolute;bottom:16px` (a caixa cresce a partir do rodapé fixo quando o
  conteúdo aumenta — o topo sobe, o fundo não se move), não uma transição CSS nem JS. **Não inventada
  nenhuma animação aqui** — nem `@keyframes` nem `transition` novos em `claude.css` pra este card, de
  propósito, seguindo a instrução explícita de não inventar o que não foi encontrado.
- **Só um card por vez, confirmado nos dois lados** (front real E nosso runner, não só um dos dois):
  - Front real: `N=$.permissionRequests.value[0]` (sempre o primeiro elemento) e o card só monta
    quando `h8=dx($)` é verdadeiro, onde `function dx($){return
    $.permissionRequests.value.length>0&&!$.promptInputActive.value}` — ou seja, mesmo que
    `permissionRequests` tenha mais de um pedido, só o `[0]` vira UI; os demais ficam na lista,
    invisíveis, até o primeiro ser decidido (o mesmo array também aparece esvaziando a dúvida: `let
    n2=$.permissionRequests.value.length>0` é comparado com `>0`, nunca com `===1`, então o código
    real já pressupõe que pode haver mais de um).
  - Nosso modelo de concorrência (`server/claude/runner.ts`): `l.pending` é um `Map<string,Pending>`
    **sem serialização nenhuma** — cada chamada de `canUseTool` do SDK cria sua própria entrada
    (`pid=randomUUID()`), então nada no runner impede duas chamadas ficarem pendentes ao mesmo tempo
    se o SDK despachar tool_use independentes em paralelo no mesmo turno. Escrevi um teste que RODA o
    runner de verdade (não só lê o código) chamando `canUseTool` duas vezes via `Promise.all` antes de
    qualquer uma resolver (`tests/runner.test.ts`, "duas chamadas de canUseTool no mesmo turno, sem
    esperar a 1ª resolver, ficam as DUAS pendentes ao mesmo tempo") — confirma `pendingPermissions()`
    com 2 entradas simultâneas, decide uma independente da outra. Ou seja: o pressuposto de "só uma
    pendência por vez" NÃO é garantido pelo nosso runner (nem pelo SDK, pelo jeito que o front real
    lida com isso) — por isso `currentPermission` (abaixo) existe como função dedicada, e não um
    simples "pega o `s.pending[0]`" direto no componente.
- **Sem bubble persistido depois de decidido — confirmado, não só copiado da rodada anterior**: os
  únicos filhos de `inputContainer` são a lista fixa acima; depois que `h8` vira falso (nenhum pedido
  pendente), NADA relacionado a permissão continua montado ali — nem no `inputContainer`, nem em
  `messagesContainer` (que nunca teve o card, ponto anterior). O único traço que sobra em QUALQUER
  lugar da tela é o dot de status do próprio tool_use (componente `c85`/`iY` real; no Orion,
  `dotClass()`/`.cc-msg::before` em Timeline.tsx/claude.css, já existente, não tocado nesta rodada).

**Decisão sobre o bubble "Permitido, sem perguntar de novo · `<comando>`" que o Orion tinha**:
removido, pra bater com o comportamento real ponto a ponto (nenhum rastro depois de decidido — nem
pra Bash/Edit, nem pra `AskUserQuestion`/"Você respondeu"). Verifiquei que isso não deixa o usuário
sem NENHUM jeito de saber o que aconteceu: o `tool_use` por trás de toda decisão (`allow`,
`allow_always`, `deny`, `answer`) sempre acaba recebendo um `tool_result` de verdade do SDK — `allow`/
`allow_always` deixam a ferramenta rodar e o resultado normal chega (`status: success/failure`);
`deny`/`answer` resolvem `canUseTool` com `{behavior:'deny', message: ...}`, que o SDK devolve como
`tool_result` com erro pro modelo, e isso já vira `status:'failure'` no bloco da ferramenta (ver
`reduceSdkMessages` em mapper.ts, inalterado nesta rodada) — ou seja, o dot de status do próprio
`tool_use` (que já existia, sem mudança) é exatamente o "único rastro" que o Achado 1 descreveu, para
TODOS os casos de decisão. Único caso que eu deliberadamente **mantive** diferente da extensão real:
pedidos com `decision==='timeout'` (`foldExpiredPermissions`) continuam aparecendo na `cc-timeline`,
colapsados. Motivo: um timeout do Orion pode vir de um restart do processo no meio de um pedido
pendente (`l.pending` só existe em memória — ver comentário de `foldExpiredPermissions` em mapper.ts);
nesse cenário específico, o turno original pode nunca chegar a receber nenhum `tool_result` de
verdade (o `for await` daquele turno já morreu com o processo antigo), e a única forma do usuário
saber que aquele pedido nunca mais vai ser respondido — sem esse bubble, ficaria com um bloco de
ferramenta preso em "aguardando permissão…" pra sempre, sem nenhuma pista. A extensão real não precisa
disso porque o processo dela (extensão VS Code) não reinicia do jeito que o Orion reinicia; é uma
situação que só existe aqui. Documentado como desvio deliberado, seguindo o padrão do resto deste
arquivo.

**Composer continua visível/habilitado enquanto uma permissão está pendente** (diferente da extensão
real, que troca `display:none` no composer de verdade enquanto `h8` é true, forçando decidir antes de
escrever mais nada — `style:{display:h8||f9?"none":"block"}` no `promptInputContainer`). Deliberado:
o placeholder atual do Orion já é "Claude está trabalhando… você pode enfileirar a próxima mensagem"
(`Composer.tsx`) — enfileirar mensagem durante uma permissão pendente é comportamento existente do
Orion, não coberto por este pedido, e escondido o composer quebraria essa função sem necessidade.
Fora de escopo mexer nisso aqui ("Keep the diff scoped to this one gap").

**Implementado**:
- `web/src/claude/mapper.ts`: `currentPermission(events)` — pura; primeiro evento `kind:'permission'`
  sem `decision` (nem `'timeout'`), na ordem em que aparece (mesma ordem de `s.pending`, FIFO).
- `web/src/claude/Timeline.tsx`: `Permission` (antes função interna, sem export) virou exportada, sem
  nenhuma mudança de comportamento — continua sendo o mesmo componente que decide Bash/Edit e
  `AskUserQuestion`, com as mesmas classes CSS. Novo componente exportado `PermissionDock({event,
  onDecide})`: `null` sem pedido pendente; senão, `<div className="cc-perm-dock"><Permission .../></div>`.
  No loop principal de `Timeline`, uma linha nova pula QUALQUER evento `permission` cuja `decision` não
  seja `'timeout'` (pendente OU já decidido) — o pendente foi pro card docado, o decidido não deixa
  rastro nenhum (ver decisão acima); `foldExpiredPermissions` continua rodando sobre a lista inteira
  ANTES desse filtro (não muda o agrupamento de timeouts consecutivos).
- `web/src/claude/ClaudePage.tsx`: `dockedPermission = useMemo(() => currentPermission(events),
  [events])`; a área que antes só tinha `{activeId && <Composer .../>}` agora é `{activeId && (<div
  className="cc-dock"><PermissionDock event={dockedPermission} onDecide={decide}
  /><Composer .../></div>)}` — MESMO item do grid de `.cc-main` que o `Composer` sozinho já ocupava
  (não uma linha nova: `grid-template-rows` de `.cc-main` não mudou), então nenhum ajuste de contagem
  de linhas do grid foi necessário.
- `web/src/claude/claude.css`: `.cc-dock` (flex column, o wrapper) + `.cc-perm-dock` (margem lateral
  igual à do `.cc-composer`, sem margem inferior — a margem superior do próprio `.cc-composor` já dá o
  espaçamento entre os dois quando o card aparece). **Sem overlay `position:absolute` e sem o spacer
  via `ResizeObserver`** que a extensão real usa pra não tapar o fim do histórico atrás do card
  flutuante (nenhum outro componente deste código usa esse padrão, e introduzir medição de altura via
  JS só pra isso seria over-engineering pra um efeito que o grid normal já resolve): como `.cc-dock`
  ocupa o mesmo item de grid que o composer sempre ocupou, ele simplesmente cresce pra cima quando o
  card de permissão aparece, empurrando `.cc-scroll` (que já tem `min-height:0`) pra cima — mesmo
  resultado visual líquido (card sempre visível, nunca perdido atrás de nada, nunca precisa rolar),
  sem herdar a complexidade do overlay real. Documentado como desvio deliberado da mecânica exata
  (`position:absolute`), não do resultado.
- Nada em `mapper.ts`/`live.ts` mudou na PRODUÇÃO de eventos (`toConvEvents`/`reduceSdkMessages`/
  `foldExpiredPermissions` continuam devolvendo exatamente os mesmos dados de antes, resolvidos E
  pendentes) — só o que `Timeline.tsx`/`ClaudePage.tsx` fazem com esses dados mudou (onde renderizar
  cada `kind:'permission'`, e um a mais que nenhum lugar renderiza mais). Isso foi deliberado pra não
  arriscar nenhuma das rodadas anteriores que tocam essa mesma área no mesmo dia: `foldExpiredPermissions`
  (rodada 5, folding de timeouts consecutivos), `applyPendingToolWaitStatus`/status `waiting` (rodada
  4), `interruptedLabel`/estado `interrupted` (rodada 3, turno cortado por stop manual) — todos
  continuam produzindo os mesmos `ConvEvent[]`, testados pelos MESMOS testes de antes (nenhum teste
  existente foi alterado, só estendido com casos novos).

**TDD**: `superpowers:test-driven-development` — testes escritos antes da implementação, ciclo
vermelho→verde confirmado rodando `vitest` no meio do processo (não só no final). 8 testes novos em
`tests/mapper.test.ts` (`currentPermission`: sem pedidos, só resolvidos, só expirados, um pendente,
dois pendentes ao mesmo tempo mostra só o 1º, misturado com resolvido, misturado com expirado,
entremeado com outros tipos de evento) + 1 em `tests/runner.test.ts` (roda o runner de verdade com
duas chamadas paralelas de `canUseTool`, confirma as duas pendências simultâneas e que decidir uma não
afeta a outra — base empírica, não só leitura de código, pro pressuposto de `currentPermission`).

**Verificação**: sem navegador/visual-testing neste ambiente (mesma limitação de sempre) — leitura
cuidadosa e exaustiva do webview/CSS decompilados v2.1.282 (JSX real, CSS exato via `grep -oP`, busca
por TODA forma de animação no bundle — CSS ligado a classe, `@keyframes` órfão, `.animate(` JS — antes
de concluir que não existe nenhuma) + `vitest` rodado nos dois lados do diff pra confirmar o delta
exato: 420 testes (23 arquivos) na branch ANTES desta rodada (`git stash` + `vitest run` +
`git stash pop`), 429 testes (23 arquivos) DEPOIS — os 9 novos (8 + 1 acima), suíte inteira verde nos
dois momentos, nenhum teste existente alterado ou quebrado + `npm run typecheck` (`tsc -p
tsconfig.server.json` e `tsc -p tsconfig.json`, os dois `--noEmit`, sem erro) + `npm run build` (`vite
build` limpo, mesmo aviso pré-existente de chunk grande, sem relação com esta mudança).

## 10. Persistência do esforço entre reload/troca de aba — follow-up pedido pelo Bayerl em 28/09/2026

Depois da rodada 4 (seção 8 acima), que trouxe modo/modelo/esforço a paridade de aplicação AO VIVO
(`Query.setPermissionMode`/`setModel`/`applyFlagSettings`), o Bayerl pediu explicitamente um
follow-up no mesmo dia: aquela rodada não cobria **persistência**. `permission_mode` e `model` já
eram colunas de `claude_sessions` (`server/migrations.ts`) e já eram restaurados no efeito de carga
de sessão de `ClaudePage.tsx` (`s.permission_mode`/`matchModelAlias(s.model)`) — cada sessão lembra
seu próprio modo/modelo mesmo depois de reload ou troca de aba. `effort` não tinha equivalente
nenhum: sem coluna em `server/migrations.ts` (confirmado por grep antes de mexer, não assumido), sem
nenhuma linha tocando `effort` no efeito de carga, backed só por um `useState<Effort>('medium')`
compartilhado entre qualquer aba ativa — resetava pra `'medium'` a cada reload/troca de aba,
confirmado ao vivo pelo Bayerl (motivo explícito do pedido).

**Implementado**, mesmo padrão persist-then-live-apply que a seção 8 já tinha estabelecido pra
modo/modelo, agora estendido a `effort`:

- **Migração `009_claude_effort`** (`server/migrations.ts`, seguinte à `008_tools_details`, última
  usada): `ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS effort TEXT` — nullable, sem
  `DEFAULT`, mesmo tipo de `model` (não de `permission_mode`, que é `NOT NULL DEFAULT
  'acceptEdits'`): sessão sem esforço explícito escolhido é um estado válido ("sem override", deixa o
  SDK/conta decidir), não um valor ausente que precisa de um default fixo gravado no banco. Conferido
  ao vivo, read-only, contra o Postgres de produção (`information_schema.columns` de
  `claude_sessions` + `schema_migrations`) antes de implementar: produção ainda em `008_tools_details`
  (migração nova ainda não rodou lá — este worktree não é o processo `orion-central` de verdade,
  mesma limitação já documentada nas rodadas anteriores), `model` é de fato `TEXT` nullable sem
  default, confirmando que a tipagem nova replica exatamente esse padrão.
- **`POST /api/claude/sessions`** (criação): passou a gravar `effort` no `INSERT`, junto de
  `model`/`permission_mode` — antes só era passado pro `runner.startTurn`, nunca persistido em
  Postgres nenhum.
- **`POST /api/claude/sessions/:id/messages`** (mensagem numa sessão existente): já lia `effort` do
  corpo e repassava pro turno (`EFFORTS.has(...)`), mas nunca persistia nem considerava o valor já
  salvo. Reescrito no mesmo padrão condicional que a rota já usava pra `model`
  (`modelOverride`/`s.model`): `effortOverride` só grava no Postgres quando veio um valor válido E é
  diferente do já persistido; sem override no corpo, o turno passa a usar `s.effort` (o que já estava
  salvo) em vez de sempre `undefined` como antes — mesma continuidade que `model` já tinha.
- **`POST /api/claude/sessions/:id/effort`** (rota de troca AO VIVO, criada na rodada 4 — seção 8):
  até aqui só chamava `Runner.setEffortLive`, sem tocar no Postgres. Reescrita pra copiar
  **exatamente** a estrutura da rota irmã `.../mode` (comparei as duas lado a lado antes de escrever,
  não só de memória): `SELECT` do valor atualmente persistido → `UPDATE` só se o valor mudou → só
  DEPOIS tenta a aplicação ao vivo, isolada em try/catch (uma falha nela — rede, processo — nunca
  deve impedir a persistência, que já aconteceu antes; só um `app.log.warn`, mesmo texto de log que
  as rotas de modo/modelo já usavam). Doc comment da rota reescrito (o antigo afirmava "esforço nunca
  é persistido", não é mais verdade).
- **`GET /api/claude/sessions`** (lista da barra lateral): `s.effort` adicionado ao `SELECT` — não
  estava explicitamente no pedido original, mas sem isso o tipo `ApiSession.effort` (usado por ambas
  as rotas, a de lista e a de detalhe) mentiria sobre os itens vindos da lista (sempre `undefined` na
  prática ali, nunca `null` como o tipo promete) — mesmo padrão que `model`/`permission_mode` já
  seguiam (os dois já estavam nesse `SELECT`, nunca só no de detalhe). Conferido que nada hoje lê
  `.effort` a partir da lista (`Composer.tsx` sempre mostra o `effort` local do estado da aba, nunca
  `active.effort` — diferente de `model`, que tem um fallback de rótulo `active?.model` quando não há
  override escolhido, usado em `ClaudePage.tsx`), mas deixar o contrato de tipo incorreto seria um
  jeito fácil de introduzir um bug depois, então corrigido de passagem.
- **`web/src/claude/api.ts`**: `ApiSession` ganhou o campo `effort: string | null`, ao lado de
  `model`/`permission_mode`. Nova função pura `matchEffort(effort)`, ao lado de `matchModelAlias` já
  existente e com a mesma ideia: nunca confia cegamente no valor do banco (nullable), sempre resolve
  pra um `Effort` concreto e válido — `'medium'` quando ausente/inválido.
- **`ClaudePage.tsx`**: terceira linha no efeito de carga de sessão, ao lado de `setMode`/`setModel`
  já existentes: `setEffort(matchEffort(s.effort))`.
  - **Decisão que se afasta levemente da instrução literal do pedido** (documentando porque é uma
    escolha, não só mecânica): o pedido descrevia "validar contra a união conhecida de `Effort` do
    mesmo jeito que `permission_mode` é validado" — que no código de `mode` é um `if` que só chama
    `setMode` quando o valor já é válido, sem tocar no estado quando não é. Copiei essa validação
    (mesma lista de literais conhecidos), mas com uma diferença deliberada na consequência de falhar:
    `permission_mode` é `NOT NULL DEFAULT` no banco, então esse `if` nunca falha na prática — não há
    vazamento possível entre sessões. `effort` é nullable e MUITAS sessões (todas as existentes antes
    desta migração, e qualquer sessão nova sem escolha explícita de esforço) vão ter `null`. Um guard
    equivalente ao de `mode` (só chama `setEffort` quando o valor já é válido, sem `else`) deixaria o
    `useState` do composer com o valor da sessão ANTERIOR "vazado" pra dentro de uma sessão sem
    esforço persistido — pior: esse esforço vazado seria mandado como override explícito no próximo
    `send()`/`create()` daquela aba, sem o usuário ter escolhido nada ali. Troquei o "modelo de
    validação" pedido (guard de `mode`, que nunca reseta) pelo "modelo de resolução" que o mesmo
    arquivo já usa pro caso nullable mais parecido (`matchModelAlias`, que sempre resolve pra um valor
    concreto, nunca deixa de chamar `setModel`) — `matchEffort` segue esse segundo padrão. Mais
    correto pro caso real (coluna nullable), sem inventar um terceiro estilo.
- **`server/claude/runner.ts`**: só o comentário de `setEffortLive` foi atualizado (afirmava "effort
  nem é persistido por sessão no Postgres" — não é mais verdade); nenhuma linha de lógica mudou
  nesse arquivo — `setEffortLive` continua exatamente igual, só o lado ao vivo; a persistência
  acontece na rota HTTP, antes de chamar esse método, igual já valia pra modo/modelo.

**TDD, vermelho→verde confirmado** (`superpowers:test-driven-development`): escrevi 3 testes novos em
`tests/mapper.test.ts` (`describe('matchEffort', ...)`, logo depois de `matchModelAlias`, mesmo
padrão de casos: sem valor → `'medium'`, valor válido → mantém, valor desconhecido/corrompido → cai
pro `'medium'` em vez de quebrar) contra a função que ainda não existia — rodei `npx vitest run
tests/mapper.test.ts -t matchEffort` e confirmei a falha esperada (`TypeError: matchEffort is not a
function`, 3/3 falhando pelo motivo certo, não erro de digitação), só depois implementei
`matchEffort` em `api.ts` e confirmei verde (3/3, e a suíte completa de `mapper.test.ts`: 138/138).

**Por que não há mais testes novos além desses 3**: `server/routes/claude.ts` não tem NENHUMA rota
testada por `vitest` em lugar nenhum do repo (confirmado por grep antes de escrever qualquer coisa:
nenhum arquivo em `tests/` importa `claudeRoutes` nem usa `app.inject`/`fastify.inject` contra ele) —
mesma limitação já documentada na rodada 4 (seção 8 acima, "Limitação de verificação documentada").
`ClaudePage.tsx` também não tem teste — nenhum componente React tem nenhum no repo inteiro;
`package.json` não lista `@testing-library/react`, `jsdom` nem qualquer harness de DOM, só `vitest`
puro em ambiente node. Extrair a lógica de restauração numa função pura testável (`matchEffort`,
espelhando `matchModelAlias`) foi o jeito de trazer TDD de verdade pra essa mudança sem inventar uma
infraestrutura de teste nova fora do escopo pedido ("Keep the diff scoped to this one gap" — criar um
harness de rotas Fastify ou de componentes React do zero seria uma mudança bem maior que este gap).

**Verificado**:
- `npm run typecheck` (`tsc -p tsconfig.server.json` e `tsc -p tsconfig.json`, os dois `--noEmit`)
  limpo, sem erro, rodado depois de cada arquivo alterado.
- `npx vitest run`: suíte inteira **432 testes verdes** (23 arquivos) — eram 429 antes desta rodada,
  +3 de `matchEffort`; nenhum teste existente quebrou.
- `npm run build` (`vite build` + `tsc -p tsconfig.server.json`): bundle gera sem erro (mesmo aviso
  pré-existente de chunk grande, sem relação com esta mudança).
- `curl -s -o /dev/null -w "%{http_code}" https://v2.bayerl.cloud/api/claude/sessions` sem
  autenticação → `401` — confirma que o hook `preHandler` de autenticação do plugin (mesmo padrão já
  usado na rodada 4) segue ativo em produção; as rotas alteradas ficam dentro do mesmo
  `claudeRoutes(app)`, depois do hook, mesmo escopo de encapsulamento do Fastify que já protegia
  `.../mode` e `.../model`.
- Consulta read-only ao Postgres de produção (`information_schema.columns` + `schema_migrations`, via
  um script `.mjs` descartável reaproveitando o `pg` já instalado no worktree — nunca leu nem
  imprimiu `DATABASE_URL` em si, só o resultado das duas queries `SELECT`; script apagado logo
  depois): usado só pra confirmar o estado ANTES desta mudança (ver migração acima) — não pra aplicar
  a migração nova em produção, que fica pra quando este worktree for integrado ao `main`/`/srv/orion`
  (fora do escopo deste worktree, que não é o processo `orion-central` rodando de verdade).
- **Não verificado end-to-end num navegador real** (criar sessão → reload → efeito de carga
  restaura `effort`): sem ferramenta de browser/visual-testing neste ambiente, mesma limitação de
  todas as rodadas anteriores deste documento. Verificação foi por leitura cuidadosa de código
  (comparando linha a linha com o padrão de `mode`/`model` já em produção e funcionando) + os
  testes/typecheck/build acima.
## 11. Layout flutuante do composer — rodada de 28/09/2026 (7)

Pedido AO VIVO do Bayerl, nas próprias palavras, apontando pra esta MESMA extensão Claude Code (que ele
chama de "claude do antigravity" — a que está rodando nesta mesma sessão, usada como referência visual
direta em vez de só uma captura de tela): "quero que a UI da tela seja igual do claude do antigravity...
ou seja não tem divisão entre a parte do bloco de input do restante da tela... tá vendo que o input não
ocupa 100% da tela... fica no meio... e o texto nasce em cima dele... mas se eu rolo a tela ele passa
por trás com uma camada... enfim só copiar 100% a UI aqui, para ficar igual no orion v2". Continuação
direta da rodada 6 ("Card de permissão docado" acima): aquela rodada já tinha achado e citado o CSS real
do `inputContainer_07S1Yg`/`permissionsContainer_07S1Yg` pro CARD DE PERMISSÃO, mas deliberadamente não
tinha adotado a mecânica `position:absolute`/`ResizeObserver` de verdade ("aqui, mais simples...
over-engineering pra um efeito que o grid normal já resolve" — texto antigo, agora removido de
`claude.css`/`Timeline.tsx`). Esta rodada estende o MESMO tratamento flutuante pro composer inteiro
(não só o card de permissão), porque é a mesma caixa (`inputContainer_07S1Yg`) na extensão real.

**Estrutura real, reconfirmada lendo o JSX bruto do componente inteiro** (não só a citação isolada de
CSS da rodada 6) — `webview/index.js` v2.1.282, função que monta a tela de sessão (achada pelo mapa de
classes CSS Modules `f0={sessionLayout:...,chatContainer:...,messagesContainer:...,messageGradient:...,
inputContainer:...,permissionsContainer:...,...}`, todas com o mesmo sufixo de hash `_07S1Yg` — ou seja,
literalmente o MESMO arquivo/componente de origem pras três camadas):

```
R("div",{className:f0.sessionLayout, children:[
  R("div",{className:f0.chatContainer, children:[
    ...dropInfoOverlay, errorBanner, loadingState, emptyState (condicionais)...
    f5 && R("div",{ref:Q, className:`${f0.messagesContainer} ${f0.stickyMode} ...`, children:[
      ...turnos/mensagens...,
      F("div",{ref:Y, style:{height:`${U}px`, minHeight:`${U}px`}})   // spacer medido
    ]}),
    F("div",{className:`${f0.messageGradient} ...`}),                 // camada de esmaecimento
    R("div",{ref:z, className:`${f0.inputContainer} ...`, children:[
      ...awsAuthInProgress, diálogos de permissão (permissionsContainer), hostUnresponsive...,
      F5   // o composer de verdade (promptInputContainer > NK0/editor)
    ]}),
  ]}),
]})
```

`chatContainer`, `messagesContainer`, `messageGradient` e `inputContainer` são os QUATRO filhos diretos
de `chatContainer` (os 3 últimos, junto com os banners condicionais) — `messagesContainer` (a área que
rola) e `inputContainer` (o composer flutuante) são IRMÃOS, nunca um dentro do outro, com
`messageGradient` entre os dois na ordem do DOM (mas visualmente por cima de `messagesContainer`, por
`position:absolute`+`z-index`). Confirma e estende o achado da rodada 6 (que já sabia isso só pro card
de permissão): é a MESMA relação estrutural pro composer inteiro.

**CSS exato** (extraído do `index.css` v2.1.282 minificado com Python/regex, não digitado de memória —
arquivo é uma única linha de 429KB, `grep -oP` sozinho travava por backtracking; resolvido baixando o
arquivo e processando localmente):

- `.chatContainer_07S1Yg{display:flex;overflow:hidden;position:relative;flex-direction:column;flex:1;
  min-width:0;line-height:1.5}` — a âncora `position:relative` de tudo.
- `.messagesContainer_07S1Yg{overflow-y:auto;overflow-x:hidden;display:flex;background-color:
  var(--app-primary-background);position:relative;flex-direction:column;flex:1;gap:0;min-width:0;
  padding:20px 20px 40px}` — variante BASE (sem `stickyMode`, que na produção real É aplicado sempre
  via classe extra e troca o padding-top por um spacer `:before{height:20px}`; Orion não tem cabeçalho
  de mensagem fixo ao rolar — ver seção 1 "n/a" — então adotamos só a variante base, padding
  `20px 20px 40px` idêntico).
- `.messageGradient_07S1Yg{position:absolute;background:linear-gradient(to bottom,transparent 0%,
  var(--app-primary-background)100%);pointer-events:none;z-index:2;height:150px;bottom:0;left:0;
  right:0}` — a camada de esmaecimento. **Confirmado que NÃO é `backdrop-filter`/blur**: busca no
  `index.css` inteiro (429KB) por `backdrop-filter` devolve exatamente 1 ocorrência em todo o arquivo,
  `.popup_v2CdxQ{...backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);...}` — um dropdown
  de MENU do compositor (não a área de mensagens), sem nenhuma relação com este componente (sufixo de
  hash diferente, `_v2CdxQ`). Busca por `mask-image` devolve 2 ocorrências, nenhuma aqui: uma em
  `.toolBodyRowContent_ZUQaOA` (recorte de saída de ferramenta longa, gradiente de opacidade, feature
  já implementada no Orion como `cc-tool-pre` com scroll simples) e uma em `.wave_VBlAgQ` (ícone SVG de
  onda sonora). Ou seja: "o texto... passa por trás com uma camada" que o Bayerl descreveu é este
  GRADIENTE SÓLIDO (transparente → cor de fundo opaca), não um desfoque.
- `.inputContainer_07S1Yg{position:absolute;display:flex;z-index:20;flex-direction:column;
  max-width:680px;margin:0 auto;bottom:16px;left:16px;right:16px}` — o composer flutuante, MESMO
  seletor já citado na rodada 6 (reconfirmado, valores idênticos).
- `.permissionsContainer_07S1Yg{width:100%;max-width:680px;margin:0 auto}` — dentro do
  `inputContainer` (que já tem `max-width:680px`), então redundante ali; existe porque a mesma classe
  é reusada em outro contexto do bundle sem essa restrição herdada.
- `.inputContainer_cKsPxg{background:var(--app-input-secondary-background);border:1px solid
  var(--app-input-border);border-radius:var(--corner-radius-large);color:var(--app-input-foreground);
  display:flex;position:relative;flex-direction:column;min-width:0;margin:0;padding:0;
  box-shadow:0 1px 2px #0000001a}` — a CAIXA do editor de verdade (outro CSS module, sufixo `_cKsPxg`,
  não confundir com `inputContainer_07S1Yg` acima, que é só o wrapper posicionador). O único detalhe
  novo adotado daqui: `box-shadow:0 1px 2px #0000001a` (nosso `.cc-composer` não tinha sombra nenhuma
  antes — agora tem, valor idêntico).

**JS exato do spacer/`ResizeObserver`** (a resposta pra "como a extensão evita esconder a última
mensagem atrás do composer flutuante", achada perto da função de render, não hipotetizada):

```js
o(() => {
  if (!z.current) return;
  let q1 = new ResizeObserver((Z0) => { for (let R0 of Z0) V(R0.contentRect.height) });
  return q1.observe(z.current), () => { q1.disconnect() }
}, [])
```

`z` é o `ref` do `inputContainer` (o composer flutuante inteiro, incluindo o card de permissão quando
presente); `V` é o setter de um estado `U` (inicial 0), cujo valor vira `height`/`minHeight` do spacer
`<div ref={Y}>` no fim de `messagesContainer` (citado na árvore JSX acima) — E também é passado como
prop `inputContainerHeight` pro componente de estado vazio (`JH0`), pro placeholder "como posso
ajudar" também respeitar a mesma altura reservada (Orion não tem esse estado vazio específico — o
`cc-empty-state` do Orion só aparece SEM sessão nenhuma selecionada, quando o composer nem monta — não
precisa do mesmo tratamento).

**Implementado no Orion** (`web/src/claude/`):
- `claude.css`: `.cc-main` trocado de `display:grid;grid-template-rows:auto auto 1fr auto auto` pra
  `display:flex;flex-direction:column` — o grid de 5 trilhas fixas presumia posição exata de cada
  filho (qualquer banner condicional a mais desalinhava a trilha `1fr` da área que rola pro `.cc-head`
  ocupar por engano); flex resolve isso sem depender de contagem, mesma classe de problema que o
  `.chatContainer_07S1Yg`/`.sessionLayout_07S1Yg` reais evitam não usando NENHUMA trilha de grid fixa.
  `.cc-chat` novo (= `.chatContainer_07S1Yg`: `position:relative;display:flex;flex-direction:column;
  overflow:hidden;flex:1`), único item `flex:1` de `.cc-main`. `.cc-scroll` (=`messagesContainer`
  variante base) ganhou `flex:1;min-height:0;position:relative;background:var(--cc-bg);
  padding:20px 20px 40px` (era `overflow-y:auto;min-height:0;padding:16px 18px 8px` — sem `flex`
  porque vivia direto num item de grid antes). `.cc-fade` novo (=`messageGradient`, valores citados
  acima, com `var(--cc-bg)` no lugar de `var(--app-primary-background)`). `.cc-float` novo (substitui
  `.cc-dock` da rodada 6, =`inputContainer_07S1Yg`, valores EXATOS citados acima) — `gap:8px` entre
  `PermissionDock` e `Composer` é NOSSO (a extensão real não declara gap explícito ali; o espaçamento
  dela vem de margem própria dos filhos, não replicada 1:1 por simplicidade). `.cc-composer` perdeu a
  margem própria (o posicionamento agora é todo do `.cc-float` pai) e ganhou `box-shadow:0 1px 2px
  #0000001a` (=`inputContainer_cKsPxg` real, citado acima).
- `ClaudePage.tsx`: `floatRef`/`floatHeight` (novo `useState(0)`) + `useEffect` com `ResizeObserver`
  observando `floatRef.current`, reobservando quando `activeId` muda (o nó troca de identidade a cada
  montagem/desmontagem do `.cc-float` condicional) — mesmo mecanismo do `z`/`U`/`V`/`ResizeObserver`
  reais citados acima, adaptado pra um nó condicional (o real nunca desmonta o `inputContainer`, então
  o efeito dele roda só uma vez com `[]`; o nosso precisa do `[activeId]` porque `.cc-float` É
  condicional — mesma precedente da rodada 6/`.cc-dock`, mantida de propósito, fora de escopo mudar
  agora). JSX reestruturado: `.cc-scroll` (com um `<div>` spacer novo no fim, altura=`floatHeight`,
  espelhando o `<div ref={Y}>` real) + `.cc-fade` + `.cc-float` (com `PermissionDock` e `Composer`
  dentro, mesma ordem de antes) agora são os 3 filhos de um `.cc-chat` novo, em vez de `.cc-scroll` e
  `.cc-dock` serem 2 itens de grid separados. O `useEffect` de scroll-pro-fim ganhou `floatHeight` nas
  dependências: sem isso, quando um card de permissão aparece (crescendo `.cc-float`) no MESMO instante
  em que o evento é adicionado a `events`, o `scrollTo` rodaria com o `scrollHeight` de ANTES do
  spacer crescer (o `ResizeObserver` dispara um frame depois do `events.length` mudar), deixando a
  última mensagem visível por baixo do card por um instante.
- `Timeline.tsx`: só o comentário JSDoc de `PermissionDock` atualizado (a função em si não mudou nesta
  rodada) — a frase antiga "aqui, mais simples: sem overlay/position:absolute" não era mais verdade,
  substituída por uma nota explicando a mudança de mecânica e apontando pra esta seção.

**Desvios deliberados, documentados (não escondidos)**:
- `.cc-float` só monta quando `activeId` é truthy (igual `.cc-dock` antes dele) — a extensão real monta
  `inputContainer`/`messageGradient` SEMPRE (incondicional, `f5` só gate `messagesContainer`). Não
  mudado: o Orion tem um estado "nenhuma sessão selecionada" que a extensão real não tem (ela sempre
  tem uma sessão ativa); mudar isso é decisão de produto, fora do pedido de hoje.
- `gap:8px` em `.cc-float` é nosso, não existe na extensão real (que usa margem própria dos filhos).
- Composer continua visível/habilitado com uma permissão pendente (decisão da rodada 6, não revisitada
  aqui — a extensão real esconde com `display:none`).
- Breakpoint mobile (`@media (max-width:800px)`) não foi re-verificado especificamente por não haver
  navegador aqui; o risco de um `flex:1`/`height:auto` num container com altura indeterminada é o MESMO
  tipo de aresta que já existia com `grid-template-rows:auto` + `1fr` antes desta rodada (não uma
  regressão nova introduzida agora).

**TDD**: nada de lógica pura nova nesta rodada (é puramente estrutura CSS/JSX + uma medição de DOM via
`ResizeObserver`, que não é testável de forma significativa em `jsdom`/`vitest` sem simular
`ResizeObserver` e layout de verdade — o que só teatraliza cobertura sem testar nada real) — seguindo a
instrução explícita de não forçar teste onde não há lógica pura pra testar. Nenhuma função em
`mapper.ts`/`live.ts`/`api.ts` mudou.

**Verificação**: sem navegador/visual-testing neste ambiente (mesma limitação de sempre, ainda mais
crítica numa mudança de layout/CSS pura — sem forma de tirar print) — compensado lendo o CSS/JS reais
com processamento local (Python, não `grep -oP` remoto, que travava por backtracking num arquivo de
429KB numa única linha) em vez de estimar/chutar nenhum valor, e citando cada seletor/valor usado one a
one contra a fonte. `vitest`: 429 testes (23 arquivos), mesma contagem de antes desta rodada (nenhum
teste novo, nenhum quebrado — coerente com "nada de lógica pura nova" acima). `npm run typecheck`
(`tsc -p tsconfig.server.json` e `tsc -p tsconfig.json`, os dois `--noEmit`) sem erro. `npm run build`
(`vite build` + `tsc -p tsconfig.server.json`) limpo, mesmo aviso pré-existente de chunk grande (não
relacionado). `git diff --stat` confirma só os 3 arquivos esperados tocados (`ClaudePage.tsx`,
`Timeline.tsx`, `claude.css`) — nenhum arquivo dos agentes concorrentes (`effort-persist`,
`image-lightbox`) tocado.
## 12. Popup de imagem (Lightbox) — miniatura clicável no compositor E no histórico — rodada de 28/09/2026 (7)

**Pedido, nas palavras do Bayerl** (ao vivo, numa sessão diferente desta, mais cedo no mesmo dia): "a
thumbnail de imagem no que fica no bloco de texto... copia a regra, UI, aqui do plugin de claude code
para ficar 100% igual no claude v2". Contexto: uma sessão anterior (commit `5b445b6`, "feat: miniatura
de anexo de imagem abre a imagem em nova aba", já em `main`) tinha feito a miniatura do anexo pendente
no compositor clicável, abrindo a imagem em **nova aba do navegador** (`<a target="_blank">`). O
Bayerl, ao vivo na mesma sessão, disse que não queria nova aba — queria um popup, do tamanho da
imagem, com um teto de % da tela, respiro nas bordas, fundo escurecido, e — supondo de memória — uma
tira de miniaturas com setas se houvesse mais de uma imagem. Esse pedido nunca chegou a ser
implementado (confirmado antes de começar: `main` parado exatamente no `5b445b6`, nada commitado
depois). Instrução explícita para esta rodada: não implementar a partir do que o Bayerl **lembrava**
do plugin, e sim ler o bundle decompilado da extensão real e replicar o que ela **de fato** faz.

### O que a extensão real faz de verdade

Lido o webview decompilado v2.1.282 (`/srv/orion-reference/vscode-extension/extension/webview/index.js`
e `index.css`) — não só os nomes de classe, o JS inteiro dos componentes envolvidos.

**Existe um único componente reutilizável para anexo + popup**, usado tanto no compositor quanto na
mensagem já enviada — confirmado pelos 4 call-sites reais de `yw(...)` (o wrapper de `AI0`) no bundle:
```
F(yw,{label:V,type:"image",dataUrl:q})                                   // dentro da renderização de content.type==="image" de uma MENSAGEM (histórico)
F(yw,{label:U,type:"document",onClick:()=>wh1(q,U)})                     // idem, tipo documento
F(yw,{label:x1.file.name,type:e5?"image":"document",dataUrl:...,onR...}) // lista de anexos PENDENTES do compositor (2x — provavelmente 2 pontos de render, mesmo componente)
```
O primeiro call-site está dentro do `if($.content.type==="image")` que trata o CONTEÚDO de uma
mensagem do usuário já enviada (`G.source?.type==="base64"` → monta um `data:` URL a partir do
`base64` que o próprio bloco de conteúdo da mensagem carrega) — ou seja, **a extensão usa exatamente
o mesmo componente/CSS pro anexo pendente E pro anexo já enviado**, confirmando a decisão de fazer o
mesmo aqui (um `Lightbox` só, chamado dos dois lugares).

O componente real (`AI0`, renomeado aqui pros achados; nomes ofuscados no bundle):
```js
function AI0({label, type, dataUrl, onRemove, onClick}) {
  let isImage = type === "image";
  let [open, setOpen] = useState(false);
  let [meta, setMeta] = useState(); // "1024×768" — dimensão natural da imagem, via new Image().onload
  let closeBtnRef = useRef(null);
  // ...preload da imagem só pra pegar naturalWidth/naturalHeight e mostrar como meta do chip...
  let close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    let onKeyDown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); close(); }
    };
    document.addEventListener("keydown", onKeyDown, true); // capture: true
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);
  return (
    <>
      <Pill kind={isImage?"image":"document"} label={label} meta={isImage?meta:undefined}
            thumbnailUrl={isImage?dataUrl:undefined}
            onClick={isImage&&dataUrl ? () => setOpen(true) : onClick} onRemove={onRemove} />
      {open && dataUrl && createPortal(
        <div className={previewOverlay} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className={previewContainer} role="dialog" aria-label={label} tabIndex={-1}>
            <img src={dataUrl} alt={label} className={previewImage} />
            <button ref={closeBtnRef} onClick={close} className={previewCloseButton} title="Close preview (Esc)">
              <XIcon className={previewCloseIcon} />
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
```

CSS real exato (`webview/index.css`, classes `_vRjSkQ` — **valores lidos, não aproximados**):
```css
.previewOverlay_vRjSkQ{position:fixed;display:flex;z-index:10000;background:#000000d9;justify-content:center;align-items:center;inset:0}
.previewContainer_vRjSkQ{position:relative;cursor:default;max-width:90vw;max-height:90vh}
.previewImage_vRjSkQ{object-fit:contain;border-radius:8px;max-width:90vw;max-height:90vh;box-shadow:0 4px 24px #00000080}
.previewCloseButton_vRjSkQ{position:absolute;display:flex;background:var(--app-menu-background);border:1px solid var(--app-input-border);cursor:pointer;border-radius:50%;justify-content:center;align-items:center;width:28px;height:28px;padding:0;transition:background-color .15s;top:-12px;right:-12px}
.previewCloseButton_vRjSkQ:hover{background:var(--app-list-hover-background)}
.previewCloseIcon_vRjSkQ{color:var(--app-menu-foreground);width:18px;height:18px}
```
Achados que corrigem palpites (do pedido do Bayerl E de qualquer estimativa inicial minha, sem ler o
código):
- **Fundo do overlay: preto a 85% de opacidade** (`#000000d9` — `d9` hex = 217/255 ≈ **.851**), não
  60% como o Bayerl supôs de memória.
- **90vw/90vh de teto** (`max-width`/`max-height` tanto no container quanto na imagem) — bate com
  "tamanho até um teto de % da tela"; como o overlay é flex centralizado em tela cheia, sempre sobra
  ≥5vw/5vh de respiro nas quatro bordas, em qualquer proporção de imagem — é exatamente o "padding em
  volta" pedido, só que é uma CONSEQUÊNCIA do teto de 90vw/90vh + centralização, não uma propriedade
  `padding` explícita.
- `box-shadow: 0 4px 24px #00000080` — preto a 50% (`80` hex = 128/255 ≈ **.502**), `border-radius: 8px`.
- Botão de fechar: círculo de **28×28px**, `top:-12px;right:-12px` — sobreposto ao canto superior
  direito do container, fora da área da imagem.
- **SEM navegação entre imagens.** Procurado no bundle inteiro por qualquer classe/função ligada a
  `Next`/`Prev`/`Arrow`/`Nav`/`Gallery`/`Carousel`/`swipe` associada a este componente ou ao
  `previewOverlay` — nada. O componente é estritamente **por-anexo**: cada miniatura clicada
  instancia seu PRÓPRIO `open`/overlay local (`useState(false)` dentro de `AI0`, uma instância por
  chamada de `yw(...)`), sem nenhum estado de índice/galeria compartilhado entre anexos. Se uma
  mensagem tem 3 imagens, são 3 componentes `AI0` independentes lado a lado — clicar na 2ª abre SÓ a
  2ª, sem jeito de "passar" pra 1ª ou 3ª de dentro do popup. **Isto corrige a suposição do pedido**
  (o Bayerl imaginou de memória uma tira de miniaturas + setas — não existe isso na extensão real).
  Seguindo a instrução explícita desta rodada ("não adivinhar - achar e replicar exatamente"), o
  `Lightbox` implementado aqui também não tem navegação — replica o que a extensão FAZ, não o que se
  lembrava dela fazer.
- **Fechar**: clique no botão X; clique no backdrop, mas só quando `e.target === e.currentTarget`
  (ou seja, clicar na imagem ou em qualquer parte do container NUNCA fecha — só a área fora dele,
  entre o container e a borda da tela); Esc, capturado em `document` com `capture:true` +
  `stopPropagation()`/`stopImmediatePropagation()` (impede a tecla de vazar pra outro handler
  enquanto o popup está aberto). Foco vai pro botão de fechar ao abrir; **sem restaurar foco ao
  fechar** neste componente especificamente (existe uma variante separada e não usada aqui, `kv1` —
  mesmo popup, só que pra screenshots da integração "Claude in Chrome" — que restaura foco pro
  elemento que abriu; confirmado que NÃO é a mesma usada pra anexos de mensagem/compositor, então não
  replicado aqui).
- Renderizado via `createPortal(..., document.body)` — nunca inline na árvore da mensagem/compositor.
- Achado extra, não replicado por escolha de escopo: o `Pill` (miniatura pequena, 24px de altura,
  ícone/thumb de 12×12px, classes `pill_lcdCYQ`/`thumbIcon_lcdCYQ`/`meta_lcdCYQ`) também mostra a
  **dimensão natural da imagem em pixels** (ex. "1024×768") como metadado ao lado do nome, calculada
  via um `new Image()` de preload. Não implementado aqui — não é o que foi pedido (o pedido é sobre o
  popup/lightbox, não sobre um metadado extra no chip) e adicionaria um preload + estado só pra um
  detalhe cosmético; documentado aqui como achado real, não como gap.

### O que foi implementado no Orion

**`web/src/claude/Lightbox.tsx`** (novo): componente `Lightbox({ image: {src, alt} | null, onClose })`
— replica pixel a pixel os valores acima (`.cc-preview-overlay` = `#000000d9`, `.cc-preview-image` =
`max-width/height:90vw/90vh` + `border-radius:8px` + `box-shadow:0 4px 24px #00000080`,
`.cc-preview-close` = círculo 28px em `top:-12px;right:-12px`), classes próprias (`cc-preview-*`,
convenção do resto do arquivo — nunca os nomes ofuscados `_vRjSkQ` da extensão, que são de um CSS
module que não existe aqui). `createPortal(..., document.body)`, igual ao real. Fecha em Esc (mesmo
padrão `capture:true` + `stopImmediatePropagation`), clique no backdrop (mesma checagem
`e.target === e.currentTarget`) e no botão X. Foca o botão de fechar ao abrir, sem restaurar foco ao
fechar (replica `AI0`, o componente que a extensão de fato usa aqui — não `kv1`). SEM navegação entre
imagens, de propósito (ver achados acima) — cada chamador (`Composer.tsx`/`Timeline.tsx`) mantém seu
próprio `useState<LightboxImage|null>` local; clicar numa miniatura diferente troca a imagem mostrada
(não empilha popups), o que já cobre "clicar em cada miniatura abre a sua própria imagem" sem precisar
de uma galeria compartilhada — comportamento final equivalente ao real, implementado de forma mais
simples que "uma instância de estado por anexo" (React) sem mudar o resultado visual.

**Composer.tsx** (miniatura do anexo PENDENTE, antes do envio): trocado o `<a href={a.url}
target="_blank">` do commit `5b445b6` por um `<button className="cc-attach-thumb-btn" onClick={() =>
setPreview({src: a.url!, alt: a.name})}>` — abre o `Lightbox` local em vez de nova aba. `a.url` já era
um `URL.createObjectURL(file)` local (blob), que funciona como `src` de `<img>` igual a qualquer outra
URL — nenhuma mudança na forma como o anexo pendente é armazenado, só no que acontece ao clicar.

**Timeline.tsx** (miniatura de anexo numa mensagem JÁ ENVIADA — a pergunta central do pedido, "no que
fica no bloco de texto"): **gap real confirmado antes de mexer** — `Attachments` (o componente que
renderiza os anexos de uma mensagem de usuário no histórico) só mostrava um chip com ícone genérico +
nome, nenhuma miniatura, porque a nota persistida do anexo (`user_prompt.payload.attachments`) nunca
guardou o suficiente pra buscar a imagem de volta depois de enviada (só `kind`/`name`/`media_type` —
ver histórico do arquivo). Diferente da extensão real, que consegue montar um `data:` URL na hora
porque o `base64` da imagem mora dentro do próprio conteúdo da mensagem no histórico do SDK
(`content.type==="image"`, `source.type==="base64"`) — arquitetura que o Orion não replica (o Orion
não persiste o base64 da imagem de volta no Postgres; só o usa transitoriamente pra montar o turno,
ver `attachmentBlocks` em `runner.ts`). Adaptação necessária, documentada em vez de escondida:

- **`server/claude/runner.ts`**: a nota persistida (`attachNote`) ganhou o campo `path` — o caminho
  absoluto do arquivo no servidor, que **já** era devolvido ao navegador pelo endpoint de upload
  (`POST /api/claude/uploads` sempre retornou `path` em cada anexo salvo) — não é uma exposição nova,
  só passou a acompanhar o anexo até o evento persistido também.
- **`server/routes/claude.ts`**: nova rota `GET /api/claude/attachments?path=...&type=...` — serve de
  volta o arquivo já salvo (o upload nunca apaga o arquivo depois de usado num turno — confirmado lendo
  o endpoint de upload; só apaga em erro de escrita/limite de tamanho). `type` restrito à lista real
  de mídia de imagem que o SDK aceita (`IMAGE_MEDIA_TYPES`, a mesma constante que `attachmentBlocks` já
  usava) — nunca reflete um `Content-Type` arbitrário vindo da query. `path` validado com a MESMA
  checagem anti path-traversal que já existia em `sanitizeAttachments` (realpath + prefixo da pasta de
  upload) — extraída pra uma função pura exportada, `isUnderRoot(real, root)`, reaproveitada nos dois
  lugares em vez de duplicada (só fatoração; comportamento idêntico ao que já existia). Autenticação:
  a mesma que toda rota de `/api/claude/*` já tinha (`app.addHook('preHandler', ...)`, cobre a rota
  nova por escopo de encapsulamento do Fastify — mesmo padrão confirmado numa rodada anterior desta
  tabela); a sessão do navegador vai por cookie (`credentials:'same-origin'`, `web/src/api.ts`), então
  um `<img src="/api/claude/attachments?...">` comum já manda a sessão certa, sem precisar de nenhum
  cabeçalho especial.
- **`web/src/claude/types.ts`**: `UserAttachment` ganhou `path?: string` (opcional — ausente em
  anexos persistidos ANTES desta rodada, que continuam caindo pro chip de ícone+nome de sempre, sem
  quebrar nada).
- **`web/src/claude/mapper.ts`**: `attachmentImageUrl(a)` — pura, monta a URL acima só quando
  `kind==='image'` e há `path`+`media_type`; `undefined` em qualquer outro caso (não vira link).
- **`Timeline.tsx`**: `Attachments` agora resolve `attachmentImageUrl(a)` por item; quando existe,
  troca o chip de ícone por um `<button className="cc-attach-thumb-btn"><img className="cc-attach-thumb" .../></button>`
  que abre o mesmo `Lightbox` (estado local ao componente, um popup por mensagem/lista de anexos).

**`claude.css`**: `.cc-preview-overlay`/`.cc-preview-container`/`.cc-preview-image`/`.cc-preview-close`
(valores exatos citados acima); `.cc-attach-thumb-btn` substitui a regra antiga `.cc-attach > a` (não
existe mais `<a>` nenhum aqui). Cores do overlay em hex fixo (`#000000d9`/`#00000080`), não
`var(--cc-*)`, de propósito — a extensão real também usa preto puro com opacidade fixa via hex de 8
dígitos, não um token de tema (o popup escurece igual em tema claro ou escuro).

### Verificação

TDD nas duas peças de lógica pura extraídas (`superpowers:test-driven-development`): escrevi os testes
de `attachmentImageUrl` (`tests/mapper.test.ts`, 5 casos: URL montada certo, `kind:'file'` nunca gera
URL, sem `path` → undefined, sem `media_type` → undefined, caracteres especiais no caminho escapados)
e de `isUnderRoot` (`tests/attachments.test.ts`, 4 casos: dentro da raiz, a própria raiz, fora da
raiz, prefixo de nome parecido mas sem separador — o caso que a checagem ingênua `startsWith` sem
`path.sep` erraria) ANTES de implementar — rodei a suíte e confirmei os 10 testes falhando por função
inexistente (`TypeError: attachmentImageUrl is not a function` / `isUnderRoot is not a function`), só
depois implementei `mapper.ts`/`server/routes/claude.ts`. Verde confirmado depois. Também atualizei o
teste existente que checava a forma exata da nota persistida (`tests/attachments.test.ts`, "turno com
anexos... persiste a nota compacta") pra incluir `path` — os outros testes que já cobriam anexos
(`tests/attachmentsUi.test.ts`) usam `toMatchObject`, não exigem os campos novos, e continuaram verdes
sem alteração.

Sem navegador/visual-testing neste ambiente (mesma limitação de todas as rodadas anteriores desta
tabela) — não dá pra ver o popup renderizado de verdade. Verificação: leitura cuidadosa do JS/CSS
decompilados da extensão real (não só nomes de classe — o componente inteiro, linha por linha, pros
achados de comportamento: fechar, foco, ausência de navegação) + `vitest` (suíte inteira: **438
testes, 23 arquivos, todos verdes** — 429 antes desta rodada + 9 novos: 5 de `attachmentImageUrl` + 4
de `isUnderRoot`) + `tsc --noEmit` (`tsconfig.server.json` e `tsconfig.json`, os dois sem erro) +
`vite build` (bundle gera sem erro, mesmo aviso pré-existente de chunk grande, sem relação com esta
mudança). Não fiz `curl` autenticado contra a rota nova (`GET /api/claude/attachments`) pelo mesmo
motivo de rodadas anteriores: este worktree (`image-lightbox`) não é o processo `orion-central` rodando
de verdade (esse roda o código do `main`/`/srv/orion`) — um `curl` só re-testaria o código antigo, não
o que mudou aqui. A validação de path traversal da rota nova é coberta indiretamente: reaproveita
`isUnderRoot`, testada isoladamente, com a MESMA lógica que `sanitizeAttachments` já usava (e que já
era exercitada pelos testes de upload existentes) — não é um caminho novo e não testado, é o mesmo
caminho de sempre, só compartilhado.

## 13. Inventário de superfícies ainda não portadas — investigação profunda pedida pelo Bayerl em 28/09/2026 ("tem várias janelas clicáveis... investiga profundamente")

**Contexto da investigação**: até agora toda a paridade foi construída contra `/srv/orion-reference/vscode-extension/extension/webview/` (v2.1.282), extraído de um `.vsix` baixado à parte. Nesta rodada descobri que "Antigravity IDE" (o host onde a sessão do Bayerl está rodando) é uma aplicação real e distinta (não confusão de nome — instalada em `/Applications`, dados de usuário em
`~/Library/Application Support/Antigravity IDE/`), e que ela tem a extensão `anthropic.claude-code`
**desempacotada e ao vivo** (não só cache de `.vsix`) em
`~/.antigravity-ide/extensions/anthropic.claude-code-2.1.283-darwin-arm64/` — versão **mais nova**
que a referência usada a sessão inteira. Copiada para o c3 em
`/srv/orion-reference-2.1.283/{webview/index.{js,css},package.json,resources/}` (mesma estrutura,
só com sufixo de versão) — usar essa como fonte preferencial daqui pra frente; a v2.1.282 antiga
continua disponível para diff histórico.

Metodologia: extraídos os ~810 nomes-raiz de classes CSS-module do `index.css` novo (agrupam por
componente React), cruzados com strings literais de UI (`grep` por texto legível no `index.js`
minificado) para confirmar o que cada grupo realmente faz antes de listar como gap. **Nenhum item
abaixo foi implementado nesta rodada** — é levantamento, não construção; itens marcados com evidência
direta (string literal encontrada) são confiáveis, os sem string literal são inferência por nome de
classe + contexto de código e precisam de confirmação antes de virar trabalho.

### Achados com evidência direta (string literal + lógica confirmadas no bundle)

1. **Nível "Ultracode" no seletor de esforço/modelo** — string literal exata: `IV0="Ultracode"`,
   `fe = \`${IV0} - xhigh + workflows\`` (ou seja, o rótulo mostrado é **"Ultracode - xhigh +
   workflows"**), função `enableUltracode()`, estado `this.ultracodeEnabled`/`this.ultracodeSeeded`,
   classes `fillUltracode_P1HaRA`/`notchUltracode_P1HaRA` no controle deslizante de esforço. É um
   NÍVEL A MAIS acima de "max" no mesmo seletor de esforço já portado (`matchEffort`/`handleEffort`
   em `ClaudePage.tsx`) — não é um controle separado. Bate exatamente com o parâmetro `Ultracode`
   descrito na própria ferramenta `Workflow` desta sessão. Gap concreto: nosso seletor de esforço
   hoje provavelmente só vai até "max"; falta o degrau extra "Ultracode" com esse texto e o toggle
   de habilitação.

2. **Criação/gestão de worktree pelo próprio chat** — **IMPLEMENTADO em 29/09/2026, ver seção 15.**
   Strings literais: `"New worktree name"`,
   `"Open worktree"`, `"Failed to create worktree"`, `"This session is in worktree"`; classes
   `createWorktreeButton`, `worktreeBanner*`, `worktreeInput*`, `worktreePill*`; métodos
   `createWorktree($)` → `sendRequest({type:"create_worktree", name:$})`,
   `availableWorktrees`/`sessionsByWorktree` (mapeiam sessões por worktree). Ou seja: dá pra criar
   um novo git worktree e iniciar uma sessão nele **direto pela UI do chat**, sem terminal — um
   banner mostra em qual worktree a sessão atual está e permite abrir/trocar. Dado que TODO o
   workflow de desenvolvimento do Orion (inclusive o desta própria investigação) já gira em torno de
   worktree-por-tarefa, esse é provavelmente o item de maior valor prático da lista.

3. **Marketplace de plugins/MCP** — strings literais: `"Official Claude Code marketplace"`,
   `"Refresh marketplace"`, `"Refresh the marketplace and retry"`, `"Remove marketplace"`; métodos
   `listMarketplaces()`, `addMarketplace($)`, `removeMarketplace($)`, `refreshMarketplace($)`,
   `setPluginEnabled($,J)`; classes `pluginItem/pluginList/pluginHeader/pluginActions/mcpServerItem/
   mcpServerList/serverItem/serverList/serverDetail/addMarketplaceForm`. Navegador completo de
   marketplaces com adicionar/remover fonte + listar/habilitar plugins e servidores MCP individuais.

4. **Output styles (estilo de resposta)** — strings literais: `"Output styles"`,
   `"Select an output style"`, `"Switch to this style now"`, `"Build a custom style"`,
   `"No output styles available"`, `"Shows in the Output styles menu and becomes the file name"`,
   `"Change response formatting style"`. Menu pra trocar o estilo de formatação das respostas e
   criar estilos customizados salvos (viram arquivo, com nome derivado da descrição).

5. **Agent map / linhas de subagente na timeline** — já é o alvo do agente `feature/agent-map`
   rodando em paralelo; achados novos repassados a ele por mensagem direta: classe `subagentRow`
   (componente `MA1({tasks})`, linha dobrável com `data-testid="focus-subagent-row"` /
   `"focus-subagent-overflow-row"`, label "Collapse"); classe `agentsPill` — botão pequeno
   (`${modelPill} ${agentsPill}`) com atributo `data-agents-dot` (cor do dot = status) e
   `aria-label` combinando contagem+status — é o **gatilho clicável** que abre o painel, deveria
   existir no header/composer perto do model pill; classes `innerCall*`
   (`innerCallHeader/innerCallList/innerCallSpinner/innerCallComplete/innerCallError`) — exibição
   aninhada das tool calls dentro da linha de um subagente ao expandir.

6. **Breakdown de uso "% of usage" por modelo** — string literal `"% of usage"`, classes
   `attributionRow/attributionName/attributionPct/attributionGroup/attributionList/attributionMore`
   (trunca com "+N mais"). Parece ser uma extensão da tela de Conta/Uso já portada (seção 3): uma
   lista por modelo (Sonnet/Opus/Haiku/Ultracode) com percentual de uso, não só as barras agregadas
   que já temos.

### Achados por nome de classe + contexto de código (sem string literal ainda confirmada — checar antes de construir)

7. **Ditado por voz no compositor** — classes `micButton/micIcon/micIconPuck/micTooltip/
   micTooltipError/micTooltipShortcut/recording/voiceInterim/wave`; strings encontradas
   (`voiceRecordingStarted`/`voiceRecordingStopped`) parecem ser sons de acessibilidade do VS Code
   em si, não necessariamente da extensão — precisa confirmar se é feature real da extensão ou
   herdada do host.
8. **"Teleport" de sessão entre janelas/dispositivos** — `pendingRemoteTeleport`,
   `unresolvedBootRemoteId`, `teleportError*`, `notifyPanelTeleportResolved/Abandoned`. Pode
   sobrepor com o que já existe no Orion (`GET /api/claude/ui-state/stream`, sincronização
   cross-tab/cross-device já implementada por outra sessão, ver commit `631aee9`) — precisa
   comparar antes de decidir se é gap ou já coberto por outro mecanismo.
9. **Editor de regras de permissão** — **IMPLEMENTADO em 29/09/2026, ver seção 17.** Classes
   `ruleItem/ruleActions/ruleDescription/ruleInput/ruleMain/ruleSource/ruleText/addRuleButton/
   confirmRule/confirmRemoveRow/confirmRemoveText`. A investigação original (levantamento por nome de
   classe, sem ler o componente inteiro) tinha um erro: `confirmRemoveRow/confirmRemoveText` NÃO
   pertencem a este painel — são de um componente genérico diferente (remoção de servidor MCP), ver
   seção 17.
10. **Lista de hooks** — classe `hookRow`, sem string literal capturada ainda.
11. **Painel de skills** — classes `skillRow/skillLock/skillNote/skillState` — lista/toggle de
    skills (ver `Skill` tool desta própria sessão).
12. **Agrupamento de sessões em pastas nomeadas** — classes `newGroupButton/newGroupIcon/
    groupHeader/groupChevron/groupChevronExpanded/groupName/groupNameEditing/groupCount`. O Orion
    já tem um "Agrupar por Nenhum/Projeto/Atividade" (ver Resumo, rodada anterior 2) que é um
    equivalente leve — esse aqui parece ser pastas nomeadas arrastáveis, mais pesado.
13. **Checklist de onboarding/milestones** — classes `milestoneList/milestoneRow/
    milestoneRowCompleted/milestoneRowNext/milestoneText/milestoneTextBold`, função
    `dismissOnboarding()`. Fluxo de primeiro uso; baixa prioridade pro Orion (ambiente
    multi-usuário já configurado pelo admin, não onboarding individual).
14. **Indicador de "fast mode" com cooldown** — classes `sparkLegend/sparkIcon/sparkCooldown`,
    estado `fastModeState.value==="cooldown"`, aparece colado no pill de esforço. Detalhe pequeno,
    não é um painel novo — só um estado visual a mais no seletor de esforço já existente.

### Não priorizado nesta rodada
Lista completa dos ~810 nomes de classe está salva localmente em
`/tmp/orion-build/css-components-2.1.283.txt` (máquina do Bayerl, não no c3) para consulta futura
caso surjam mais dúvidas sobre alguma tela específica — não copiado para o repo porque é matéria-prima
de pesquisa, não parte da implementação.

## 14. Mapa de agentes (Agent map) — rodada de 28/09/2026 (8)

Pedido ao vivo do Bayerl, com um print em mãos: um painel "Agent map" na barra lateral desta MESMA
extensão (que ele chama de "claude do antigravity"), listando cada subagente em background da sessão
atual — card com descrição truncada, duração ("25m 44s"), tokens ("311.8k tokens"), um dot de status
colorido, em árvore/grafo com linhas de conexão saindo de um nó raiz (nome/modelo/tokens da sessão)
até cada agente. Pedido explícito: "essa parte de multi agentes igual aqui o claude code do
antigravity coloca no claude do orion v2 por favor... já resolve tudo que precisar". Retoma o que a
seção 4 ("Subagent (tool Task)") tinha deixado de fora de propósito na rodada anterior: "a extensão
tem telemetria ao vivo (tempo decorrido, tokens, contagem de tool calls do subagente — `subagentRow`
real, exigiria stream de progresso por tarefa que o Orion não tem hoje)".

### O que foi investigado primeiro (`superpowers:systematic-debugging`, antes de escrever qualquer código)

**1. O painel "Agent map" é real — achado EXATO, não um "não existe" nem uma suposição.** Lido o
webview decompilado função por função (não só nome de classe), em DUAS versões: v2.1.282
(`/srv/orion-reference/vscode-extension/extension/webview/index.js`, já usada em rodadas anteriores)
e v2.1.283 (`/srv/orion-reference-2.1.283/webview/index.js` — mais nova, apontada pelo coordenador no
meio desta investigação como "a que está de fato instalada e rodando no Antigravity IDE agora"; as
duas bateram, função por função, só com nomes minificados diferentes — confirma que não é um recorte
de versão isolada, é um comportamento estável). Achados, com o nome da função real entre parênteses
(nomes da v2.1.282; a v2.1.283 tem os mesmos, só renomeados pelo minificador — ex. `zV0`→`WV0`,
`qV0`→`KV0`, `b85`→`v85`):
- Componente do diálogo (`zV0`/`WV0`): `R(k4,{title:"Agent map",onClose:X,maxWidth:1200,scrollInside:!0,
  children:[R("div",{className:E2.subtitle,children:[H," ",U$(H,"agent")," · click an agent for
  details"]}), F("div",{className:E2.tree, ...`. Ou seja: título literal **"Agent map"**, subtítulo
  **"{N} agent(s) · click an agent for details"**.
- Gatilho: um "pill" no rodapé do compositor (mesma fileira do seletor de modelo — `modelPill_gGYT1w`,
  classe `agentsPill_EGyesg`), com ícone, um dot de status (`data-agents-dot`) e o texto "{N} agent(s)"
  — `aria-label`/`title` variam por estado: `"waiting"`→"An agent is waiting for your permission ·
  Click to open the agent map", `"running"`→"Agents are working · Click to open the agent map",
  `"failed"`→"An agent failed · Click to open the agent map", `"idle"`→"Click to open the agent map".
  Telemetria de abertura: `logEvent("agent_map_opened",{source:...,agent_count:...,background_task_...})`.
- Árvore raiz→agentes (`E2.tree`/`E2.node`/`E2.children`/`E2.child`, função `zV0`/`GV0`): raiz é a
  sessão (`f85`: dot `running`/`idle` + resumo da sessão + `"{modelo}"` + `"{tokens} tokens in
  context"`), cada agente é um botão (`k85`: dot de status + `agent.description` + meta de
  duração/tokens via `qV0`). **Conectores são CSS puro, sem SVG/lib**: `.children:before` (traço
  horizontal saindo da raiz, ESCONDIDO quando é filho direto de `.rowMain` — a raiz mesma desenha seu
  próprio traço via `.rowMain:not(:only-child):after`) + `.child:before`/`.child:after` (traço
  horizontal de entrada + tronco vertical, cortado em 50% no primeiro/último filho, escondido inteiro
  com `:only-child`) — confirmado lendo `webview/index.css` linha por linha (`grep -oE
  '\.[a-zA-Z]+_iHnHpw[^}]*\}'`), não só os nomes de classe.
- Duração/tokens de cada agente (`qV0`/`b85`): `b85($,J)` — se `status==="working"`, `J-$.startTime`
  (tempo decorrido; `startTime` é `Date.now()` **observado no cliente** no instante em que o
  `tool_use` chega, não um timestamp de servidor — confirmado lendo `agentMapAgents.value=cE1(...,
  {taskId,toolUseId,...,startTime:Date.now(),status:"running"})`); terminado, prefere
  `usage.durationMs` (quando `status==="finished"`) sobre `endTime-startTime` computado; esconde tudo
  abaixo de 1s. Tokens: `agent.usage?.totalTokens`, formatado "N tokens" (função `EG`, um formatador
  compacto tipo "311.8k" — é daí que vem o número do print do Bayerl).
- **Achado extra do coordenador, confirmado ao ler**: existe TAMBÉM uma fileira dobrável separada,
  `subagentRow` (`subagentRow_mpBgEA`, componente `MA1`/`h95`/`y95` na v2.1.283 — `lU0`/`iU0`/`dU0` na
  v2.1.282, mesma coisa, nomes diferentes) — é a linha condensada que aparece **dentro da timeline
  principal**, não no diálogo "Agent map", enquanto agentes em background ainda rodam ("focus-fold
  row"/"Collapse"). Confirmado NÃO ser o mesmo componente do diálogo (são dois lugares
  diferentes que leem o mesmo `agentMapAgents.value`) — documentado aqui pra não confundir com a
  seção 4 antiga, que já citava esse nome.
- **Achado extra do coordenador, descartado após checar**: as classes `innerCall`/`innerCallHeader`/
  `innerCallList`/`innerCallSpinner`/`innerCallComplete`/`innerCallError` (levantadas como possível
  "detalhe expandido de um agente") são, na verdade, da tool **REPL** (`class AD1{name="REPL"}`) —
  a lista de tool calls aninhadas que uma execução de REPL dispara, SEM NENHUMA relação com Task/Agent
  map. Confirmado lendo o componente inteiro antes de citar — não usado aqui.
- Não replicado, de propósito (mesma decisão de escopo de outras rodadas — "não é o widget inteiro, só
  a granularidade"): view de detalhe POR agente ao clicar (`y85`/`S85`/`m85` — históricos de tool calls
  do próprio subagente, telemetria de contagem por status). O prompt/resultado de cada `Task` já é
  visível na timeline principal (`TaskAgent`, existente desde a rodada anterior); duplicar aqui seria
  além do pedido (um mapa/visão geral, não um visualizador de transcript por agente). O subtítulo do
  nosso painel reflete essa decisão: "{N} agente(s) nesta sessão", sem prometer "clique para
  detalhes" que não implementamos.

**2. Dado real disponível no Orion — verificado até onde este ambiente permite, com uma lacuna
honesta documentada.**
- `claude_events.ts` (coluna `TIMESTAMPTZ NOT NULL DEFAULT now()`, migração original em
  `server/migrations.ts`) já existe em TODA linha persistida, e `GET /api/claude/sessions/:id`
  (`server/routes/claude.ts`) já faz `SELECT seq, ts, type, payload FROM claude_events ...` e devolve
  `ts` sem nenhum corte — confirmado lendo o SQL, não assumido. `web/src/claude/live.ts` já tinha o
  tipo `Row = { seq: number; ts?: string; type: string; payload: any }` com `ts` declarado (só não
  usado em lugar nenhum até esta rodada). Ou seja: **duração real (`tool_result.ts − tool_use.ts`) já
  estava disponível sem nenhuma mudança de backend** — exatamente a pergunta que o pedido desta rodada
  fez.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (SDK 0.3.283, mesma versão do CLI rodando no
  servidor): `SDKUserMessage.tool_use_result?: unknown` — campo real, documentado assim: "Structured
  tool output — the tool's full Output object, not the string content sent to the model... **For the
  Agent/Task tool the completed shape is the subagent's final report... plus run totals — render from
  it instead of parsing the tool_result text**". `sdk-tools.d.ts`: `AgentOutput` é uma união de 3
  formas — `status:"completed"` (`totalTokens`, `totalToolUseCount`, `totalDurationMs`, mais um objeto
  `usage` completo estilo Anthropic Messages API), `status:"async_launched"` (subagente em background,
  SEM totais ainda — só `outputFile` pra consultar depois) e `status:"remote_launched"` (agente na
  nuvem). Como o runner do Orion (`server/claude/runner.ts`) já persiste a mensagem SDK **inteira**
  (`await this.deps.store.appendEvent(id, m.type, m)`), esse campo, quando o SDK o populasse, já
  chegaria ao front sem NENHUMA mudança de backend.
- **Achado extra, fora do escopo desta rodada (documentado, não implementado)**: existe ainda um
  TERCEIRO canal de telemetria — mensagens `system` de subtipo `task_notification`/`task_progress`/
  `task_started`/`task_updated` (`SDKTaskNotificationMessage` etc. em `sdk.d.ts`, cada uma com
  `usage:{total_tokens,tool_uses,duration_ms}`), que são exatamente a fonte que a webview real usa pra
  atualizar `agentMapAgents` AO VIVO enquanto um subagente em background roda (`handleTaskProgress`/
  `handleTaskNotification`/`handleTaskUpdated`, achado nesta mesma investigação — texto tagueado
  `<task-notification task-id="..." tool-use-id="..." status="...">` com `<subagent_tokens>`/
  `<tool_uses>`/`<duration_ms>` embutidos, função `TE`). Como esses são tipos de `SDKMessage`
  (`type:"system"`), o `for await` do runner os receberia e persistiria igual a qualquer outro (o
  runner não filtra por subtipo, exceto `init`/`commands_changed`, que só disparam efeito colateral
  extra, nunca pulam o `appendEvent` genérico) — **se** o CLI de fato os emitir pra este processo. Não
  implementado nesta rodada: ficaria mais completo (tick ao vivo de tokens/tool-calls enquanto um
  agente em background roda, não só no fim), mas exigiria mais uma correlação por `task_id` e não pôde
  ser confirmado se o processo `claude` do Orion (autenticado via `claude setup-token`, sem sessão de
  login interativo completa — ver seção 3) realmente os emite; escopo maior que o pedido, documentado
  aqui pra retomar se um dia fizer sentido.
- **Lacuna de verificação, honesta**: diferente de rodadas anteriores (que confirmaram `rate_limits`
  ausente consultando o Postgres de produção ao vivo, read-only), esta rodada **não conseguiu**
  confirmar empiricamente se `tool_use_result` chega populado em produção — este ambiente de trabalho
  bloqueou a leitura de credenciais do banco (classificador de permissões do harness, categoria
  "Credential Materialization"). Então: o caminho de dado real (`parseAgentTaskUsage`) está
  implementado, testado (TDD) e ativo — mas, igual ao proxy de `rate_limits` documentado na seção 3,
  **pode estar inativo na prática hoje**, sem confirmação. Diferença importante pro caso de
  `rate_limits`: aqui, mesmo SEM `tool_use_result`, o painel ainda mostra duração real (via
  `ts`/`tool_use.ts`↔`tool_result.ts`, dado que ESTE sim está confirmado por leitura de código, não
  por suposição) — só os tokens ficam ausentes (omitidos, nunca um "0" ou estimativa fabricada) nesse
  cenário.

### O que foi implementado

TDD (`superpowers:test-driven-development`) nas funções puras — vermelho→verde confirmado (36 testes
novos falhando por função/campo ausente antes da implementação, `TypeError: X is not a function` — não
erro de digitação —, depois todos verdes):

- **`web/src/claude/types.ts`**: `AgentTaskUsage` (`totalTokens?`/`toolUses?`/`durationMs?`, cada campo
  `undefined` quando o SDK não populou — nunca um número inventado); `AgentTask` (`toolUseId`,
  `description`, `subagentType?`, `status: ToolStatus`, `startedAt?`, `endedAt?`, `usage?`).
  `SdkMessage`'s `'user'` ganhou `tool_use_result?: unknown` (campo real do SDK, documentado acima).
- **`web/src/claude/mapper.ts`**: `parseAgentTaskUsage` (lê `tool_use_result` defensivamente — só
  `status:"completed"` com pelo menos 1 dos 3 totais numéricos vira algo; `"async_launched"` ou
  ausência de todos os 3 vira `undefined`, de propósito); `noteAgentTask` (reduz UMA mensagem do SDK
  no mapa de agentes — cria no `tool_use` do `Task`, fecha no `tool_result` casado por
  `tool_use_id`, protege um `endedAt`/`usage` já real contra sobrescrita por um replay/reconexão mais
  novo — mesma disciplina de imutabilidade de `applyPendingToolWaitStatus`: devolve a MESMA referência
  quando nada muda); `agentTaskDuration` (mesma prioridade `b85`/`v85` real: rodando, `now-startedAt`;
  terminado com sucesso, prefere `usage.durationMs`; terminado com falha, prefere o computado; esconde
  abaixo de 1s); `formatAgentDuration` ("25m 44s", estilo do print); `sumSessionTokens` (soma
  `inputTokens+outputTokens` de todos os `result` da sessão — alimenta a meta do nó raiz, "tokens
  nesta sessão"; `undefined` sem nenhum turno concluído, nunca "0" antes da hora); `agentTaskList`
  (mapa→lista ordenada por `startedAt`).
- **`web/src/claude/live.ts`**: `LiveState.agentTasks: Record<string, AgentTask>` (mapa por
  `toolUseId`). `pushMessage` ganhou um 3º parâmetro `when` (default `Date.now()`, mesma convenção de
  `now` injetável já usada em `relativeTime`/`groupSessions`/`computeRealUsageBars`) e agora também
  atualiza `agentTasks` via `noteAgentTask`. `fromRows` calcula `when` do `ts` REAL de cada linha
  (`Date.parse(r.ts)`, com fallback defensivo pra `Date.now()` só se a linha vier sem `ts` — não
  deveria acontecer, a coluna é `NOT NULL`) — histórico reconstruído ganha duração REAL, não
  aproximada. `applyLive` ganhou um 3º parâmetro `now` (mesmo default/convenção) só usado pelo caso
  `'message'`, que passa pra `pushMessage` — eventos do SSE não carregam timestamp de servidor, então
  usam o instante observado no navegador (mesma técnica que a extensão REAL usa pro caso "rodando",
  confirmado acima).
- **`web/src/claude/icons.tsx`**: ícone novo `AgentMap` (raiz + 3 galhos, mesmo estilo minimalista de
  traço 1.5/16×16 do resto do arquivo — sem ícone existente que servisse).
- **`web/src/claude/AgentMap.tsx`** (novo componente): painel com cabeçalho (título "Mapa de agentes" +
  subtítulo com contagem) + corpo com a árvore CSS (raiz = sessão: dot de atividade + título + modelo
  + tokens da sessão; um card por `AgentTask`: dot de status + descrição + selo de `subagentType`
  quando existe + meta de duração/tokens, caindo pro rótulo de status (`taskStatusLabel`, já existente)
  quando não há tempo/token pra mostrar). Tique de 1s (só enquanto aberto E algo ainda roda) pra
  duração "ao vivo" avançar na tela. Esc fecha (capture + `stopImmediatePropagation`, mesmo padrão do
  `Lightbox.tsx`); clique no backdrop fecha (`target===currentTarget`, mesma checagem do Lightbox).
  **Sem `createPortal`, diferente do Lightbox — decisão deliberada, não um esquecimento**: as
  variáveis `--cc-*` (cores do tema, claro/escuro) são declaradas SÓ no seletor `.cc` (`claude.css`),
  nunca em `:root`; um nó portado pra `document.body` (irmão de `#root`, nunca descendente de `.cc` —
  confirmado lendo `web/index.html`/`main.tsx`) NÃO as herdaria, caindo pro valor inicial de cada
  propriedade CSS (fundo/borda transparentes) em vez do tema de verdade — um bug real que o próprio
  `Lightbox.tsx` provavelmente já tem hoje na regra `.cc-preview-close` (usa `var(--cc-bg2)`/
  `var(--cc-line)`/`var(--cc-fg)`, seria afetada do mesmo jeito), nunca verificado visualmente (sem
  navegador neste ambiente, igual sempre) — não corrigido aqui por estar fora do pedido desta rodada,
  só documentado pra não repetir o mesmo problema em código novo. `position:fixed` cobre a viewport
  inteira sem precisar de portal (nenhum ancestral tem `transform`/`filter`/`perspective` — conferido
  no `claude.css` inteiro), então o componente é renderizado como filho comum de `.cc` (por
  `ClaudePage.tsx`, irmão de `<Sidebar>`/`<main>`) e herda o tema certo.
- **`web/src/claude/ClaudePage.tsx`**: gatilho — ícone novo no grupo `.cc-tab-actions` (mesmo grupo de
  Sync/Power/Dots/setinhas de aba, construído ao longo do dia; `disabled={!activeId}`, igual às
  setinhas). **Decisão de posição, documentada**: a extensão real usa um "pill" no rodapé do
  compositor (`agentsPill`, ver achado acima), não um ícone no cabeçalho — decisão de escopo pra
  seguir o padrão já estabelecido HOJE no Orion (`.cc-tab-actions` é onde toda ação nova da aba entrou
  nas rodadas anteriores) em vez de reabrir `Composer.tsx`/sua fileira de rodapé, que não tem espaço
  pra mais um pill hoje sem redesenhar — mesmo espírito de outras decisões de adaptação (ex.: "Agrupar
  por" em vez de pastas arrastáveis na seção 2). `agentTaskList(state.agentTasks)` e
  `sumSessionTokens(events)` memorizados, passados pro painel junto de `state.status`/`modelLabel`.
- **`web/src/claude/claude.css`**: seção nova `Mapa de agentes` — overlay fixo centralizado
  (`.cc-agentmap-overlay`, `z-index:50`, acima dos menus do compositor que usam 20/21), painel
  (`.cc-agentmap`), árvore com conectores (`.cc-agentmap-tree`/`-node`/`-children`/`-child`,
  `::before`/`::after` absolutamente posicionados — MESMA técnica da extensão real, valores/nomes
  adaptados pro `--cc-line`/espaçamento daqui, não copiados literalmente), cards (`.cc-agentmap-card`,
  `.is-root` mais largo/em negrito), dots de status reaproveitando os tokens de cor já existentes
  (`--cc-success`/`--cc-failure`/`--cc-warning`/`--cc-pending`/`--cc-busy`, `is-running` com o mesmo
  `cc-pulse` já usado noutros lugares). Nenhuma lib nova (`package.json` conferido antes — só CSS puro,
  igual ao pedido).

### Verificação

TDD vermelho→verde confirmado: 36 testes novos falhando por função/campo ausente
(`tests/mapper.test.ts`: `parseAgentTaskUsage`, `noteAgentTask`, `agentTaskDuration`,
`formatAgentDuration`, `sumSessionTokens`, `agentTaskList`; `tests/live.test.ts`:
`LiveState.agentTasks` via `fromRows`/`applyLive`) antes de qualquer implementação, todos verdes
depois. Suíte inteira: **503 testes, 27 arquivos, todos verdes** (467 antes desta rodada + 36 novos).
`npm run typecheck` (`tsconfig.server.json` e `tsconfig.json`, os dois via `tsc --noEmit`) sem erro —
achou e corrigiu, de passagem, um bug de sintaxe autoinduzido nesta rodada (um comentário de bloco em
`AgentMap.tsx` continha um caminho de arquivo com `*/` no meio — `/srv/orion-reference*/webview` —
fechando o comentário cedo demais; corrigido reescrevendo o caminho sem glob). `vite build` gera sem
erro (mesmo aviso pré-existente de chunk grande, sem relação com esta mudança). Sem
navegador/visual-testing neste ambiente (mesma limitação de sempre) — não dá pra ver a árvore/
conectores renderizados de verdade; verificação foi por leitura cuidadosa do CSS real linha por linha
(não só nomes de classe) pra reproduzir a MESMA técnica de conector, mais os testes/build acima. Não
fiz `curl` contra rotas (não criei nenhuma rota nova nesta rodada — todo o dado usado já vinha de
`GET /api/claude/sessions/:id`, que já existia).

## 15. Criar/gerenciar git worktree direto pela UI do chat — implementado em 29/09/2026 (item 2 da seção 13)

Item de maior valor prático da investigação da seção 13 (worktree-por-tarefa já é o próprio fluxo de
desenvolvimento do Orion). Implementado numa worktree isolada (`/srv/orion-worktrees/worktree-ui`,
branch `feature/worktree-ui`) pra não mexer em `main` nem nos processos de outras sessões paralelas.

### O que a extensão real faz de verdade (lido em `/srv/orion-reference-2.1.283/webview/index.js`,
### v2.1.283 — mais nova que a v2.1.282 usada no resto deste documento, ver seção 13)

**Validação do nome** — função `fF0($)`, encontrada por completo (não só o nome):
```
function fF0($){if(!$)return"Name is required";if($.length>64)return"Name must be 64 characters
or fewer";if(!yY5.test($))return"Only letters, numbers, dots, hyphens, and underscores";if($==="."
||$===".."||$.includes(".."))return'Name cannot be "." or ".." or contain ".."';if($.endsWith(".")
||$.endsWith(".lock"))return'Name cannot end with "." or ".lock"';if(xY5($))return'Name cannot be
".git"';return null}
```
com `yY5=/^[a-zA-Z0-9._-]+$/` e `xY5($)=$.toLowerCase().replace(/\.+$/,"")===".git"` (ou seja, ".git"
também é rejeitado com pontos finais ou maiúsculas — `.GIT.` cai na mesma regra). Reimplementada
**literalmente** (mesma sequência de checagens, mesmos limiares) em duas cópias deliberadamente
duplicadas — `server/claude/worktree.ts` (`validateWorktreeName`, autoridade final) e
`web/src/claude/mapper.ts` (`validateWorktreeName`, só validação ao vivo no compositor) — mensagens
traduzidas pro padrão PT-BR do resto da tela, nunca compartilhadas entre cliente e servidor (o
servidor nunca confia no que o cliente já validou).

**O campo de nome** (componente que renderiza `worktreeInput_djirOA`, achado buscando a string
literal do label):
```
R("div",{className:_7.worktreeInput,children:[F("div",{className:_7.worktreeInputLabel,
children:"New worktree name"}),F("input",{...placeholder:"e.g. my-feature",value:G,disabled:J,
onChange:(H)=>{if(q(H.target.value),Z)Y()},onKeyDown:(H)=>{if(H.key==="Enter"&&G&&!U)X(G);
else if(H.key==="Escape")Q()},onBlur:()=>{if(!J&&!Z)Q()}}),J&&F("div",{className:
_7.worktreeInputStatus,children:"Creating worktree…"}),V&&!J&&F("div",{className:
_7.worktreeInputError,children:V})]}
```
`U` é `fF0(G)` (validação local, só roda com `G` truthy — campo vazio nunca mostra erro sozinho),
`V` prioriza o erro local sobre o erro do backend (`Z`), `J` é o estado de carregando (desabilita o
campo, mostra "Creating worktree…"). Enter só envia quando há texto E nenhum erro local
(`G&&!U`); Escape cancela.

**O envio e o resultado**, achados no componente que guarda o estado do painel de sessões
(`headerRow`/`newSessionButton`, mesma vizinhança de classe `_djirOA`):
```
createWorktree($){return this.sendRequest({type:"create_worktree",name:$})}
// no componente React:
[r,x]=p(!1),[m,W1]=p(!1),[d,i1]=p(null),
l0=t1(async(k1)=>{W1(!0),i1(null);try{await J.createWorktree(k1),x(!1)}
  catch(_0){i1(_0 instanceof Error?_0.message:"Failed to create worktree")}finally{W1(!1)}},[J])
```
`sendRequest` é uma chamada ao host da extensão (VS Code) — quem roda `git worktree add` de verdade é
o processo Node da extensão, nunca o webview (que não tem acesso a shell). Erro sem `.message`
(rejeição não-Error) cai no fallback literal **"Failed to create worktree"**.

**Achado que muda a implementação**: no `headerRow` real (onde `newSessionButton` e, em tese,
`createWorktreeButton` deveriam ficar lado a lado — mesmo grupo de sufixo de classe `_djirOA`), o
segundo filho do array de `children` é um **`null` literal no bundle**:
```
R("div",{className:_7.headerRow,children:[R("button",{className:_7.newSessionButton,...},
"New session"),null]})
```
ou seja: o botão que abriria o formulário de worktree **existe em CSS e toda a lógica por trás dele
segue viva e funcional** (estado, handler, validação, `createWorktree()`), mas o **gatilho na
barra lateral foi removido/desligado nesta build (v2.1.283)** — código morto do lado do disparo, não
do lado da funcionalidade. Confirmado que não é um `.vsix` corrompido: `createWorktreeButton`
aparece exatamente 2x no bundle inteiro, e as duas ocorrências são adjacentes (a chave e o valor da
MESMA entrada no objeto de mapeamento CSS-module — nenhum uso real em JSX em lugar nenhum). Sem
comando de paleta alternativo achado (`grep` por "New worktree" como rótulo de `registerAction` não
bateu). Não sabemos SE isso é intencional (feature em rollout escalonado) ou um bug de build da
Anthropic — não é hipótese nossa mudar isso, só documentar o achado.

**O banner** (`worktreeBanner_aqhumA`, dentro de `sessionBody`, acima da lista de mensagens):
```
J.host!=="jetbrains"&&$.activeSession.value?.worktree.value&&
$.activeSession.value.worktree.value.path!==J.defaultCwd.value&&
R("div",{className:y8.worktreeBanner,children:[R("div",{className:y8.worktreeBannerLeft,
children:[F(bD1,{size:14,className:y8.worktreeBannerIcon}),F("span",{children:
"This session is in worktree"}),F("span",{className:y8.worktreeBannerName,children:
$.activeSession.value.worktree.value.name})]}),F("button",{className:y8.worktreeBannerButton,
onClick:()=>{...J.openFolderInNewWindow(m)},children:"Open worktree"})]})
```
Condição real: só aparece quando a sessão ativa tem `worktree` E o path dele é diferente do
`defaultCwd` (o workspace principal). "Open worktree" chama `openFolderInNewWindow` — abre o
worktree numa **nova janela do editor**, conceito que não existe numa página web de chat só.

**A pill na lista de sessões** (`worktreePill_OOQiHg`, mesmo grupo de sufixo dos itens da lista —
`tab_OOQiHg`, `sessionName`, `sessionMeta`):
```
O&&J.worktree.value&&J.worktree.value.path!==_&&R("span",{role:"button",tabIndex:0,
className:H5.worktreePill,onClick:(C)=>{C.stopPropagation(),O(J)},
title:`Open ${J.worktree.value.name} in new window`,
children:[F("span",{className:H5.worktreePillName,children:J.worktree.value.name}),
F(YP1,{className:H5.worktreePillIcon})]})
```
Mesma condição do banner (path do worktree ≠ cwd padrão), mesmo destino (`openFolderInNewWindow`).

### Modelo de sessão/projeto do Orion — o que já existia antes desta rodada

Investigação em `server/routes/claude.ts`/`server/claude/runner.ts` (não hipótese): o Orion já é
multi-projeto (tabela `projects`: `id, slug, name, path, rules`) — diferente da extensão real, que é
sempre 1 workspace só. `claude_sessions` **já tem uma coluna `cwd` própria**, separada de
`projects.path` — hoje sempre igual ao `path` do projeto na criação (`POST /api/claude/sessions`
grava `project.path` tanto no `cwd` quanto no `startTurn`), mas nada na estrutura impede que
divirjam — na verdade `startFor` (sessões já existentes, ex. após restart) **já usa `s.cwd`**, não
`project.path`, pro `systemAppend`/`startTurn`. Ou seja: a coluna certa pra guardar "esta sessão roda
num worktree" já existia, faltava só alguém popular com um path diferente. Isso decidiu a arquitetura
inteira desta rodada: **nenhuma migração nova** — sem coluna pra "nome do worktree" nem "é worktree?"
— tudo derivado comparando `cwd` da sessão com `path` do projeto.

Também já existe, achado por acaso enquanto procurava por `execFile('git'` no server, um **Kanban de
Tarefas inteiro** (`server/routes/tasks.ts`, `server/tasks/git.ts`, `server/tasks/util.ts`) que já cria
git worktrees pra tarefas (`createWorktree(repoPath, branch, baseBranch, targetPath)`, sempre
`execFile`, nunca shell, timeout curto, `isSafeBranch` valida toda ref antes de chegar no git). Decisão
de reuso: a "Aba Claude" chama **a mesma função** `createWorktree` de `server/tasks/git.ts` — só o
cálculo de *onde* (path) e *com que nome de branch* é próprio do novo módulo
`server/claude/worktree.ts`, porque o Kanban amarra isso a um `taskId` numérico
(`worktreePath(root, slug, taskId)` → `<root>/<slug>/<taskId>`) e este fluxo nasce de um nome
digitado livremente no compositor — mais perto do `createWorktree($)` da extensão real que da
convenção numérica do Kanban.

**Duas convenções de path já em uso no c3, nenhuma delas do Kanban**: dos 7 worktrees vivos no
servidor no momento desta implementação, 4 seguem `/srv/orion-worktrees/<nome>` (`agent-map`,
`memoria`, `memoria-dashboard`, e esta própria `worktree-ui`, todos branch `feature/<nome>` — convenção
que humanos/outros agentes Claude Code adotaram informalmente pra desenvolver o PRÓPRIO Orion) e 3
seguem `/srv/worktrees/orion/<nome>` com branch `tarefa/orion-<nome>` (esses sim vieram do Kanban —
`taskBranch`/`worktreePath` batem exatamente com o padrão observado). **Decisão de escopo**: a "Aba
Claude" segue a PRIMEIRA convenção (`<project.path>-worktrees/<nome>`, branch `feature/<nome>`) — é a
que o próprio pedido desta tarefa citou como exemplo (`/srv/orion-worktrees/<nome>`), bate com a
maioria dos worktrees vivos, e generaliza de forma óbvia pra qualquer projeto multi-repo do Orion
(`/srv/projects/<slug>` → `/srv/projects/<slug>-worktrees/<nome>`) sem depender de `$WORKTREES_DIR`
(uma env var pensada só pro Kanban, com default `/srv/worktrees` — raiz DIFERENTE da que este pedido
pedia). `worktreesBaseDir(projectPath)` em `server/claude/worktree.ts` implementa isso: sufixa
`-worktrees` no próprio `path` do projeto (`dirname+basename+'-worktrees'` dá o mesmo resultado que
`path+'-worktrees'` sempre que `path` não termina em barra — mais simples que separar e remontar).

### O que foi implementado

**Servidor** (`server/claude/worktree.ts`, novo): `validateWorktreeName` (regra da extensão, PT-BR),
`worktreesBaseDir` (pasta irmã `<repo>-worktrees`), `createWorktreeForProject(projectPath, name,
baseBranch)` — valida o nome, monta `branch = feature/<nome>` (checado de novo com `isSafeBranch`,
reuso de `server/tasks/util.ts`, defesa em profundidade mesmo o nome já sendo regex-limitado), chama
`createWorktree` de `server/tasks/git.ts` com o `target` calculado. Nome inválido nunca chega a tocar
disco/git (curto-circuita antes do `execFile`).

`server/routes/claude.ts`: `POST /api/claude/sessions` ganhou `worktree_name?: string` no corpo
(opcional — ausente/vazio = sessão normal na raiz do projeto, comportamento **inalterado**). Quando
presente: busca `default_branch` do projeto com a MESMA leitura defensiva que `server/routes/tasks.ts`
já usa (`projectOf`) — tenta a coluna, cai em `'main'` se a query falhar (coluna pode não existir
neste schema) —, chama `createWorktreeForProject` **antes de qualquer INSERT/turno começar**; se
falhar (nome inválido, branch já existe, `git worktree add` deu erro — ex. diretório já existe), a
rota devolve `400` com a mensagem e **nada é criado** (nem sessão, nem custo, nem turno) — mais
atômico que a extensão real, que decopla criar-worktree de criar-sessão em duas chamadas. Em caso de
sucesso, o path do worktree vira o `cwd` usado tanto no `INSERT` quanto no `runner.startTurn` E no
`systemAppend` (`projectPath: cwd`, corrigindo de passagem uma inconsistência latente: a rota de
criação usava sempre `project.path` ali, enquanto `startFor` — sessões já existentes — já usava
`s.cwd`; agora as duas seguem a mesma regra).

**Decisão de arquitetura — por que UM endpoint em vez de dois**: a extensão real decopla
completamente "criar worktree" (`createWorktree($)`, sem prompt nenhum) de "mandar mensagem" — dá pra
criar um worktree e nunca chegar a conversar nele. O Orion **não tem esse grau de liberdade**: `POST
/api/claude/sessions` sempre exigiu (antes desta rodada também) um `prompt` não-vazio — não existe
"sessão sem primeira mensagem" no modelo de dados atual, mudar isso seria uma mudança de arquitetura
bem maior que o pedido. Dado esse limite já existente, a escolha foi ligar a criação do worktree ao
MESMO request que já cria a sessão com o primeiro prompt, em vez de inventar um endpoint novo só pra
"criar o worktree e depois pedir pro usuário mandar uma mensagem numa sessão-fantasma". Efeito
colateral bom: atomicidade — no fluxo real, é possível criar um worktree e a criação da sessão falhar
depois por outro motivo, deixando um worktree "órfão"; aqui isso não acontece.

**Cliente**: `web/src/claude/mapper.ts` ganhou `validateWorktreeName` (cópia da regra, só UI) e
`sessionWorktreeName(cwd, projectPath)` (deriva o nome do worktree do ÚLTIMO SEGMENTO do `cwd` quando
ele difere do `path` do projeto — sem coluna nova, ver acima; espelha a checagem real `worktree.value
.path!==defaultCwd.value`). `web/src/claude/types.ts`: `SessionSummary` ganhou `worktreeName?:
string`. `web/src/claude/api.ts`: `claudeApi.create` aceita `worktree_name?: string`.

**Onde o botão/formulário aparece — decisão de escopo deliberada, diferente da extensão real**: a
extensão põe o gatilho na barra lateral, ao lado de "New session" (mesmo grupo de classe `_djirOA`
que `createWorktreeButton`/`newSessionButton`) — mas como vimos acima, esse gatilho está **desligado
até na própria extensão** nesta build, e mais importante: criar um worktree ali é uma ação
independente de "qual projeto" (a extensão só tem 1 workspace). O Orion é multi-projeto, e a única
tela onde "qual projeto vai receber esta sessão nova" já é uma pergunta ativa (`projects`/`onProject`
em `Composer.tsx`, só visível pra uma aba rascunho) é exatamente onde o nome do worktree também
precisa ser perguntado — não faria sentido puxar esse estado pra `Sidebar.tsx`, que hoje é um
componente burro (só recebe props, nunca fala com `claudeApi` diretamente) e não sabe "qual projeto"
sem replicar a mesma lógica que o compositor já tem. Implementado como um pill novo (`GitBranch` +
nome ou "Worktree") ao lado do `<select>` de projeto em `Composer.tsx`, mesmo padrão `cc-pop`/`Menu`/
`cc-menu-item` já usado pelos seletores de Modelo/Esforço/Modo (copiado literalmente, sem inventar
interação nova) — só visível junto do seletor de projeto (ou seja, só numa aba rascunho/sessão nova).
Estado (`worktreeName`) fica no `Tab` da aba (`ClaudePage.tsx`, ao lado de `projectId`), não em
`useState` isolado do Composer, pro valor sobreviver a re-render e ser lido em `send()` na hora de
montar o `POST /api/claude/sessions`.

**Validação ao vivo e bloqueio de envio**: campo vazio nunca mostra erro (vazio é um valor válido no
Orion — "sem worktree" — diferente da extensão, onde o campo só existe pra CRIAR um worktree, então
vazio sempre seria inválido); com algo digitado, `validateWorktreeName` roda a cada tecla (mesmo
padrão `let U=G?fF0(G):null` do real) e o botão Enviar (`canSend`) fica desabilitado enquanto o nome
digitado for inválido — extra nosso, mais seguro que a extensão real (lá o Enter no CAMPO de nome é
bloqueado por validação; aqui bloqueamos o ENVIO da mensagem inteira, porque é nesse momento que o
worktree de fato seria criado).

**Banner "esta sessão está no worktree X"** (`ClaudePage.tsx`, `.cc-worktree-banner`): mesma condição
real (`cwd` da sessão ativa ≠ `path` do projeto), mesma posição (topo do corpo da sessão, acima da
timeline) — sem o botão "Open worktree" (abre em nova janela do editor; não existe equivalente numa
página web só de chat) — o caminho completo do worktree já aparece na barra de status embaixo
(`.cc-status`, `active?.cwd`, já existia), então o banner aqui é só informativo.

**Pill na lista de sessões** (`Sidebar.tsx`, `.cc-item-worktree`): mesma ideia da `worktreePill` real,
sem ação de clique (mesmo motivo do banner — "abrir em nova janela" não existe aqui).

**Fora do escopo desta rodada** (por pedido explícito do escopo dado — "não precisa portar
sessionsByWorktree/listagem completa"): `availableWorktrees`/listagem de todos os worktrees
disponíveis pra reaproveitar num picker; nível "Ultracode" do seletor de esforço (item 1 da seção 13,
outro achado, sem relação); qualquer UI de REMOVER um worktree (`git worktree remove`) — worktrees
criados por esta feature nunca são apagados automaticamente pelo Orion (nem ao arquivar/deletar a
sessão), mesma postura conservadora que o Kanban já tem (só remove worktree numa ação explícita de
integração, nunca em cascade); "Open worktree"/navegação pra outra janela (sem equivalente aqui).

### Testes (TDD, vermelho→verde)

`tests/worktree.test.ts` (novo, 11 testes): `validateWorktreeName` (nomes normais, vazio, >64
caracteres, caracteres fora da lista, "."/".."/contém "..", termina em "."/".lock", ".git" com pontos
finais/maiúsculas — todos os ramos de `fF0`), `worktreesBaseDir` (monta a partir do path do projeto,
remove barra final antes de sufixar), `createWorktreeForProject` (nome inválido nunca chega a chamar
`execFile`/git — testável sem repositório real, porque o curto-circuito acontece antes).

`tests/mapper.test.ts` (+6 testes): `validateWorktreeName` (mesma regra, cópia do lado cliente — só
confirma que bate com a cópia do servidor, sem duplicar cada caso já coberto em `worktree.test.ts`),
`sessionWorktreeName` (cwd igual ao path do projeto → null; cwd dentro de `<path>-worktrees/<nome>` →
nome; sem cwd/path → null; barra final no path do projeto não confunde a comparação).

Suíte inteira: **484 testes** (467 antes desta rodada + 17 novos: 11 em `tests/worktree.test.ts`, 6
em `tests/mapper.test.ts`), todos verdes. `tsc --noEmit` limpo tanto em `tsconfig.server.json` quanto
em `tsconfig.json` (front). `npm run build` (`vite build && tsc -p tsconfig.server.json`) limpo — o
único aviso é o de chunk grande do `Editor` (CodeMirror), pré-existente, sem relação com esta rodada.
**Sem navegador/visual-testing neste ambiente** — mesma limitação de sempre; o pill/banner/campo não
foram vistos renderizados de verdade, só revisados por leitura cuidadosa comparando com o padrão já
em produção dos seletores de Modelo/Esforço/Modo (`cc-pop`/`Menu`/`cc-menu-item`, reuso literal).

## 17. Editor de regras de permissão (allow/ask/deny) — implementado em 29/09/2026 (item 9 da seção 13), worktree isolada `feature/permission-rules`

Item 9 da investigação da seção 13 ("Editor de regras de permissão... provavelmente uma tela de
Settings pra editar allow/deny, equivalente UI do que hoje só existe em `settings.json`/CLAUDE.md").
Implementado numa worktree isolada (`/srv/orion-worktrees/permission-rules`, branch
`feature/permission-rules`), a partir de `/srv/orion` (main) — sem tocar em mudanças não commitadas
que outras sessões tinham na working tree de `main` no momento.

### O que a extensão real faz de verdade (lido em `/srv/orion-reference-2.1.283/webview/index.js`, v2.1.283 — a mais nova, ver seção 13)

Achado a mais importante desta rodada: a investigação original da seção 13 (item 9) tinha listado
`confirmRemoveRow`/`confirmRemoveText` junto com as outras classes do editor de regras, só por
proximidade de nome/tema — **errado**. Lendo o componente inteiro (busca por offset de byte de `var
U4={sectionHeading:...}` no bundle, não só `grep` de nome de classe solto), o editor de regras de
verdade usa o grupo de classes `_0Reg3g` (`sectionHeading/addRuleButton/ruleItem/ruleText/ruleSource/
ruleActions/removeButton/readOnlyReason/notInEffect/managedNotice/errorMessage/loadingText/
emptyState/hint/scopeNote/ruleMain/ruleDescription/warningMessage/overlayPanel/overlayTitle/
overlayNote/overlayButtons/confirmRule/ruleInput/destinationRow/destinationSelect`) — SEM
`confirmRemoveRow`/`confirmRemoveText`. Essas duas pertencem a um componente TOTALMENTE diferente
(grupo `_IHCQeQ`, var `P1` — o painel de servidores MCP: `serverList/serverItem/callbackUrlSection/
scopeOption/formActions/confirmRemoveRow/confirmRemoveText`, confirmado pelas outras classes do mesmo
objeto — `mcpServerList`, `awaitingAuth`, `callbackUrlSubmit` — inequivocamente o fluxo de conectar/
remover um servidor MCP, não regras de permissão). Achado documentado na correção do item 9 da seção
13 acima.

O componente real (`jW0({session,onClose})`, aberto num diálogo `f4` com título fixo **"Permission
rules"**) fala com a Query AO VIVO da sessão via 3 métodos (`session.listPermissionRules()`,
`session.addPermissionRules(rules, behavior, destination)`, `session.removePermissionRule(rule,
behavior, source)`) — wrappers da extensão em cima dos control requests do SDK
(`SDKControlListPermissionRulesRequest`/`SDKControlPermissionRulesState` em
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, confirmados: "Requests the session's live
permission rules and workspace directories — the same data /permissions lists in the terminal: rules
from settings files plus session-only approvals, slash-command grants, and --allowedTools flag rules,
each with its source"). Cada regra (`SDKPermissionRuleEntry`) tem `rule`, `behavior`
(`allow`/`ask`/`deny` — constante `xA1=["allow","ask","deny"]`, rótulos `AW0={allow:"Allow",
ask:"Ask",deny:"Deny"}`), `source` (uma de ~10 fontes: `userSettings`/`projectSettings`/
`localSettings`/`policySettings`/`flagSettings`/`cliArg`/`command`/`session`/`toolsNarrowing`/
`mcpServerPolicy`/`hostCredential` — mapa `s35` com o texto de cada uma, ex.
`userSettings:"user settings"`, `localSettings:"project local settings"`), `editability`
(`"persistent"` = editável; outra coisa = só leitura, com motivo mostrado via `t35()` — "Not saved in
a settings file.", "Approved for this session only...", "Managed by enterprise settings.", etc.) e
`notInEffect` (regra existe mas não está valendo, ex. quando `managedOnly` bloqueia tudo que não é
política). Além das 3 seções allow/ask/deny, um bloco "Workspace" à parte lista `originalCwd` +
`workspaceDirectories[]`, só leitura, sem botão de remover — fora de escopo aqui (ver decisões
abaixo). Regra é texto livre validado só por não-vazio (`Q.trim().length===0` desabilita o botão
"Add rule") — nota fixa na tela: "A permission rule is a tool name, optionally followed by a
specifier in parentheses, e.g. `WebFetch` or `Bash(ls *)`.". Destinos de escrita (`Y$5`, no formulário
de adicionar): só 3 das ~10 fontes acima são escreveis — `localSettings`/`userSettings`/
`projectSettings` (rótulos curtos `Vv`: "this project (just you)" / "all projects" / "this project
(shared)"), com `localSettings` como padrão inicial. Remover uma regra abre um overlay de confirmação
de verdade — achado que CONFIRMA a expectativa do pedido de que a extensão real tem essa confirmação,
só que com classes diferentes das listadas originalmente: `overlayTitle` = **"Remove {behavior}
rule?"**, corpo com `confirmRule` (texto da regra + fonte), nota fixa "The rule is deleted from its
settings file and stops applying to this session once Claude Code has re-read its settings.", botões
"Remove rule"/"Cancel". Depois de add/remove, a extensão faz um vaivém de confirmação assíncrona
("pending"/"unconfirmed") porque está pedindo pro PROCESSO da Query re-ler o arquivo do disco e
confirmar via file watcher, com timeout — mecanismo que só faz sentido quando a fonte da verdade é
uma sessão ao vivo remota.

### Decisões de arquitetura do Orion (documentadas em detalhe em `server/claude/permissionRules.ts`)

**Por que ler/escrever o arquivo direto, e não rotear pela Query viva de uma sessão**: investigação em
`server/claude/runner.ts` (não hipótese) confirma que `Runner.run()` sempre chama o SDK com
`settingSources: ['user', 'project']` — **nunca `'local'`**. Ou seja, `.claude/settings.local.json`
NUNCA é lido por uma sessão do Orion hoje, e por isso esse escopo nem é oferecido na UI (oferecer
seria uma cilada silenciosa: a regra pareceria salva, mas nunca teria efeito nenhum). Dos 2 escopos
que sobram e que o Orion de fato lê, nenhum depende de uma sessão ao vivo — `'user'` é
`~/.claude/settings.json` do usuário do SO que roda o servidor (`danilo` na c3, confirmado com
`getent passwd danilo` → home `/home/danilo`; hoje sem `settings.json` ainda, só a pasta `~/.claude/`
com outros arquivos), `'project'` é `<project.path>/.claude/settings.json`, `path` já resolvido pela
tabela `projects` (nunca um caminho vindo do cliente). Como o SDK só lê esses arquivos quando uma NOVA
Query é construída (início de sessão), nunca hot-reloaded no meio de um turno, não existe nenhuma
vantagem em ir pela Query viva (que só existiria enquanto um turno está rodando, e o Orion é
multi-projeto — nem sempre há uma sessão ativa pro projeto que alguém quer editar agora) em vez de
ler/escrever o arquivo direto no disco do servidor. Consequência boa: sem a dança "pending/
unconfirmed" da extensão real (aqui a escrita já É a verdade, na hora) e o painel funciona mesmo sem
nenhuma sessão aberta.

**Escopo mostrado — por projeto, não "workspace único"**: diferente da extensão real (1 workspace só),
o Orion é multi-projeto (`projects: id, slug, name, path, rules`), então o painel tem um seletor
Projeto/Usuário (`<select>` de projeto quando `scope==='project'`, mesmo padrão `cc-pill cc-select` já
usado no seletor de projeto do compositor) em vez de mostrar "o workspace atual" implícito. As 3
seções (Permitir/Perguntar/Negar, tradução de Allow/Ask/Deny) são sempre 100% editáveis quando
`canEdit` é verdadeiro — sem as seções só-leitura (`cliArg`/`session`/`policySettings`/...) da
extensão real, que não existem no modelo do Orion (sem flags de CLI por sessão, sem camada de
política enterprise configurada aqui) — e sem o bloco "Workspace directories", que também não tem
equivalente (o Orion não tem um mecanismo de "adicionar diretório extra" pela UI).

**Escrita em `'user'` restrita a admin**: um único `~/.claude/settings.json` é compartilhado por TODOS
os projetos E todos os usuários do Orion (o CLI sempre roda com o mesmo login `danilo` na c3) — um
raio de efeito global bem maior que qualquer outra configuração editável hoje pela UI. Por isso
`POST`/`PUT`/`DELETE /api/claude/permission-rules` com `scope: "user"` exigem `req.user.role ===
'owner'` (`server/routes/claude.ts`, mesmo padrão já usado em `DELETE /api/claude/sessions/:id`) —
gate novo, só pra este escopo; leitura (`GET`) é livre pros dois escopos pra qualquer usuário
autenticado, e escrita em `'project'` também não tem gate extra (mesmo nível de confiança que o resto
do app já dá a `projects.rules`, sem ACL por projeto no schema).

**"Editar" como conveniência que a extensão real não tem**: a extensão real só tem Add/Remove — editar
o texto de uma regra existente não é uma operação de 1 clique lá (seria remover + adicionar de novo,
manualmente). O pedido desta tarefa pedia editar explicitamente, então existe aqui como uma rota
própria (`PUT`, função pura `replaceRule(set, oldBehavior, oldRule, newBehavior, newRule)`: remove a
regra antiga (se ainda existir — idempotente, não lança se já sumiu) e adiciona a nova, numa escrita
de arquivo só) — inclui trocar o `behavior` no mesmo gesto (ex. mover uma regra de "Permitir" pra
"Negar"), que a extensão real também não oferece (lá seria remover de uma seção e adicionar noutra).

**Confirmação de remoção**: pedida explicitamente pela tarefa E confirmada como comportamento real da
extensão (overlay "Remove {behavior} rule?", ver acima) — implementada como `.cc-permrules-confirm`,
um overlay pequeno POR CIMA do próprio painel (`.cc-permrules-overlay-inner`, `position:absolute`
sobre `.cc-permrules`, que ganhou `position:relative`), mesma mecânica de Esc
(capture+`stopImmediatePropagation`, fecha primeiro a confirmação/formulário mais interno antes de
fechar o painel inteiro) já usada em `AgentMap.tsx` e `Lightbox.tsx`.

**Validação da regra**: mesma regra de fundo da extensão real (só exige texto não-vazio depois de
`trim()` — sem validar formato "Tool(spec)" nem lista de ferramentas conhecidas, porque a extensão
real também não valida isso no cliente) + um acréscimo só do Orion: limite de 400 caracteres
(`validateRuleText`), defesa contra colar um texto gigantesco num arquivo JSON que o CLI relê a cada
sessão nova — não existe na extensão real, documentado como decisão nossa.

**Escrita segura no disco** (`server/claude/permissionRules.ts`): `mergeSettingsPermissions` só
substitui as 3 chaves `permissions.allow/ask/deny`, preservando toda outra chave de nível superior do
`settings.json` (model, env, hooks...) e toda outra subchave de `permissions` (defaultMode,
additionalDirectories...) — nunca reescreve o arquivo do zero. Escrita "atômica" (arquivo temporário +
`rename`, atômico em POSIX dentro do mesmo diretório) evita deixar o `settings.json` pela metade se o
processo cair no meio. Se o arquivo já existe mas tem JSON inválido, `writePermissionRuleSet` RECUSA
escrever (lança um erro claro em vez de silenciosamente começar de um objeto vazio) — sobrescrever
assim destruiria toda a config que já estava lá só porque não conseguimos entender o arquivo; a rota
devolve esse erro pro usuário corrigir manualmente primeiro. Path do escopo `'project'`
(`settingsPathForScope`) nunca aceita um caminho relativo nem monta um caminho sem saber a raiz — o
único dado vindo do cliente é `project_id` (inteiro), resolvido pro `path` do projeto no servidor
(mesmo padrão de confiança que a criação de sessão/worktree já usa pra `project_id`); não há
superfície de path traversal aqui porque nenhum path bruto vem do cliente em nenhum momento.

### O que foi implementado

**Servidor** (`server/claude/permissionRules.ts`, novo, só funções puras + I/O injetável — mesmo
padrão de `attachmentBlocks` em `runner.ts`): `validateRuleText`, `settingsPathForScope`,
`parseSettingsPermissions`, `mergeSettingsPermissions`, `addRule`/`removeRule`/`replaceRule` (puras),
`readPermissionRuleSet`/`writePermissionRuleSet`/`mutatePermissionRuleSet` (I/O real por padrão,
injetável em teste). `server/routes/claude.ts`: `GET/POST/PUT/DELETE /api/claude/permission-rules`
(query string `scope`/`project_id` no GET; corpo JSON nos outros 3), gate de admin só pro escopo
`user` em escrita, 400/403/404/500 com mensagens PT-BR conforme o caso.

**Cliente**: `web/src/claude/api.ts` ganhou `PermissionBehavior`/`PermissionScope`/`PermissionRuleSet`
(mesmo padrão de `Mode`/`Effort` já existentes) + 4 métodos em `claudeApi`
(`permissionRules`/`addPermissionRule`/`editPermissionRule`/`removePermissionRule`).
`web/src/claude/PermissionRules.tsx` (novo): painel modal, mesmo padrão visual/estrutural de
`AgentMap.tsx` (overlay `position:fixed`, SEM `createPortal` — mesmo motivo documentado lá: herdar
`--cc-*`, que só existe dentro de `.cc`; Esc com capture+`stopImmediatePropagation`). `icons.tsx`
ganhou `Shield` (ícone novo, desenhado no mesmo estilo minimalista dos outros — sem equivalente
pronto). `ClaudePage.tsx`: novo botão na `.cc-tab-actions` (mesma fileira do Mapa de agentes/Parar/
Recarregar/Renomear) — diferente do Mapa de agentes, **não** desabilitado sem `activeId` (regras são
por projeto/usuário, não por sessão; faz sentido abrir o painel mesmo sem nenhuma aba aberta ainda);
`role` (novo estado, populado junto com `email` na mesma chamada `claudeApi.me()` que já existia)
alimenta `canEditUser`; `permRulesProjectId` deriva o projeto pra pré-selecionar no painel (sessão
real: via `project_slug`; aba rascunho: o projeto escolhido no seletor do compositor) — só um valor
inicial, o usuário troca livremente dentro do painel. CSS novo em `claude.css`
(`.cc-permrules-*`), reusando ao máximo classes já existentes (`.cc-btn`/`.cc-btn-primary`/
`.cc-select`/`.cc-pill`/`.cc-icon`/`.cc-toggle`/`.cc-loading`/`.cc-spinner`/`.cc-mono`) — só o
necessário é novo.

### Testes (TDD, vermelho→verde confirmado)

`tests/permissionRules.test.ts` (novo, 42 testes): confirmado vermelho primeiro (`Failed to load url
../server/claude/permissionRules` — módulo ainda não existia), depois verde após a implementação.
Cobre: `validateRuleText` (vazio, só espaço, 400/401 caracteres — limite exato); `settingsPathForScope`
(os dois escopos, path relativo em cada um lança, `project` sem `projectPath` lança);
`parseSettingsPermissions` (sem chave `permissions`, valores presentes, `raw` `undefined`/array/
string/número não lança, itens não-string filtrados, `allow` não-array vira vazio);
`mergeSettingsPermissions` (do zero, preserva outras chaves de nível superior E outras subchaves de
`permissions`, imutabilidade); `addRule`/`removeRule`/`replaceRule` (dedupe, trim, regra ausente não
lança, troca de behavior, idempotência quando a regra antiga já sumiu, imutabilidade); I/O real contra
`mkdtemp(tmpdir())` (mesmo padrão de `tests/attachments.test.ts`): arquivo ausente → vazio sem erro,
round-trip escreve/relê, cria `.claude/` quando falta, preserva chave `model` já existente ao
escrever, JSON inválido existente → leitura devolve erro sem lançar E escrita RECUSA sobrescrever
(lança, arquivo original intacto); `mutatePermissionRuleSet` (orquestra ler→mutar→escrever, duas
mutações em sequência acumulam).

Suíte inteira: **578 testes** (536 antes desta rodada — já incluindo trabalho de outras sessões em
paralelo, tabela do Kanban/memória/etc., sem relação com esta feature — + 42 novos, todos em
`tests/permissionRules.test.ts`), todos verdes. `npx tsc -p tsconfig.server.json --noEmit` e `npx tsc
-p tsconfig.json --noEmit` (front) limpos. `npm run build` (`vite build && tsc -p
tsconfig.server.json`) limpo — único aviso é o de chunk grande do `Editor` (CodeMirror), pré-existente,
sem relação com esta rodada. **Sem navegador/visual-testing neste ambiente** — mesma limitação de
sempre; o painel/formulário/confirmação não foram vistos renderizados de verdade, só revisados por
leitura cuidadosa comparando com o padrão já em produção do `AgentMap.tsx` (overlay/Esc/sem portal) e
dos seletores de Modelo/Esforço/Modo (`cc-pill`/`cc-select`/`cc-toggle`, reuso literal).

**Fora do escopo desta rodada** (decisão deliberada, documentada acima): escopo `'local'`
(`.claude/settings.local.json` — o Runner não lê, ofertar seria enganoso); seções só-leitura da
extensão real (`cliArg`/`session`/`policySettings`/`flagSettings`/`command`/`toolsNarrowing`/
`mcpServerPolicy`/`hostCredential` — nenhuma tem equivalente no modelo do Orion hoje); bloco "Workspace
directories" (sem mecanismo de "additional directories" pela UI do Orion); validação de formato da
regra além de não-vazio (a extensão real também não valida); qualquer coisa envolvendo uma Query ao
vivo (decisão de arquitetura documentada acima: ler/escrever o arquivo é suficiente e mais simples
pro modelo multi-projeto do Orion).

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
  necessidade prática sem exigir a persistência nova), widget completo do editor de diff do Monaco
  (gutters, minimapa, blocos movidos, linhas de revisão de acessibilidade — só a granularidade de
  caractere foi replicada, não o widget). **Correção de uma rodada bem mais tarde no mesmo dia**: a
  entrada que estava aqui pra "telemetria ao vivo de subagente (tempo decorrido/tokens/tool calls)"
  foi removida desta lista — não é mais um "deixado de fora"; ver seção 13 ("Mapa de agentes"), onde
  foi implementada de verdade (achado que o painel dedicado "Agent map" da extensão real EXISTE, não
  só o `subagentRow` condensado citado aqui originalmente).
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
- **implementado/corrigido nesta rodada (5)** (28/09/2026 — duas coisas reportadas ao vivo pelo
  Bayerl no mesmo dia; ver seção 8 para os detalhes e evidências completas): indicador "pensando"
  (ícone com 6 glifos — inclui o asterisco literal — ciclando num vai-e-volta a cada 120ms, +
  palavra sorteada de uma lista real de 84 gerúndios em inglês, trocando em 2s/5s/10s/15s.../cada
  5s — tudo extraído/confirmado no componente `Re` do webview decompilado v2.1.282, não inventado;
  achado que corrige a suposição inicial do pedido — o indicador real NÃO some no 1º token, fica
  visível o turno inteiro) — `ThinkingIndicator` em `Timeline.tsx`, evento sintético `kind:'busy'`.
  Investigação (`superpowers:systematic-debugging`, grounded na sessão de produção real
  `c4380a41-d263-408e-9543-4be08d1aea01`) do "padrão de mensagens diferente do plugin": achado
  **estrutural** documentado, não corrigido de propósito (card de permissão real é docado/fixo acima
  do compositor, fora da lista que rola, e não deixa rastro no histórico depois de decidido — mudar
  isso no Orion é uma decisão de arquitetura de UI maior, esbarraria em `ClaudePage.tsx`/
  `Composer.tsx`, fora de escopo aqui de propósito); e um **bug real corrigido** (tool_use mostrava
  "executando…" antes mesmo do usuário aprovar, porque `server/claude/runner.ts` descartava
  `opts.toolUseID` — campo real e documentado do SDK — ao criar o pedido de permissão; agora
  repassado, novo `ToolStatus` `'waiting'` ligado pelo id real, nunca um heurístico). 43 testes
  novos, confirmado via `git diff` (31 `mapper.test.ts`, 11 `live.test.ts`, 1 `runner.test.ts`);
  suíte inteira 403 testes, `tsc --noEmit` e `vite build` verdes.
- **implementado nesta rodada** (28/09/2026, follow-up ao vivo pedido pelo Bayerl — persistência do
  esforço, ver seção 10 para os detalhes e evidências completas): `effort` trazido a paridade total
  com `permission_mode`/`model` — coluna nova `claude_sessions.effort` (migração `009_claude_effort`,
  nullable, sem default, mesmo tipo de `model`), persistida no `INSERT` de criação, threaded com o
  padrão "só grava se mudou" em `.../messages`, e a rota `.../effort` (que a rodada 4 tinha deixado só
  com o lado ao vivo) agora persiste PRIMEIRO e só depois aplica ao vivo — mesma estrutura exata da
  rota irmã `.../mode`. `ClaudePage.tsx` restaura `effort` no efeito de carga de sessão
  (`matchEffort(s.effort)`, nova função pura em `api.ts`, mesma ideia de `matchModelAlias` já
  existente: nunca confia no valor do banco, sempre resolve pra um `Effort` concreto). Corrige o bug
  relatado ao vivo: o seletor de esforço resetava pra 'medium' a cada reload/troca de aba porque era
  só um `useState` compartilhado sem persistência nenhuma — agora sobrevive, uma sessão de cada vez,
  igual modo/modelo já faziam. 3 testes novos TDD (`matchEffort` em `mapper.test.ts`, vermelho→verde
  confirmado); suíte inteira 432 testes, `tsc --noEmit` (server e front) e `vite build` verdes; sem
  harness de teste pra rotas Fastify nem componentes React neste repo (confirmado por grep antes de
  assumir), então a verificação de `server/routes/claude.ts`/`ClaudePage.tsx` foi por leitura
  cuidadosa comparando linha a linha com o padrão de modo/modelo já em produção, mais `curl` (401
  esperado, sem auth) e consulta read-only ao Postgres de produção (schema ainda em
  `008_tools_details`, confirmando que a migração nova ainda não rodou lá).
- **implementado nesta rodada (7)** (28/09/2026 — "layout flutuante do composer", pedido ao vivo do
  Bayerl apontando pra esta MESMA extensão Claude Code como referência; ver seção 4/"Layout flutuante
  do composer" para os detalhes e evidências completas): estende o tratamento `position:absolute` que
  a rodada 6 já tinha adotado só pro card de permissão pro COMPOSER INTEIRO, igual à extensão real —
  `.cc-scroll` (a área que rola) agora ocupa a página inteira (era um item de grid dividido com
  `.cc-dock`), e `.cc-float` (substitui `.cc-dock`; contém `PermissionDock`+`Composer`) flutua POR
  CIMA dela, centralizado, `max-width:680px`, ancorado no rodapé (`.inputContainer_07S1Yg` real, valores
  exatos). `.cc-fade` novo reproduz a camada de esmaecimento real (`messageGradient_07S1Yg`: gradiente
  sólido até a cor de fundo — confirmado, buscando o CSS inteiro, que NÃO é blur/backdrop-filter, que só
  aparece 1x no bundle inteiro, num componente sem relação nenhuma). Spacer no fim de `.cc-scroll` com
  altura medida por `ResizeObserver` (`floatRef`/`floatHeight` em `ClaudePage.tsx`) — mesmo mecanismo
  exato do `z`/`U`/`V`/`ResizeObserver` reais, achado lendo o JS decompilado direto (não hipotetizado).
  `.cc-main` trocado de `grid-template-rows` de 5 trilhas fixas pra `flex-direction:column`, corrigindo
  de quebra uma fragilidade estrutural (posição de banner condicional podia desalinhar a trilha `1fr`).
  Sem lógica pura nova (mudança de layout/CSS + medição de DOM, não testável de forma significativa em
  `jsdom`); suíte inteira mantida em 429 testes (nenhum novo, nenhum quebrado), `tsc --noEmit` (server e
  front) e `vite build` verdes, `git diff --stat` confirmando só os 3 arquivos esperados tocados.
- **implementado nesta rodada (7)** (28/09/2026 — popup de imagem/Lightbox, pedido ao vivo do Bayerl
  superando o "abre em nova aba" que uma sessão diferente tinha implementado mais cedo no mesmo dia
  — commit `5b445b6`; ver seção 10 para os detalhes e evidências completas): lido o componente real
  inteiro no webview decompilado v2.1.282 (não só nomes de classe) — `AI0`/`yw`, o MESMO componente
  usado tanto pro anexo pendente do compositor quanto pra imagem de uma mensagem já enviada. Valores
  exatos do CSS real (`_vRjSkQ`): fundo do popup preto a **85%** de opacidade (`#000000d9` — não 60%
  como o pedido supunha de memória), imagem com teto de **90vw/90vh**, `border-radius:8px`,
  `box-shadow:0 4px 24px #00000080` (preto a 50%), botão de fechar circular 28px sobreposto ao canto
  (`top:-12px;right:-12px`). **Achado que corrige a suposição do pedido**: a extensão real NÃO tem
  navegação entre imagens (sem setas, sem tira de miniaturas, sem swipe — confirmado vasculhando o
  bundle inteiro por qualquer classe/função de galeria associada ao componente; cada anexo abre seu
  próprio popup independente) — o Lightbox implementado aqui também não tem, de propósito, seguindo a
  extensão real em vez do que o Bayerl lembrava dela fazendo. `web/src/claude/Lightbox.tsx` (novo,
  compartilhado por `Composer.tsx` e `Timeline.tsx`): fecha em Esc (capture+stopImmediatePropagation,
  igual ao real), clique no backdrop (só fora do container, mesma checagem `target===currentTarget`
  do real — clicar na imagem nunca fecha), botão X; `createPortal` em `document.body`. No
  compositor, substitui o `<a target="_blank">` do `5b445b6`. No histórico (`Timeline.tsx`), fecha um
  gap real que já existia antes deste pedido — a mensagem enviada só mostrava um chip com ícone+nome,
  nenhuma miniatura — porque a nota persistida do anexo nunca guardava o bastante pra buscar a imagem
  de volta; corrigido com `path` novo na nota (`server/claude/runner.ts` — já era devolvido ao
  navegador pelo upload, não é exposição nova) + rota nova `GET /api/claude/attachments`
  (`server/routes/claude.ts`, `type` restrito a `IMAGE_MEDIA_TYPES`, `path` validado com
  `isUnderRoot` — mesma checagem anti path-traversal de sempre, extraída pra função pura e reusada)
  + `attachmentImageUrl` (mapper.ts, pura) pra montar a URL. TDD nas duas peças de lógica pura
  (`attachmentImageUrl`/`isUnderRoot`), vermelho→verde confirmado (10 testes novos falhando por
  função ausente, depois implementados). Suíte inteira: **438 testes** (429 antes desta rodada + 9
  novos: 5 de `attachmentImageUrl`, 4 de `isUnderRoot`), `tsc --noEmit` (server e front) e `vite
  build` verdes. Sem navegador/visual-testing neste ambiente — mesma limitação de sempre.
- **implementado nesta rodada (8)** (28/09/2026 — "Mapa de agentes"/Agent map, pedido ao vivo do
  Bayerl com print em mãos, retomando a telemetria de subagente que a seção 4 tinha deixado de fora
  de propósito; ver seção 13 para os detalhes e evidências completas): investigação confirmou que o
  painel "Agent map" É REAL na extensão (lido em DUAS versões do webview decompilado, v2.1.282 E
  v2.1.283 — a segunda apontada pelo coordenador no meio da rodada como a versão mais nova de fato
  rodando; as duas bateram, confirma achado estável) — árvore raiz→agentes com conectores 100% CSS
  (sem SVG/lib nova), duração/tokens por agente vindos de um campo real do SDK
  (`SDKUserMessage.tool_use_result`, forma `AgentOutput`). Dado disponível pro Orion: duração REAL
  sempre (via `ts` já existente em `claude_events`/`GET /api/claude/sessions/:id`, sem nenhuma
  mudança de backend); tokens só quando o SDK realmente popula `tool_use_result` — **não confirmado
  ao vivo em produção nesta rodada** (diferente das rodadas anteriores, que conseguiam consultar o
  Postgres read-only; este ambiente bloqueou credenciais de banco) — caminho implementado e testado,
  mas honestamente marcado como não-verificado-em-produção, mesmo espírito do proxy de `rate_limits`
  na seção 3. Implementado: `AgentTask`/`AgentTaskUsage` (types.ts), `parseAgentTaskUsage`/
  `noteAgentTask`/`agentTaskDuration`/`formatAgentDuration`/`sumSessionTokens`/`agentTaskList`
  (mapper.ts), `LiveState.agentTasks` com hidratação por `ts` real (`fromRows`) e por instante
  observado no navegador (`applyLive`, `now` injetável) em live.ts, componente novo
  `AgentMap.tsx` (SEM `createPortal`, de propósito — evita um bug real de herança de variáveis CSS
  que o `Lightbox.tsx` existente provavelmente já tem e nunca foi visto, por falta de navegador neste
  ambiente), ícone novo em `icons.tsx`, gatilho em `.cc-tab-actions` (`ClaudePage.tsx` — decisão de
  posição diferente da extensão real, que usa um pill no rodapé do compositor; seguido o padrão já
  estabelecido no Orion hoje em vez de redesenhar o compositor), CSS novo em `claude.css` (árvore com
  conectores, cards, dots). TDD (vermelho→verde confirmado, 36 testes falhando por função/campo
  ausente antes da implementação); suíte inteira **503 testes** (467 antes desta rodada + 36 novos),
  `npm run typecheck` e `vite build` verdes. Sem navegador/visual-testing neste ambiente — mesma
  limitação de sempre.
- **implementado nesta rodada** (29/09/2026 — "Aba Claude": criar/gerenciar git worktree direto pela
  UI do chat, item 2 da seção 13, worktree isolada `feature/worktree-ui`; ver seção 14 para os
  detalhes e evidências completas): `server/claude/worktree.ts` (novo) — `validateWorktreeName`
  (regra idêntica à função real `fF0` do webview v2.1.283, traduzida pro PT-BR), `worktreesBaseDir`
  (pasta irmã `<repo>-worktrees`, mesma convenção já usada manualmente em `/srv/orion-worktrees` por
  humanos/outros agentes), `createWorktreeForProject` (reusa `createWorktree`/`isSafeBranch` de
  `server/tasks/git.ts`/`util.ts` — o mesmo Kanban de Tarefas já tinha essa camada de git, nada
  novo foi escrito pra chamar `git worktree add`). `POST /api/claude/sessions` ganhou `worktree_name?`
  opcional: cria o worktree ANTES de qualquer INSERT/turno (falha = nada é criado, mais atômico que a
  extensão real, que decopla as duas ações); `cwd` da sessão vira o path do worktree quando presente,
  sem coluna nova no Postgres (nome do worktree é sempre derivado comparando `cwd` da sessão com
  `path` do projeto — `sessionWorktreeName` em mapper.ts). Achado interessante documentado na seção
  14: o botão que dispara o formulário na extensão real (`createWorktreeButton`) está **desligado
  nesta build** (v2.1.283) — CSS e toda a lógica de estado/validação/submissão continuam vivos no
  bundle, só o gatilho na barra lateral virou um `null` literal no JSX. UI: pill "Worktree" ao lado do
  seletor de projeto em `Composer.tsx` (só em aba rascunho — decisão deliberada, diferente da barra
  lateral da extensão real, porque só ali "qual projeto" já é uma pergunta ativa no Orion, que é
  multi-projeto); banner "Esta sessão está no worktree X" no topo do corpo da sessão
  (`ClaudePage.tsx`) e pill na lista de sessões (`Sidebar.tsx`) — ambos sem o botão "Open worktree"
  real (abre em nova janela do editor; sem equivalente numa página web só de chat). 17 testes novos
  (11 em `tests/worktree.test.ts`, 6 em `tests/mapper.test.ts`), TDD, suíte inteira **484 testes**,
  `tsc --noEmit` (server e front) e `npm run build` verdes. Fora do escopo (pedido explícito):
  `availableWorktrees`/listagem completa de worktrees, remoção de worktree. Sem
  navegador/visual-testing neste ambiente — mesma limitação de sempre.
- **implementado nesta rodada** (29/09/2026 — "Aba Claude": editor de regras de permissão (allow/ask/
  deny), item 9 da seção 13, worktree isolada `feature/permission-rules`; ver seção 17 para os
  detalhes e evidências completas): lendo o componente real inteiro (`jW0` em
  `/srv/orion-reference-2.1.283/webview/index.js`), corrigido um erro da investigação original —
  `confirmRemoveRow`/`confirmRemoveText` NÃO pertencem ao editor de regras, são de um componente
  genérico diferente (remoção de servidor MCP); o editor real fala com a Query AO VIVO de uma sessão
  (`listPermissionRules`/`addPermissionRules`/`removePermissionRule`, control requests do SDK). Achado
  que decidiu a arquitetura: `server/claude/runner.ts` usa `settingSources: ['user', 'project']` —
  **nunca `'local'`** — então o Orion lê/escreve os DOIS arquivos `settings.json` (usuário e projeto)
  DIRETO no disco em vez de rotear por uma Query viva (que só existe durante um turno; o Orion é
  multi-projeto, nem sempre há sessão ativa pro projeto que alguém quer editar), sem oferecer o escopo
  `'local'` (nunca lido, seria uma regra que pareceria salva mas nunca teria efeito). `server/claude/
  permissionRules.ts` (novo, só funções puras + I/O injetável): validação, path do escopo, parse/merge
  de `permissions.allow/ask/deny` preservando as demais chaves do settings.json, add/remove/replace de
  regra, leitura/escrita em disco com escrita atômica (arquivo temp + rename) e recusa de sobrescrever
  um settings.json com JSON inválido. `GET/POST/PUT/DELETE /api/claude/permission-rules`
  (`server/routes/claude.ts`) — escrita no escopo `'user'` restrita a `role==='owner'` (raio de efeito
  global: um único settings.json de usuário compartilhado por todos os projetos/usuários do Orion).
  `web/src/claude/PermissionRules.tsx` (novo): painel modal (mesmo padrão de `AgentMap.tsx` — overlay
  `position:fixed`, sem `createPortal`, Esc com capture), seletor Projeto/Usuário, 3 seções Permitir/
  Perguntar/Negar com adicionar/editar/remover (remover com confirmação, igual à extensão real
  confirmada); gatilho novo (ícone `Shield`) na `.cc-tab-actions`, sem depender de `activeId`
  (diferente do Mapa de agentes) porque regras são por projeto/usuário, não por sessão. 42 testes
  novos TDD (vermelho→verde confirmado: `tests/permissionRules.test.ts` falhava por módulo ausente
  antes da implementação), suíte inteira **578 testes**, `tsc --noEmit` (server e front) e `npm run
  build` verdes. Fora do escopo (decisão documentada na seção 17): escopo `'local'`, seções só-leitura
  da extensão real (sem equivalente no modelo do Orion), bloco "Workspace directories", qualquer coisa
  via Query ao vivo. Sem navegador/visual-testing neste ambiente — mesma limitação de sempre.
