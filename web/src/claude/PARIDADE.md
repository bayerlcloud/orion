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

| Elemento | no nosso v2? | Nota |
|---|---|---|
| Seção "Account" recolhível (`sectionTitle`, `sectionChevron_djirOA`) | **implementado agora** | chevron recolhe "CONTA E USO" |
| Linha CONTA / Email (`accountInfo`, `accountRow`, `accountValue_JuUW3A`) | **implementado agora** | e-mail via `GET /api/me` |
| Link "Manage" (`manageLink_JuUW3A`, `openAccountUsage`) | n/a | não há tela de conta acessível daqui |
| Barras de uso rotuladas (`usageBars_JuUW3A`, `usageFill_8s5nuw`, `usageLabel`, `usagePercent`) | **implementado agora** | 3 barras: "Sessão (5h)", "Semanal (7 dias)", "Limite Fable" |
| Rótulos reais (`Session (5hr)`, `Weekly (7 day)`, `Weekly Sonnet`, `weekly Opus limit`, `Fable…`) | n/a | são os nomes oficiais; adaptados p/ PT |
| "Resets {tempo}" (`resetText_8s5nuw`) | n/a | plano não expõe reset; subtítulo vira o custo real |
| % real do limite do plano | n/a | token OAuth é inference-scoped; usamos **custo como proxy** com aviso |
| Uso por modelo (`modelUsage_JuUW3A`, `modelUsageDetail`) | n/a | baixa prioridade |
| Atribuição por skill/agent/plugin (`attribution*_QET5Ow`, `behavior*`) | n/a | dado indisponível |

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
| AskUserQuestion com opções (`questionBlock_hONcXw`, `optionLabel`, `radio`) | já tem | `cc-ask` |
| Navegação multi-pergunta (`navTab_hONcXw`, `navigationBar`) | n/a | renderizamos todas as perguntas em sequência |
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
| Esc foca/desfoca o compositor | **implementado agora** | listener global de Escape |
| Botão parar (`stopIcon_gGYT1w`) | já tem | `cc-stop` |
| Fila de mensagens enquanto roda (`queued`) | já tem (back) | back enfileira; placeholder avisa que dá pra enfileirar |
| Seletor de modelo (`modelPill_gGYT1w`, `modelItem_G8AMvA`) | já tem | pill mostra o modelo da sessão |
| Seletor de esforço Low/Medium/High/Extra high/Max (`effortLevel`, `modelPillEffort`) | **implementado agora** | menu; envia `effort` no create/send |
| Seletor de modo de permissão (`modeOption_7kXHPg` Manual/Plan/Accept edits/Auto) | **implementado agora** | menu visível (era só ciclo) |
| Anexar arquivos/imagens (`attachedFilesContainer_cKsPxg`, `onAddFiles`) | n/a | "em breve" (pedido) |
| Comandos de barra (`commandList_G_S7FQ`, `slashCommand`) | **implementado agora** | menu com passthrough `/clear`, `/compact`, `/context`, `/cost` |
| @-menções (`mentionChip_uq5aLg`, "Add context") | n/a | fora de escopo (pedido) |
| Microfone/voz (`micButton_cKsPxg`) | n/a | fora de escopo (pedido) |
| Projeto da nova sessão | já tem | extra nosso (`cc-select`) |

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
- **implementado nesta rodada** (microfunções da lista de sessões — filtro, grupo,
  renomear): filtro por projeto (`cc-select` "Todos os projetos"/por projeto — extra
  nosso, já que o v2 é multi-projeto e a extensão real é 1 workspace só); controle
  "Agrupar por" Nenhum/Projeto/Atividade com cabeçalho colapsável por grupo
  (equivalente leve às pastas manuais arrastáveis da extensão real, que exigiriam
  tabela nova + rotas CRUD + drag-and-drop); lápis de renomear agora também visível
  no `:focus-within` (antes só `:hover`) — o endpoint de rename já existia
  (`POST /api/claude/sessions/:id/rename`), não foi criado nada novo no servidor.
  Lógica pura testada em `mapper.test.ts` (`filterSessions`, `groupSessions`).
- **deixados de fora (n/a)**: todo list, subagent, plan mode/plan review, rewind/checkpoint,
  anexos, @-menções, voz, uso por modelo, atribuição de uso, navegação multi-pergunta,
  worktree, "Manage", % real do plano (token inference-scoped — usamos custo como proxy),
  grupos personalizados arrastáveis (pastas nomeadas e persistidas — "Agrupar por" cobre
  a necessidade prática sem exigir a persistência nova).
