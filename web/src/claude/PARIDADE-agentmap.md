# Trilha par/agentmap — refino do Mapa de agentes (29/09/2026)

Anexo da trilha `par/agentmap` pro PARIDADE.md principal (seção 14 é a base; itens 5 e 8 da seção
13 são o escopo). Fonte canônica lida ANTES de cada peça: webview decompilado v2.1.283 em
`/srv/orion-reference-2.1.283/webview/index.js` (funções citadas por nome minificado, com o trecho
literal conferido no bundle). Quatro entregas: (1) agents pill, (2) tool calls aninhadas por
subagente, (3) linhas dobráveis com overflow, (4) veredito do Teleport (só documentação, nada
construído).

## 1. Agents pill — gatilho do Mapa de agentes no rodapé do compositor

**Como o mapa abria antes desta trilha**: só pelo botão de ícone na faixa de ações das abas
(`.cc-tab-actions`, `ClaudePage.tsx`: `<button className="cc-icon" title="Mapa de agentes" ...>`),
adicionado na rodada da seção 14. Esse botão continua existindo; o pill NOVO é o gatilho idêntico ao
real, que vive no rodapé do compositor.

**O real, função por função (v2.1.283)**:
- `pB0({session,onOpen})` monta o pill lendo `session.agentMapAgents` e `vS(permissionRequests)`;
  renderizado no rodapé do compositor imediatamente ANTES do bloco do model picker
  (`...F(gB0,{session:$}), <remote control>, w0&&F(pB0,{session:$,onOpen:q}), j!==2&&F(XP1,...)`).
- `vJ5({count,dot,onOpen})` é o botão em si: `className={`${N7.modelPill} ${Fv.agentsPill}`}`
  (literalmente a classe do model pill + a própria), `"data-agents-dot":J`, `title=CJ5(dot)`,
  `aria-label=`${$P1(count)} · ${CJ5(dot)}``, filhos: ícone `U11` (svg 20x20, fill currentColor),
  dot `rY` (`span` com `data-status-dot` + classe por estado) e o rótulo `$P1(count)`.
- `pS(agents)`: contagem = só agentes com `status==="working"` (`r41`).
- `oE1(agents, waitingIds)`: `"waiting"` se algum agente working está no Set de pedidos de permissão
  pendentes (`vS` = Set de `agentId` dos `permissionRequests`); senão `"running"` se algum working;
  senão `"failed"` se algum failed; senão `"idle"`.
- `$P1(n)`: `"${n} agent(s)"`. `CJ5(dot)`: "An agent is waiting for your permission · Click to open
  the agent map" / "Agents are working · ..." / "An agent failed · ..." / "Click to open the agent
  map".

**Portado no Orion**: `agentsPillDot`/`agentsPillCount`/`agentsPillCountLabel`/`agentsPillTitle` em
`mapper.ts` (puras, testadas em `tests/agentmapParity.test.ts`); botão em `Composer.tsx`
(`.cc-pill.cc-agents-pill`, `data-agents-dot`, mesmo aria-label composto), logo antes do model pill
— mesma vizinhança do real; ícone `AgentsPill` em `icons.tsx` com o **path literal** do `U11` real
(copiado byte a byte do bundle, não redesenhado). Textos em PT-BR (convenção do painel; a tabela
CJ5 foi traduzida, não inventada). O `onOpen` abre o MESMO painel `AgentMap` de sempre
(`setAgentMapOpen(true)` em `ClaudePage.tsx`).

**Adaptação documentada (permissão → agente)**: o real liga permissão↔agente por `agentId` no
próprio pedido; o pedido do Orion não tem `agentId`, mas tem o `toolUseID` real do SDK (repassado
pelo runner desde 28/09). `applyPendingToAgentTasks` (mapper.ts) faz a ligação equivalente: um
pedido pendente cujo `toolUseId` é uma tool call aninhada do subagente (ver item 2) — ou o próprio
`Task` — pinta agente e call de `waiting`. É o `vS`+`CS` real, pelo id que o Orion de fato tem.

