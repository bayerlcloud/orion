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
| Diff colorido para Edit (`insertions/deletions_oblbPg`, `char-insert/delete`) | **implementado agora** | diff unificado simples (linhas -/+) |
| Permission card allow/deny (`permissionRequestContainer_qlaBag`) | já tem | `cc-perm` |
| "Sim, e não perguntar de novo" (`Yes, and don't ask again`) | já tem | `allow_always` |
| Escopo do allow_always (session/settings) | n/a | sem UI de escopo; SDK decide |
| AskUserQuestion com opções (`questionBlock_hONcXw`, `optionLabel`, `radio`) | **corrigido agora** | `cc-ask`/`AskAnswer`: marcar opção só seleciona, um botão "Enviar respostas" finaliza; antes o 1º clique em qualquer opção já respondia tudo (sem dar pra marcar mais de uma em pergunta `multiSelect`), e a resposta ("Você respondeu") virava o JSON cru da pergunta em vez do texto escolhido — ver bug de `2026-09-28` |
| Navegação multi-pergunta (`navTab_hONcXw`, `navigationBar`) | n/a | renderizamos todas as perguntas em sequência, cada uma com sua própria seleção; "Enviar respostas" só habilita com todas respondidas |
| Todo list (`todoList_xheXVQ`, `todoItem`, pending/in_progress/completed) | n/a | baixa prioridade; não implementado |
| Subagent (`subagentRow_mpBgEA`, `innerCall_3H9AYw`) | n/a | fora de escopo |
| Plan mode / plan review (`ExitPlanMode`, `milestone*_UxGN1Q`) | n/a | fora de escopo (pedido) |
| Rewind / checkpoint (`rewind`, `changedFile_5FHdxw`, `checkoutButton`) | n/a | fora de escopo (arriscado) |
| Custo · duração · turnos no result (`metaMessage_07S1Yg`, `Total duration (API)`) | já tem | `cc-result` |
| Tokens de entrada/saída no result (`modelUsage`) | **implementado agora** | soma `modelUsage` → "N↑ / N↓ tokens" |
| Mensagem interrompida (`interruptedMessage_07S1Yg`) | já tem | via evento de erro/result |

## 5. Compositor

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Textarea; Enter envia, Shift+Enter quebra (`messageInput_cKsPxg`) | já tem | `Composer` |
| Recall de mensagens ArrowUp/ArrowDown (`cycleMessage`/`Cq0` no webview) | **implementado agora (28/09/2026)** | cicla pelas mensagens já enviadas da sessão quando o cursor está no início/fim do texto; ver seção "Compositor — rodada de 28/09/2026" abaixo |
| Esc foca/desfoca o compositor | já tem | listener global de Escape |
| Botão parar (`stopIcon_gGYT1w`) | já tem | `cc-stop` |
| Fila de mensagens enquanto roda (`queued`) | já tem (back) | back enfileira; placeholder avisa que dá pra enfileirar |
| Seletor de modelo (`modelPill_gGYT1w`, `modelItem_G8AMvA`) | **implementado agora (28/09/2026)** | era `<span>` decorativo; agora é um menu de verdade (Padrão/Sonnet/Opus/Haiku/Fable) que muda o modelo da próxima mensagem, inclusive no meio de uma sessão já existente — ver seção "Compositor — rodada de 28/09/2026" |
| Seletor de esforço Low/Medium/High/Extra high/Max (`effortLevel`, `modelPillEffort`) | já tem | menu; envia `effort` no create/send |
| Seletor de modo de permissão (`modeOption_7kXHPg` Manual/Plan/Accept edits/Auto) | já tem | menu visível (era só ciclo) |
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
- **implementado nesta rodada** (28/09/2026 — Conta e uso, ver seção 3 para os detalhes e
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
- **deixados de fora (n/a)**: todo list, subagent, plan mode/plan review, rewind/checkpoint,
  anexos, @-menções, voz, uso por modelo, atribuição de uso (`behaviors` existe no SDK mas é outra
  função — fora do escopo), navegação multi-pergunta, worktree, "Manage", grupos personalizados
  arrastáveis (pastas nomeadas e persistidas — "Agrupar por" cobre a necessidade prática sem exigir
  a persistência nova).
