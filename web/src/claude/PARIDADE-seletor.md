# Trilha par/seletor — barra de título fora, degrau Ultracode, fast mode e "% do uso" por modelo (29/09/2026)

Quatro peças visuais na casca da aba Claude, pedidas ao vivo pelo Bayerl em 29/09/2026 ("remove essa
barra de titulo entre as abas e o chat... e vamos rodar a solucao que deixa a ui do chat e a
experiencia 100% identicas do plugin do antigravity"). Referência canônica lida ANTES de cada peça:
`/srv/orion-reference-2.1.283/webview/index.{js,css}` (a mesma extensão v2.1.283 do inventário da
seção 13 do PARIDADE.md; os itens 1, 6 e 14 daquela seção são exatamente estas peças). Documento
separado do PARIDADE.md de propósito: várias trilhas paralelas no mesmo dia, o integrador anexa.

## 1. Barra de título entre as abas e o chat: REMOVIDA

A extensão real não tem NENHUMA faixa entre a fileira de abas e a área de mensagens (basta olhar o
JSX do container: tabs → banners condicionais → `chatContainer`). A barra do Orion
(`.cc-head`: "título · projeto · criador · US$ X · N turnos · dot status") era invenção nossa.

Removida em `ClaudePage.tsx` (o bloco `<div className="cc-head">`) e `claude.css` (as duas regras
`.cc-head` + `.cc-head-meta`). **Nenhuma informação ficou sem destino**:

| O que a barra mostrava | Destino |
|---|---|
| Título da sessão | já é o texto da própria aba e o título na lateral; segue como 1º item do tooltip da aba |
| Projeto · criador | **tooltip da aba** (`title="título · projeto · criador"`, novo) e o projeto também na barra de status de baixo (`.cc-status`, já existia) |
| US$ X · N turnos | linha "Concluído · US$ … · N turnos" de cada result na timeline (já existia) e agregado na seção Conta e Uso da lateral (já existia) |
| Dot + texto de status | **dot na própria aba** (`.cc-tab-dot`, novo — mesma escala de cores `.cc-dot is-*` da lateral) e o dot da lateral (já existia) |

## 2. Degrau "Ultracode" no seletor de esforço

Evidência na referência (tudo string literal, `index.js`):

- `IV0="Ultracode"`, ``fe=`${IV0} - xhigh + workflows` `` — o rótulo completo é exatamente
  **"Ultracode - xhigh + workflows"** (hífen simples, sem travessão).
- `kV0(supportsEffort, level, ultracodeSelected)`: com Ultracode selecionado o pill mostra só `IV0`
  ("Ultracode"), senão o rótulo do nível.
- `enableUltracode()`: `this.effortLevel.value="xhigh"` + `applySettings({effortLevel:"xhigh"})` +
  `applySettings({[pf1]:!0},{flagsOnly:!0})` — ou seja, **xhigh de verdade + uma flag** que liga o
  motor de workflows da extensão.
- Slider (componente `ye`, classes `toggle/fill/fillUltracode/notch/notchUltracode/thumb_P1HaRA`):
  trilho 76×18px, thumb 14px, notches de 4px; com `showUltracode` o total de degraus é
  `levels.length + 1` e o ÚLTIMO índice chama `onSelectUltracode` (clique ou arrasto com pointer
  capture); o último notch usa sempre `notchUltracode` (cor própria) e o fill vira `fillUltracode`
  quando Ultracode está selecionado. Cor: `--app-ultracode-color → --app-chart-5 →
  var(--vscode-charts-purple,#a855f7)`.
- No popup real (componente `eB0`), a linha `effortRow` mostra "Effort (rótulo)" + o slider; o texto
  inline é `q?fe:CF(Y)` — a string completa `fe` aparece ali quando Ultracode está ligado.

O que foi implementado no Orion:

- **Composer.tsx**: componente `EffortSlider` (cópia do `ye`: mesmos cálculos `calc()` com
  `--thumb-size/--thumb-inset`, clique+arrasto por pointer capture, último degrau = Ultracode) numa
  linha `.cc-effort-row` no topo do menu de esforço, com o texto inline "(Ultracode - xhigh +
  workflows)" quando selecionado; os itens de menu por nível que o Orion já tinha continuam, com um
  item novo ACIMA de "Máximo" na intensidade (último da lista), rótulo exato `Ultracode - xhigh +
  workflows`; o pill mostra "Ultracode" (mesmo `kV0`). CSS em `claude.css`
  (`.cc-effort-toggle/fill/notch/thumb`, token novo `--cc-ultracode: #a855f7`).