**Suposição documentada (gate `w0`)**: a condição exata `w0` que liga o pill no real não foi
recuperável do bundle minificado (o nome `w0` colide com dezenas de escopos; nenhum grep isolou a
atribuição do componente do rodapé). Como `agentMapAgents` nasce vazio e `oE1` tem os estados
"failed"/"idle" (que só existem com agentes JÁ terminados visíveis), o comportamento coerente — e o
adotado — é: pill visível quando a sessão tem ≥1 subagente (qualquer status), nunca numa sessão sem
`Task` nenhum. Se alguém recuperar o `w0` real e for outra coisa (ex.: flag de config), ajustar é
uma linha em `Composer.tsx`.

## 2. Tool calls aninhadas por subagente (`innerCall*`)

**O que o stream do SDK entrega (investigado antes de construir)**: `SDKAssistantMessage`/
`SDKUserMessage` têm `parent_tool_use_id` (campo real do `sdk.d.ts`) — `null` no agente raiz, o
`tool_use.id` do `Task` pai quando a mensagem pertence ao transcript do SUBAGENTE. O runner do Orion
sempre persistiu a mensagem INTEIRA (`appendEvent(id, m.type, m)` em `server/claude/runner.ts`),
então o campo já chegava ao front por `fromRows`/SSE — **zero mudança de backend**.

**`mapper.ts`/`live.ts` já agrupavam por `parent_tool_use_id`? NÃO** — lido antes, confirmado: o
campo não aparecia em NENHUM arquivo de `web/src/`. Pior: `reduceSdkMessages` tratava mensagem de
subagente como mensagem comum, então o transcript inteiro do subagente (texto, thinking e tool
calls dele) **vazava misturado na timeline principal**, como se fosse do agente raiz. A extensão
real roteia essas mensagens só pro transcript do próprio agente. Corrigido na raiz:
- `reduceSdkMessages` pula `assistant`/`user` com `parent_tool_use_id` truthy (a timeline principal
  volta a ser só do agente raiz);
- `noteAgentTask` ganhou os dois ramos com parent: `tool_use` do subagente vira `AgentToolCall`
  (`{toolUseId,name,label,description,status}`, label/description via o `describeTool` já
  existente) em `AgentTask.toolCalls`; `tool_result` do subagente fecha a call casada
  (success/failure), nunca regride uma já fechada (mesma proteção de replay do fechamento de task).
  Parent desconhecido = ignora, mesma referência (nunca inventa task).

**Diferença de arquitetura, documentada**: o real NEM usa `parent_tool_use_id` pra isso — o host da
extensão tem um stream de progresso dedicado por tarefa (`handleTaskProgress`/
`handleTaskNotification` no bundle: eventos com `task_id`, `tool_use_id`, `usage.total_tokens`,
`recentTools`, `summary`). O Orion não tem esse canal; `parent_tool_use_id` nas mensagens já
persistidas entrega o equivalente funcional das tool calls (e a contagem ao vivo delas) sem canal
novo. O que ESSE caminho não entrega: `summary` (frase de progresso gerada) e tokens ao vivo POR
subagente antes do `tool_use_result` final — continuam vindo só no fechamento, quando o SDK manda.

**UI**: componente `InnerCallList` (AgentMap.tsx, exportado; Timeline.tsx importa) — espelho da
lista real (`div.innerCallList > div.innerCall` com `innerCallComplete`/`innerCallError` por fase,
`span.innerCallHeader` com o cabeçalho da tool e, enquanto roda, `F("span",{className:
oj.innerCallSpinner,children:"…"})` — o spinner real é o LITERAL "…", não um ícone animado; aqui
"…" com `cc-pulse`). Aparece em dois lugares, os dois do pedido ("mapa/timeline"): expandindo o
card de um subagente no Mapa de agentes (`AgentCard` agora dobrável, chevron no título) e
expandindo a linha `TaskAgent` da timeline (linha `TOOLS` acima de IN/OUT — `Timeline` recebeu a
prop `agentTasks` de `ClaudePage`). Estados: rodando (spinner), `waiting` (permissão pendente pra
call, via `applyPendingToAgentTasks`), completa (`is-complete`, esmaecida), erro (`is-error`,
vermelha) — o `cG0` real (`phase start/executing sem resultado → spinner`) mapeado pro ciclo de
`ToolStatus` que o Orion já tem.

## 3. Linhas dobráveis com overflow (`focus-subagent-row`)

**O real**: `MA1({tasks})` renderiza, enquanto subagentes rodam, `h95` por agente visível
(`data-testid="focus-subagent-row"`: `label` = `sU0` — `description` ou `"description: {summary ??
recentTools.at(-1)}"` — e `span` = `$V0` — `[tokens, tools,] decorrido`, formato `XM`: `"57s"`,
`"2m 5s"`) e, quando há overflow, `y95` (`data-testid="focus-subagent-overflow-row"`: `tU0` =
`"+N more agent(s)"` + `eU0` = `"[tokens · tools ·] {duração somada} combined"`). Split real
`oU0`/`HA1=3`: até 4 linhas todas visíveis; 5+ → 3 visíveis + resto no overflow. A linha de
recolher real é `focus-fold-end-row`: `label` "Collapse", `aria-label` "Collapse {PA1(...)}",
`role="button"`, Enter/Espaço.

**Portado**: `AGENT_ROWS_VISIBLE`/`splitAgentRows`/`agentRowLabel`/`agentRowMeta`/
`agentOverflowLabel`/`agentOverflowMeta` em mapper.ts (portas 1:1, testadas); componente
`SubagentRows` em Timeline.tsx com os MESMOS testids reais (`focus-subagent-row`,
`focus-subagent-overflow-row`, `focus-fold-end-row` — identificadores de máquina, mantidos
idênticos), renderizado no fim da timeline enquanto existe subagente ativo (running/waiting — a
mesma seleção do fold real, que só lista agentes trabalhando; concluídos já têm a linha `TaskAgent`
normal). Clicar no overflow expande todas; expandido, a última linha recolhe de volta (contagem dos
que se escondem no `aria-label`). Tique de 1s pro decorrido, só enquanto o componente está montado.
Rótulos visíveis em PT-BR ("+N outros agentes", "Recolher", "combinados", "ferramentas") — decisão
de convenção do painel (contexto da trilha: textos em PT-BR); os testids/atributos ficam iguais ao
real. `sU0` usa o `summary`/`recentTools` do canal de progresso dedicado que o Orion não tem (ver
item 2) — aqui o "último tool" vem da última call aninhada observada, dado real do stream.

## 4. Teleport (item 8 da seção 13) — VEREDITO, nada construído

**O que a real faz** (lido no bundle, estados na classe da store de sessões):
- `pendingRemoteTeleport`: guarda o id de uma sessão REMOTA (de outra máquina/host, via Remote
  Control) que deve ser "teleportada" pra este painel; um efeito espera `remoteSessions` carregar,
  acha a sessão e dispara a ativação (com diálogo de branch — `teleport_branch_dialog_shown` — e
  `finalizeTeleport`); se as remotas carregaram e o id não existe, desiste e limpa.
- `unresolvedBootRemoteId`: o painel abriu já apontando pra uma sessão remota que ainda não virou
  cópia local — usado por `tabOpenElsewhere`/`focusTabShowing` pra não abrir o mesmo host duas
  vezes, e limpo quando resolve; `notifyPanelTeleportResolved/Abandoned` avisam o host do desfecho.
- `teleportError`: banner dispensável de erro (`teleportErrorBanner*` no CSS) quando
  `teleportSession(...)` falha; `teleportingSession` segura a sessão em trânsito.