- **api.ts**: tipo `EffortChoice = Effort | 'ultracode'`, `ULTRACODE_LABEL`/`ULTRACODE_MENU_LABEL`
  (strings da referência), `effortPillLabel`, `matchEffort` agora restaura `'ultracode'` persistido.
- **server/claude/ultracode.ts** (novo): `resolveUltracode('ultracode') → { effort: 'xhigh',
  ultracode: true }` + `withUltracodeAppend` que acrescenta `ULTRACODE_APPEND` (instrução curta de
  orquestração agressiva de subagentes, em pt-BR) ao systemAppend do turno.
- **server/routes/claude.ts**: `EFFORTS` aceita `'ultracode'`; o valor de fio é persistido como está
  em `claude_sessions.effort` (o seletor restaura a escolha ao reabrir — mesma migração
  009_claude_effort de antes, coluna texto, sem migração nova), e SEMPRE traduzido por
  `resolveUltracode` antes de chegar ao SDK (create, messages/startFor, retomada pós-restart e a
  rota de troca ao vivo).

**Simplificações deliberadas (documentadas, não gaps escondidos):**

- O motor de workflows da extensão (a flag `pf1` que o `enableUltracode` real liga) **não existe no
  Agent SDK**. Semântica no Orion: esforço `xhigh` real + `ULTRACODE_APPEND` no systemAppend do
  turno (texto em `server/claude/ultracode.ts`). É a mesma promessa do rótulo ("xhigh + workflows"),
  cumprida com o que o SDK oferece.
- Troca pra Ultracode com turno EM ANDAMENTO: o esforço vira xhigh na hora
  (`Query.applyFlagSettings({effortLevel})`, como qualquer nível), mas a instrução de orquestração só
  entra no PRÓXIMO turno — o system prompt de um turno já rodando não pode ser trocado no meio.
- `effortNotice` do nível max (`EV0` real, "May use excessive tokens…") não foi portado: na
  referência ele é gated por experimento (`tengu_proud_clover`) e fora do pedido desta trilha.
- O seletor do Orion mantém os itens de menu por nível (padrão que já tinha) ALÉM do slider; a
  extensão real só tem o slider + a linha que cicla. Decisão de continuidade, não de fidelidade: o
  menu já era o jeito do Orion e os dois caminhos selecionam os mesmos valores.

## 3. Indicador de fast mode com cooldown (sparkLegend)

Evidência na referência:

- Classes `sparkLegend/sparkIcon/sparkCooldown_cKsPxg`; CSS real: `position:absolute; display:none;
  top:-7px; right:12px`, `::before` de 3px com `--app-root-background` cortando a borda, e
  `.inputContainer:focus-within .sparkLegend{display:flex}`. `sparkIcon` na cor
  `--app-warning-accent` (#e5a54b); `.sparkCooldown .sparkIcon` acinzentado.
- JSX real: `<legend className={sparkLegend + (fastModeState==="cooldown" ? sparkCooldown : "")}
  title={cZ5(effortLevel, fastModeState)}>` com a fileira de pontinhos do esforço (`fV0`: svg 30×12,
  5 círculos r=2.5, opacidade 0.15 nos vazios) + o raio quando fast mode ativo; o fieldset ganha
  `data-spark={fastModeState}` quando != "off".
- `cZ5`: tooltip "Effort: X" + "Fast mode enabled" (on) / "Fast mode cooling down" (cooldown),
  juntados com " · ".
- Fonte do dado: `fastModeState` alimentado por `fast_mode_state` do system/init e do result
  (`FastModeState = 'off' | 'cooldown' | 'on'` no sdk.d.ts — campo real do SDK 0.3.x).

Implementado no Orion (pt-BR): `live.ts` ganhou `fastMode` no `LiveState` (+ `fastModeFrom`, leitura
defensiva do campo em qualquer mensagem que passe por `pushMessage` — cobre histórico e ao vivo);
`Composer.tsx` renderiza `.cc-spark-legend` (pontinhos `EffortDots` + raio `Bolt` reutilizado de
icons.tsx) com tooltip `sparkTitle` ("Esforço: X · Modo rápido ativado/esfriando") e `data-spark` no
`.cc-composer`; CSS espelhado em `claude.css` (aparece só com o composer em foco, igual à real).

**Estado real hoje**: verificado no `sdk.d.ts` que o campo existe nos tipos, mas os results das
sessões do Orion não têm trazido `fast_mode_state` (mesma classe de ausência do `rate_limits`
documentada na seção 3 do PARIDADE.md). Com o campo ausente o estado fica `'off'` e **o raio nunca
aparece** — o que aparece com o composer em foco é só a fileira de pontinhos do esforço (que na real
também aparece sempre que o modelo suporta esforço). Paridade estrutural pronta: quando o SDK mandar
o campo, o indicador (e o cooldown acinzentado) ligam sozinhos, sem mexer em código.

## 4. "% do uso" por modelo na Conta e Uso

Evidência na referência: componente `J11({title, items, label})` — header com o título do grupo +
`<span className={attributionPct}>"% of usage"</span>`, linhas `attributionRow` (nome com ellipsis +
`Math.round(pct)%`), ordenação desc por pct (`iW0`), truncamento com contador ("+N mais" no
levantamento da seção 13; o bundle atual usa reticências + "N more" com corte em 8). Classes
`attributionGroup/HeaderRow/Title/List/Row/Name/Pct/More_QET5Ow`. Na extensão os grupos são
Skills/Subagents/Plugins/MCP servers, alimentados por telemetria de atribuição do servidor deles
(campo que o Orion não recebe).

Implementado no Orion com o dado que JÁ existe: custo por modelo.

- **server/routes/claude.ts** (`GET /api/claude/usage`): agrega `SUM(cost_usd)` por
  `claude_sessions.model` na janela de 7 dias → campo novo `by_model` na resposta.
- **mapper.ts**: `computeModelAttribution` (pura, testada) — agrupa ids de modelo pelo rótulo do
  seletor (`claude-sonnet-* → "Sonnet"` via `matchModelAlias`/`MODEL_LABEL`; id desconhecido fica
  cru; `model` null é pulado), calcula % do total, `Math.round`, ordena desc. Lista vazia sem custo
  (nada de divisão por zero).
- **Sidebar.tsx**: bloco novo na seção CONTA E USO, abaixo das barras — header "Por modelo (7
  dias)" + "% do uso", até **4 linhas + "+N mais"** (corte pedido nesta trilha; o bundle real corta
  em 8 com "… N more" — divergência deliberada e registrada), classes `.cc-attr-*` espelhando o CSS
  real (opacidades, `tabular-nums`, ellipsis).

**Simplificações**: (a) a fonte é custo, não a telemetria de atribuição real (o Orion não a recebe —
mesma limitação de escopo já documentada pro `rate_limits` na seção 3 do PARIDADE.md); (b) strings
em pt-BR ("% do uso", "+N mais"), seguindo o padrão do painel inteiro (como "Resets" → "Reinicia");
a string literal da referência é "% of usage".

## Testes e verificação

- `tests/seletor.test.ts` (novo, pra não conflitar com as outras trilhas nos arquivos de teste
  compartilhados): `resolveUltracode` (mapeamento ultracode→xhigh+flag, níveis reais, lixo),
  `withUltracodeAppend`, `matchEffort('ultracode')`, rótulos exatos (`Ultracode`,
  `Ultracode - xhigh + workflows`), `computeModelAttribution` (agrupamento por alias, %, ordenação,
  null/lixo/zero) e `fastModeFrom`/`fastMode` no `applyLive`.
- `npm run typecheck` e `npm test` verdes na worktree `/home/danilo/wt-par-seletor` antes do commit.
- Sem build de produção e sem restart de serviço nesta trilha (regra do orquestrador).