- Mecânica de fundo: a sessão VIVE no host de origem; teleportar = copiar transcript/estado pro
  host local (`teleportSession` na conexão, com `openExistingLocalSession`/`reusedExisting` quando
  já existe cópia).

**O que o Orion já tem** (`GET /api/claude/ui-state/stream`, commit 631aee9 + o que está em
`ClaudePage.tsx`): as sessões moram TODAS no servidor (c3, Postgres + runner) — nenhum navegador é
"dono" de sessão nenhuma. Qualquer guia/dispositivo abre qualquer sessão por id; o stream de
ui-state sincroniza a lista de abas abertas + ativa entre guias/dispositivos em tempo real (com
supressão de eco por `CLIENT_ID`), e o SSE por sessão faz replay do histórico a cada (re)conexão.

**Veredito: COBERTO POR ARQUITETURA no cenário que existe hoje; gap real só num cenário que o
Orion não tem.** O problema que o teleport real resolve — "continuar ESTA sessão em outra
janela/dispositivo" — no Orion não precisa de cópia nenhuma: abrir a sessão já É o teleport, porque
o estado nunca esteve no cliente. Os três sinais reais não têm o que espelhar: não há
`pendingRemoteTeleport` (não existe "esperar a lista remota carregar pra achar a sessão" — a lista
é uma só, do servidor), não há `unresolvedBootRemoteId` (não existe "cópia local por resolver"),
não há `teleportError` (não existe operação de cópia pra falhar; erros de conexão já têm o banner
de reconexão do SSE). **Parcialmente coberto / gap real apenas SE** o Orion um dia federar mais de
um host de execução (ex.: sessões rodando na c1 E na c3 com painéis distintos): aí migrar uma
sessão ENTRE servidores exigiria exatamente o que a real tem — cópia de transcript/estado, diálogo
de branch, banner de erro dedicado. Hoje isso não existe e não está pedido; nenhuma UI foi
construída, conforme a instrução da trilha.

## Arquivos tocados / verificação

- `web/src/claude/types.ts` — `parent_tool_use_id` nos SdkMessage, `AgentToolCall`,
  `AgentTask.toolCalls`.
- `web/src/claude/mapper.ts` — skip de mensagens de subagente em `reduceSdkMessages`; ramos com
  parent em `noteAgentTask`; `applyPendingToAgentTasks`, `agentsPill*`, `splitAgentRows`,
  `agentRow*`, `agentOverflow*`.
- `web/src/claude/AgentMap.tsx` — `InnerCallList` (compartilhado), `AgentCard` dobrável.
- `web/src/claude/Timeline.tsx` — prop `agentTasks`, `TOOLS` aninhado no `TaskAgent`,
  `SubagentRows` (linhas dobráveis).
- `web/src/claude/Composer.tsx` — agents pill (props `agents`/`onAgents`).
- `web/src/claude/ClaudePage.tsx` — `applyPendingToAgentTasks` na lista, props novas pra
  Timeline/Composer.
- `web/src/claude/icons.tsx` — `AgentsPill` (path literal do `U11` real).
- `web/src/claude/claude.css` — `.cc-agents-pill/.cc-agents-dot`, `.cc-innercall*`,
  `.cc-subagent-row*` (tokens `--cc-*` já existentes, tema claro/escuro herdado).
- `tests/agentmapParity.test.ts` — vitest do agrupamento/split/pill (arquivo próprio, de propósito:
  `tests/mapper.test.ts` é alvo de conflito entre trilhas paralelas).

Verificação nesta worktree: `npm run typecheck` e `npm test` verdes (nenhum teste existente
alterado). Lacuna de verificação herdada da seção 14: sem sessão real com subagentes rodando neste
ambiente, o fluxo foi validado por testes puros + leitura do bundle real, não ao vivo em produção.
