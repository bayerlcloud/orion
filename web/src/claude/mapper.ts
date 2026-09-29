import type { AgentTask, AgentTaskUsage, ConvEvent, SdkContentBlock, SdkMessage, SessionGroupInfo, SessionSummary, ToolStatus } from './types';

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Como a ferramenta aparece na linha de resumo: nome em negrito + descrição secundária. */
export function describeTool(name: string, input: unknown): { label: string; description?: string; inputText?: string } {
  const i = (input ?? {}) as Rec;
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcp) {
    const server = mcp[1].charAt(0).toUpperCase() + mcp[1].slice(1);
    return { label: `${server} [${mcp[2]}]`, inputText: JSON.stringify(input ?? {}, null, 2) };
  }
  switch (name) {
    case 'Bash': return { label: 'Bash', description: str(i.description) ?? str(i.command), inputText: str(i.command) };
    case 'Read': return { label: 'Read', description: str(i.file_path) };
    case 'Write': return { label: 'Write', description: str(i.file_path), inputText: str(i.content) };
    case 'Edit': return { label: 'Edit', description: str(i.file_path), inputText: str(i.new_string) };
    case 'Grep': return { label: 'Grep', description: [str(i.pattern), str(i.path)].filter(Boolean).join(' em ') };
    case 'Glob': return { label: 'Glob', description: str(i.pattern) };
    case 'WebFetch': return { label: 'Web Fetch', description: str(i.url) };
    case 'WebSearch': return { label: 'Web Search', description: str(i.query) };
    case 'Agent': return { label: 'Agent', description: str(i.description) };
    case 'Task': {
      // Nome real da tool no SDK é "Task" (confirmado em webview/index.js v2.1.282: `var RE="Task"`;
      // schema real `AgentInput` em @anthropic-ai/claude-agent-sdk/sdk-tools.d.ts: description/prompt/
      // subagent_type). A extensão mapeia esse nome internamente pro renderer "Agent"
      // (`$==="Task"?"Agent":$`) e mostra "Agent: {description}" no cabeçalho (`class jD1{name="Agent"}`),
      // com o prompt como corpo IN e sem OUT — aqui só o rótulo/descrição/inputText; a renderização
      // dedicada (com status rodando/concluído) fica em Timeline.tsx.
      return { label: 'Agent', description: str(i.description), inputText: str(i.prompt) };
    }
    case 'TodoWrite': {
      // Cabeçalho real é sempre o texto fixo "Update Todos" (`class wD1{name=Vw;header(){...}}`,
      // webview/index.js v2.1.282) — nunca dinâmico. Preview em PT-BR (mesma convenção de
      // AskUserQuestion → "Pergunta"); a lista em si é renderizada à parte em Timeline.tsx.
      const todos = parseTodos(input);
      const n = todos.length;
      return { label: 'Lista de tarefas', description: n ? `${n} ${n === 1 ? 'item' : 'itens'}` : undefined };
    }
    case 'AskUserQuestion': {
      // Resumo legível das perguntas (nunca o JSON cru): usado como fallback de inputText quando não
      // há resposta formatada ainda — evita o bubble "Você respondeu: {...json...}" se algo além do
      // fluxo normal cair nesse caminho (ver toConvEvents, que prioriza a resposta de fato).
      const qs = Array.isArray(i.questions) ? (i.questions as { question?: string; header?: string }[]) : [];
      const summary = qs.map(q => q.header || q.question).filter(Boolean).join(' · ');
      return { label: 'Pergunta', description: 'o Claude quer que você escolha', inputText: summary || undefined };
    }
    default: return { label: name, inputText: JSON.stringify(input ?? {}, null, 2) };
  }
}

function resultText(content: SdkContentBlock & { type: 'tool_result' }): string {
  if (typeof content.content === 'string') return content.content;
  return (content.content ?? []).map(b => b.text).join('\n');
}

/** Reduz a lista de mensagens do SDK ao modelo de eventos da tela. Pura e idempotente. */
export function reduceSdkMessages(messages: SdkMessage[]): ConvEvent[] {
  const out: ConvEvent[] = [];
  const toolIndex = new Map<string, number>();
  let sawInit = false;
  let n = 0;
  const nid = () => `e${++n}`;

  for (const m of messages) {
    if (m.type === 'system') {
      if (m.subtype === 'init' && !sawInit) {
        sawInit = true;
        const parts = ['Sessão iniciada'];
        if (m.model) parts.push(`modelo ${m.model}`);
        if (m.cwd) parts.push(`pasta ${m.cwd}`);
        out.push({ id: nid(), kind: 'system', text: parts.join(' · ') });
      }
      continue;
    }
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ id: nid(), kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking.trim()) out.push({ id: nid(), kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') {
          const d = describeTool(b.name, b.input);
          toolIndex.set(b.id, out.length);
          out.push({ id: nid(), kind: 'tool', toolUseId: b.id, name: b.name, label: d.label, description: d.description, input: b.input, inputText: d.inputText, status: 'running' });
        }
      }
      continue;
    }
    if (m.type === 'user') {
      const c = m.message.content;
      const attachments = m.message.attachments;
      if (typeof c === 'string') { if (c.trim() || attachments?.length) out.push({ id: nid(), kind: 'user', text: c, attachments }); continue; }
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) out.push({ id: nid(), kind: 'user', text: b.text, attachments });
        else if (b.type === 'tool_result') {
          const idx = toolIndex.get(b.tool_use_id);
          if (idx === undefined) continue;
          const ev = out[idx];
          if (ev.kind !== 'tool') continue;
          const status: ToolStatus = b.is_error ? 'failure' : 'success';
          out[idx] = { ...ev, output: resultText(b), isError: !!b.is_error, status };
        }
      }
      continue;
    }
    if (m.type === 'result') {
      const tok = sumModelUsage(m.modelUsage) ?? (m.usage ? { input: m.usage.input_tokens ?? 0, output: m.usage.output_tokens ?? 0 } : undefined);
      out.push({ id: nid(), kind: 'result', ok: !m.is_error && m.subtype === 'success', costUsd: m.total_cost_usd, durationMs: m.duration_ms, turns: m.num_turns, inputTokens: tok?.input, outputTokens: tok?.output, error: m.is_error ? (m.result ?? m.subtype) : undefined });
      continue;
    }
    // stream_event: parciais; a tela ao vivo trata separadamente
  }
  return out;
}

/** Estimativa grosseira de tokens: ~4 caracteres por token (como a extensão exibe no thinking). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Soma tokens de entrada/saída de todos os modelos usados no turno (campo modelUsage do result). */
export function sumModelUsage(mu?: Record<string, { inputTokens?: number; outputTokens?: number }>): { input: number; output: number } | undefined {
  if (!mu) return undefined;
  const entries = Object.values(mu);
  if (!entries.length) return undefined;
  let input = 0, output = 0;
  for (const e of entries) { input += e.inputTokens ?? 0; output += e.outputTokens ?? 0; }
  return { input, output };
}

export function formatTokens(n?: number): string {
  if (n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };
/** Diff unificado simples por linhas (LCS). Usado no bloco da ferramenta Edit. */
export function unifiedDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n'), b = newText.split('\n');
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

export type CharSpan = { type: 'ctx' | 'add' | 'del'; text: string };

function mergeCharSpans(spans: CharSpan[]): CharSpan[] {
  const out: CharSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Diff de caracteres entre duas linhas (LCS por code point — `Array.from` em vez de `split('')` pra
 * não quebrar par substituto/emoji no meio). Espelha a granularidade real da extensão: ela roda o
 * editor de diff completo do Monaco por baixo (achado em webview/index.js v2.1.282, junto de
 * `diff-review-row`/`line-insert`/`line-delete` — ou seja, é o widget inteiro, não um highlight
 * caseiro), e as decorações `char-insert`/`char-delete` marcam INTERVALOS DE CARACTERES dentro da
 * linha (confirmado no CSS: `.char-insert{background-color:var(--vscode-diffEditor-insertedTextBackground)}`,
 * `.char-delete,.inline-deleted-text{background-color:...removedTextBackground}`,
 * `.inline-deleted-text{text-decoration:line-through}` na view inline/unificada — a mesma forma que
 * a nossa `EditDiff` já usa). Reimplementamos só a granularidade (caractere, via LCS), não o widget
 * inteiro do Monaco (gutters, minimapa, linhas de revisão de acessibilidade) — fora de escopo, ver
 * PARIDADE.md. Devolve os trechos da linha ANTIGA (ctx/del) e da NOVA (ctx/add) separadamente, pra
 * cada uma ser renderizada na sua própria linha do diff unificado que já temos.
 */
export function charDiff(oldLine: string, newLine: string): { oldParts: CharSpan[]; newParts: CharSpan[] } {
  const a = Array.from(oldLine), b = Array.from(newLine);
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const oldRaw: CharSpan[] = [], newRaw: CharSpan[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { oldRaw.push({ type: 'ctx', text: a[i] }); newRaw.push({ type: 'ctx', text: b[j] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { oldRaw.push({ type: 'del', text: a[i] }); i++; }
    else { newRaw.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) oldRaw.push({ type: 'del', text: a[i++] });
  while (j < m) newRaw.push({ type: 'add', text: b[j++] });
  return { oldParts: mergeCharSpans(oldRaw), newParts: mergeCharSpans(newRaw) };
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Decide se vale a pena destacar caracteres num par de linhas del/add — ou seja, se as duas são "a
 * mesma linha, editada" e não duas linhas diferentes que calharam de ficar vizinhas no diff. Usa
 * prefixo+sufixo comum (não a contagem de contexto do LCS de `charDiff`): o LCS por caractere sozinho
 * super-estima semelhança entre linhas sem relação nenhuma, porque caracteres soltos (espaço, letras
 * comuns) casam de qualquer jeito em qualquer posição; prefixo/sufixo comum é o sinal de que existe
 * de fato uma região contígua igual, que é o padrão de uma edição real de código. Limiar: pelo menos
 * 30% da linha mais longa tem que ser prefixo/sufixo compartilhado. Linhas vazias (add/del puro, não
 * uma edição) ou muito longas (custo do LCS O(n·m)) ficam de fora.
 */
export function charDiffIfSimilar(oldLine: string, newLine: string): { oldParts: CharSpan[]; newParts: CharSpan[] } | undefined {
  if (!oldLine || !newLine) return undefined;
  const maxLen = Math.max(oldLine.length, newLine.length);
  if (maxLen === 0 || maxLen > 500) return undefined;
  const prefix = commonPrefixLen(oldLine, newLine);
  const suffix = Math.min(commonSuffixLen(oldLine, newLine), maxLen - prefix);
  if ((prefix + suffix) / maxLen < 0.3) return undefined;
  return charDiff(oldLine, newLine);
}

export type DiffLineWithParts = DiffLine & { parts?: CharSpan[] };

/**
 * Anota o diff de linha (`unifiedDiff`) com destaque de caracteres nos pares del/add que são, de
 * fato, a mesma linha reescrita (ver `charDiffIfSimilar`) — camada por cima, sem mudar `unifiedDiff`
 * (mantém os testes de linha existentes intactos, igual à extensão real, que roda diff de linha do
 * Monaco + innerChanges de caractere só quando as duas linhas são uma edição da mesma linha). Pareia
 * cada corrida contígua de del com a corrida de add que vem logo depois, 1 a 1 na ordem (sobra de um
 * lado fica sem parts — era add/del puro mesmo, não uma edição). Pura: devolve uma lista nova, não
 * muda `lines`.
 */
export function annotateCharDiffs(lines: DiffLine[]): DiffLineWithParts[] {
  const out: DiffLineWithParts[] = lines.map(l => ({ ...l }));
  let i = 0;
  while (i < out.length) {
    if (out[i].type !== 'del') { i++; continue; }
    let delEnd = i;
    while (delEnd < out.length && out[delEnd].type === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < out.length && out[addEnd].type === 'add') addEnd++;
    const pairCount = Math.min(delEnd - i, addEnd - delEnd);
    for (let k = 0; k < pairCount; k++) {
      const delLine = out[i + k], addLine = out[delEnd + k];
      const d = charDiffIfSimilar(delLine.text, addLine.text);
      if (d) { delLine.parts = d.oldParts; addLine.parts = d.newParts; }
    }
    i = addEnd;
  }
  return out;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoItem = { content: string; status: TodoStatus };

/**
 * Lê `input.todos` de um TodoWrite de forma defensiva (nunca lança). Schema real: `TodoWriteInput` em
 * `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` — `{ todos: { content: string; status: "pending" |
 * "in_progress" | "completed"; activeForm: string }[] }`. A extensão real só usa `content` e `status`
 * na tela (função `gG0` + checkbox `J65` em webview/index.js v2.1.282): `activeForm` existe no schema
 * mas não aparece na UI, então não carregamos ele adiante.
 */
export function parseTodos(input: unknown): TodoItem[] {
  const i = (input ?? {}) as Rec;
  if (!Array.isArray(i.todos)) return [];
  return i.todos.map((t): TodoItem => {
    const r = (t ?? {}) as Rec;
    const status: TodoStatus = r.status === 'in_progress' || r.status === 'completed' ? r.status : 'pending';
    return { content: typeof r.content === 'string' ? r.content : '', status };
  });
}

/**
 * Rótulo de status de um Task/Agent (subagente) na linha do tempo. A extensão real não expõe esse
 * texto exato (ela tem telemetria ao vivo — tempo decorrido, tokens, contagem de tool calls do
 * subagente — funções `iU0`/`lU0` no webview; exigiria um stream de progresso por tarefa que o Orion
 * não tem hoje); aqui é o texto de progresso mínimo a partir do `ToolStatus` que já temos.
 * `'waiting'` (ver `applyPendingToolWaitStatus`) precisa do próprio caso — sem ele caía no `else`
 * final e um Task ainda aguardando aprovação aparecia rotulado "Concluído", o oposto do que é
 * verdade (bug que essa correção evita reintroduzir, achado na mesma investigação de 28/09/2026 do
 * "padrão de mensagens diferente do plugin" — ver PARIDADE.md).
 */
export function taskStatusLabel(status: ToolStatus): string {
  if (status === 'running') return 'Executando…';
  if (status === 'waiting') return 'Aguardando permissão…';
  if (status === 'failure') return 'Falhou';
  return 'Concluído';
}

/**
 * Rótulo amigável de um turno interrompido manualmente (botão Parar) — espelha o mapeamento real da
 * extensão (tabela `Qw` no webview decompilado v2.1.282: `"[Request interrupted by user]"` →
 * `"Interrupted"`, `"[Request interrupted by user for tool use]"` → `"Tool interrupted"`), traduzido
 * pro PT-BR do resto da tela. A extensão real distingue as duas variantes lendo o texto literal que o
 * próprio CLI grava no bloco de conteúdo interrompido (a última coisa da mensagem, se for exatamente
 * um desses dois sentinelas). O runner do Orion não tem esse sentinela — a interrupção aqui é uma
 * exceção de AbortController capturada no catch de `run()`, não um bloco de texto do SDK — então
 * `duringTool` vem de um sinal equivalente que já temos: havia pedido de permissão de ferramenta
 * pendente no momento do `stop()` (ver `Runner.stop`/`stopHadPendingTool` em server/claude/runner.ts).
 */
export function interruptedLabel(duringTool: boolean): string {
  return duringTool ? 'Ferramenta interrompida' : 'Interrompido';
}

/**
 * Indicador "pensando" (ícone + palavra em inglês pulsando/trocando) — mostrado enquanto o turno
 * está rodando de verdade, sem pedido de permissão pendente (ver `toConvEvents` em `live.ts`, evento
 * sintético `kind:'busy'` quando `status==='running'`). Reportado ao vivo pelo Bayerl (28/09/2026):
 * "aquela animaçãozinha... quando está pensando que fica trocando a palavra com asterisco pulsando".
 *
 * Espelha o componente real `Re` (spinner) do webview decompilado v2.1.282
 * (`/srv/orion-reference/vscode-extension/extension/webview/index.js`), lido função por função antes
 * de implementar qualquer coisa — achados completos em PARIDADE.md:
 * - **Ícone**: 6 glifos, do menor ao maior — `var sU0=["·","✢","*","✶","✻","✽"]` (inclui o asterisco
 *   literal, exatamente o que o Bayerl descreveu) — ciclados num vai-e-volta de 12 passos
 *   (`oU0=[...sU0,...[...sU0].reverse()]`) via `setInterval(...,120)`: cresce do ponto até a maior
 *   estrela e volta, em loop contínuo — é isso que dá a impressão de "pulsar" de tamanho.
 * - **Palavra**: lista real `VA1`, 84 verbos/gerúndios inventados em inglês ("Pondering",
 *   "Marinating", "Percolating", "Discombobulating", "Flibbertigibbeting" etc. — extraída do bundle
 *   via `json.loads`, não digitada à mão, pra não errar nenhuma). Sorteada sem evitar repetição
 *   (mesma função real `_e($){return $[Math.floor(Math.random()*$.length)]}`) e trocada num
 *   cronograma fixo: 2s depois de montar, +3s (5s), +5s (10s), e a cada 5s dali em diante — tabela
 *   real `[2000,3000,5000]` (índice 3+ cai no default 5000) dentro do hook `rx`/`Cq0`.
 * - **Quando aparece**: a extensão condiciona a `visiblyBusy && !permissionRequests.value.length`
 *   (arquivo real, não suposição) — ou seja, ela NÃO some no instante em que o 1º token/tool_use
 *   chega; ela fica visível a sessão inteira do turno "rodando" (inclusive com texto/ferramentas já
 *   streamando acima dela na tela), e só some quando: (a) um pedido de permissão aparece (o card de
 *   permissão toma o lugar), ou (b) o turno termina. Isso bate 1:1 com o `status` que o Orion já
 *   mantém: `'waiting'` é exatamente "há permissão pendente" e `'running'` é exatamente "rodando sem
 *   pendência" — não precisou de nenhum estado novo no runner, só ler `status` em `toConvEvents`.
 * Mantidos em **inglês** de propósito (mesma convenção já usada pra "Agent"/"Task"/"Fable"/nomes de
 * modelo neste arquivo): é a personalidade "Claude-y" do produto, e boa parte da lista são
 * portmanteaus inventados sem equivalente natural em PT-BR.
 *
 * Diferente da extensão real — que roda um efeito de "decodificação" caractere a caractere a cada
 * troca de palavra (função `A85` no webview: cursor de bloco + flicker de 2-3 caracteres com
 * `requestAnimationFrame` a cada ~40ms até assentar no texto final) — a implementação aqui troca a
 * palavra com um fade CSS simples (`key={word}` + `@keyframes cc-fade-in` em `claude.css`, ver
 * `ThinkingIndicator` em `Timeline.tsx`): mesma ideia (a troca não é um corte seco), sem reimplementar
 * o motor de scramble inteiro — decisão de escopo documentada em PARIDADE.md, mesmo espírito da
 * decisão já tomada pro diff de caractere (granularidade replicada, não o motor completo).
 */
export const SPINNER_GLYPHS = ['·', '✢', '*', '✶', '✻', '✽'] as const;
/** Sequência vai-e-volta dos glifos (12 passos: cresce do menor ao maior e volta) — `oU0` real. */
export const SPINNER_GLYPH_SEQUENCE: readonly string[] = [...SPINNER_GLYPHS, ...[...SPINNER_GLYPHS].reverse()];
/** Intervalo entre passos do ciclo de glifo, em ms — confirmado no webview (`setInterval(...,120)`). */
export const SPINNER_GLYPH_INTERVAL_MS = 120;

/** Glifo do passo N do ciclo (aceita qualquer inteiro, inclusive negativo — módulo sempre positivo). */
export function spinnerGlyphAt(step: number): string {
  const n = SPINNER_GLYPH_SEQUENCE.length;
  return SPINNER_GLYPH_SEQUENCE[((step % n) + n) % n];
}

/**
 * Lista real de palavras (função `VA1` do webview decompilado v2.1.282) — 84 verbos/gerúndios em
 * inglês, extraída do bundle com `json.loads` (não digitada à mão). Ordem alfabética, igual ao real.
 */
export const SPINNER_WORDS: readonly string[] = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Booping', 'Brewing', 'Calculating', 'Cerebrating',
  'Channeling', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Combobulating', 'Concocting',
  'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deciphering', 'Deliberating',
  'Determining', 'Discombobulating', 'Doing', 'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling',
  'Flibbertigibbeting', 'Forging', 'Forming', 'Frolicking', 'Generating', 'Germinating', 'Hatching', 'Herding',
  'Honking', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Manifesting', 'Marinating', 'Meandering',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling', 'Percolating', 'Perusing', 'Philosophizing',
  'Pontificating', 'Pondering', 'Processing', 'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Scheming',
  'Schlepping', 'Shimmying', 'Simmering', 'Smooshing', 'Spelunking', 'Spinning', 'Stewing', 'Sussing',
  'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Unraveling', 'Vibing', 'Wandering',
  'Whirring', 'Wibbling', 'Working', 'Wrangling',
];

/**
 * Atraso (ms) antes da N-ésima troca de palavra (N a partir de 0, contando desde o momento em que o
 * indicador aparece) — espelha o agendamento real do hook `rx`/`Cq0` no componente `Re`: 2000ms antes
 * da 1ª troca, 3000ms antes da 2ª (5s desde o início), 5000ms antes da 3ª (10s), e 5000ms dali em
 * diante (a cada 5s) — tabela literal `let K=[2000,3000,5000];return B<K.length?K[B]:5000` no webview.
 */
export function spinnerWordDelayMs(callIndex: number): number {
  const table = [2000, 3000, 5000];
  return callIndex < table.length ? table[callIndex] : 5000;
}

/**
 * Sorteia uma palavra da lista (mesma função real `_e`: sem evitar repetição — pode repetir a mesma
 * palavra em trocas seguidas, de propósito, fiel ao original). `rand` injetável pra teste
 * determinístico (produção usa `Math.random`).
 */
export function pickSpinnerWord(words: readonly string[] = SPINNER_WORDS, rand: () => number = Math.random): string {
  if (words.length === 0) return '';
  return words[Math.floor(rand() * words.length)] ?? words[0];
}

export function formatCost(usd?: number): string {
  if (usd === undefined) return '—';
  return `US$ ${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

export type UsageRow = { cost_5h: string | number; cost_7d: string | number; cost_total: string | number };
export type UsageBar = { key: string; label: string; pct: number; sub?: string; resetText?: string };

/** Uma janela de limite real (rate_limits.* do result do SDK): % de uso 0-100 e reset ISO 8601; qualquer um pode vir null. */
export type RealRateLimitWindow = { utilization: number | null; resets_at: string | null } | null | undefined;
/** Entrada de rate_limits.model_scoped[]: mesma janela, mais o rótulo que o servidor manda (ex.: "Fable"). */
export type RealModelScopedWindow = { display_name: string; utilization: number | null; resets_at: string | null };
/**
 * Formato de `rate_limits` do result do SDK (`SDKResultMessage.rate_limits` em
 * `@anthropic-ai/claude-agent-sdk`), só vem preenchido quando `rate_limits_available` é true.
 * Na prática (28/09/2026) nunca vem — ver nota "% real do limite do plano" em PARIDADE.md.
 */
export type RealRateLimits = {
  five_hour?: RealRateLimitWindow;
  seven_day?: RealRateLimitWindow;
  seven_day_sonnet?: RealRateLimitWindow;
  model_scoped?: RealModelScopedWindow[];
} | null | undefined;
/** O que `/api/claude/usage` devolve quando encontrou um result recente com limites reais. */
export type RealUsage = { subscription_type: string | null; rate_limits: RealRateLimits } | null | undefined;

/**
 * Texto "em Xm/Xh/Xd" a partir de um reset ISO 8601 real — espelha a função de formatação de reset
 * da extensão real (`b$5` no webview decompilado v2.1.282: minutos se < 1h, horas se < 24h, senão
 * dias; "em breve" se já passou). Só deve ser chamada com um `resets_at` que a API de fato mandou —
 * nunca para inventar um reset para o proxy por custo.
 */
export function formatResetIn(resetsAtIso: string | null | undefined, now = Date.now()): string | undefined {
  if (!resetsAtIso) return undefined;
  const t = Date.parse(resetsAtIso);
  if (Number.isNaN(t)) return undefined;
  const diffMs = t - now;
  if (diffMs <= 0) return 'em breve';
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'em breve';
  if (min < 60) return `em ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `em ${h}h`;
  return `em ${Math.floor(h / 24)}d`;
}

/**
 * Barras de uso a partir dos limites REAIS da conta, quando `/api/claude/usage` encontrou um result
 * com `rate_limits_available: true`. Espelha a lista exata da extensão real (função `L$5` do webview
 * decompilado v2.1.282): "Sessão (5h)" ← five_hour, "Semanal (7 dias)" ← seven_day, "Semanal Sonnet"
 * ← seven_day_sonnet (só quando o plano é max/team/desconhecido — mesma condição da extensão), e uma
 * barra "Semanal {display_name}" por entrada de `model_scoped` (é daí que vem o rótulo "Fable" da
 * captura de tela). Janelas com `utilization` null são puladas, igual à extensão. Sem % nem reset
 * inventados — só o que a API mandou.
 */
export function computeRealUsageBars(real: RealRateLimits, subscriptionType: string | null | undefined, now = Date.now()): UsageBar[] {
  if (!real) return [];
  const sonnetEligible = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType == null;
  const entries: { key: string; label: string; window: RealRateLimitWindow }[] = [
    { key: '5h', label: 'Sessão (5h)', window: real.five_hour },
    { key: '7d', label: 'Semanal (7 dias)', window: real.seven_day },
    ...(sonnetEligible ? [{ key: '7d-sonnet', label: 'Semanal Sonnet', window: real.seven_day_sonnet }] : []),
    ...(real.model_scoped ?? []).map((m, i) => ({ key: `model-${i}`, label: `Semanal ${m.display_name}`, window: { utilization: m.utilization, resets_at: m.resets_at } as RealRateLimitWindow })),
  ];
  const bars: UsageBar[] = [];
  for (const e of entries) {
    if (!e.window || e.window.utilization === null || e.window.utilization === undefined) continue;
    const pct = Math.round(Math.min(100, Math.max(0, e.window.utilization)));
    bars.push({ key: e.key, label: e.label, pct, resetText: formatResetIn(e.window.resets_at, now) });
  }
  return bars;
}

/**
 * Barras de uso a partir do custo real por janela (proxy), usado quando a API não devolveu limites
 * reais — hoje é sempre o caso (ver `computeUsageBars`/PARIDADE.md). O plano não expõe o % real nem
 * o horário de reset nesse caso; a extensão real também nunca mostra valor em dólar aqui (só
 * "Resets in Xh" quando tem o dado, ou nada), então deixamos sem legenda em vez de mostrar um número
 * que a extensão de verdade não mostra.
 */
function computeProxyUsageBars(rows: UsageRow[]): UsageBar[] {
  const sum = (k: keyof UsageRow) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const c5 = sum('cost_5h'), c7 = sum('cost_7d'), ct = sum('cost_total');
  const bar = (key: string, label: string, cost: number, ref: number): UsageBar =>
    ({ key, label, pct: Math.round(Math.min(100, Math.max(0, ref > 0 ? (cost / ref) * 100 : 0))) });
  return [
    bar('5h', 'Sessão (5h)', c5, 5),
    bar('7d', 'Semanal (7 dias)', c7, 25),
    bar('total', 'Limite Fable', ct, 100),
  ];
}

/**
 * Monta a resposta de um AskUserQuestion pronta pra mandar como `message` da decisão 'answer':
 * texto legível pro Claude continuar, nunca o JSON cru das perguntas/opções. Uma pergunta só → só o
 * valor escolhido; várias perguntas → uma linha "header ou pergunta: valor" por pergunta (perguntas
 * sem escolha ficam de fora). `picks[i]` é a lista de labels marcados (multiSelect) ou um texto livre.
 */
export function formatAskAnswer(questions: { header?: string; question: string }[], picks: (string[] | string)[]): string {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    const p = picks[i];
    const val = Array.isArray(p) ? p.join(', ') : (p ?? '').trim();
    if (!val) return;
    lines.push(questions.length > 1 ? `${q.header || q.question}: ${val}` : val);
  });
  return lines.join('\n');
}

/**
 * Colapsa pedidos de permissão expirados consecutivos (2+) num único bubble com contagem.
 * O Runner guarda o estado de pedidos pendentes só em memória (o Map de `pending`, junto do timer
 * de 30 min e do resolve da promise); um restart do processo no meio de um pedido pendente órfa
 * esse pedido pra sempre (nem o usuário consegue responder, nem o timeout automático dispara — o
 * timer some com o processo). Numa janela de restarts seguidos (deploy), vários pedidos órfãos
 * assim se acumulam e, como a linha do tempo lista as permissões numa cauda (ver toConvEvents),
 * aparecem em sequência como uma fileira repetida de "Pedido expirado"/"Pergunta expirada".
 */
export function foldExpiredPermissions(events: ConvEvent[]): ConvEvent[] {
  const out: ConvEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (e.kind === 'permission' && e.decision === 'timeout') {
      let j = i + 1;
      while (j < events.length) {
        const f = events[j];
        if (f.kind !== 'permission' || f.decision !== 'timeout') break;
        j++;
      }
      const count = j - i;
      out.push(count > 1 ? { ...e, expiredGroupCount: count } : e);
      i = j;
      continue;
    }
    out.push(e);
    i++;
  }
  return out;
}

/**
 * Qual pedido de permissão mostrar no card **docado** acima do compositor (fora da `cc-timeline` que
 * rola — ver `ClaudePage.tsx`/`Timeline.tsx`/PARIDADE.md, "Card de permissão docado"). `undefined`
 * quando não há nenhum pendente agora (o card some).
 *
 * **Por que só um, e por que o primeiro**: `server/claude/runner.ts` guarda os pedidos pendentes num
 * `Map<string, Pending>` (`l.pending`) sem NENHUMA serialização — cada chamada de `canUseTool` do SDK
 * ganha sua própria entrada (`pid = randomUUID()`); nada no runner impede duas chamadas ficarem
 * pendentes ao mesmo tempo, se o SDK despachar tool_use independentes em paralelo no mesmo turno
 * (confirmado na prática, não só por leitura de código — ver teste "duas chamadas de canUseTool... "
 * em `tests/runner.test.ts`). A extensão real tem exatamente essa mesma forma de dado — o estado
 * `permissionRequests` dela também é uma LISTA — e resolve isso sempre lendo só o primeiro elemento:
 * confirmado lendo `webview/index.js` v2.1.282 (extensão extraída em
 * `/srv/orion-reference/vscode-extension/extension/webview/`), dentro do componente que monta
 * `inputContainer`: `N=$.permissionRequests.value[0]`, e o card só é montado quando
 * `h8=dx($)` é verdadeiro, onde `function dx($){return $.permissionRequests.value.length>0&&
 * !$.promptInputActive.value}` — ou seja, SEMPRE o primeiro da lista; os demais ficam na fila,
 * invisíveis, até o primeiro ser decidido (nunca dois cards ao mesmo tempo). Reproduzido aqui: o
 * primeiro evento `kind:'permission'` ainda sem `decision` nenhuma (nem `'timeout'` — esses ficam na
 * timeline, ver `foldExpiredPermissions` acima), na ordem em que aparece no array — mesma ordem de
 * `s.pending` em `live.ts` (FIFO: o pedido mais antigo ainda esperando é o que decide primeiro).
 */
export function currentPermission(events: ConvEvent[]): Extract<ConvEvent, { kind: 'permission' }> | undefined {
  return events.find((e): e is Extract<ConvEvent, { kind: 'permission' }> => e.kind === 'permission' && e.decision === undefined);
}

/**
 * Rótulo do estado "em andamento" de um bloco de ferramenta genérico (`Tool` em Timeline.tsx) —
 * "aguardando permissão…" para um tool_use cujo pedido de permissão ainda está pendente (status
 * `'waiting'`, ver `applyPendingToolWaitStatus`), "executando…" pro caso comum. Achado numa
 * investigação de "o padrão de mensagens tá diferente do plugin" (Bayerl, ao vivo, 28/09/2026; ver
 * PARIDADE.md): antes desta rodada, TODO tool_use que precisava de aprovação já mostrava
 * "executando…" na própria linha, assim que o SDK mandava o `tool_use` — antes mesmo do usuário
 * clicar Sim, e mesmo que ele acabasse clicando Não (o comando nunca chegou a rodar). Raiz do
 * problema: `server/claude/runner.ts` descartava `opts.toolUseID` (campo real do `canUseTool` do SDK,
 * documentado em `sdk.d.ts`: "Unique identifier for this specific tool call within the assistant
 * message") ao criar o pedido de permissão — sem esse id, não havia como ligar o bloco de ferramenta
 * (que vem de `reduceSdkMessages`, a partir do `tool_use` bruto) ao pedido de permissão pendente que
 * é dele de verdade. Corrigido: `runner.ts` agora repassa `opts.toolUseID` pro evento persistido/ao
 * vivo, e `applyPendingToolWaitStatus` usa esse id real (não um heurístico por nome/input) pra marcar
 * o bloco certo como `'waiting'`.
 */
export function toolRunningLabel(status: ToolStatus): string {
  return status === 'waiting' ? 'aguardando permissão…' : 'executando…';
}

/**
 * Corrige o status de um evento `tool` que `reduceSdkMessages` já marcou como `'running'` (o SDK manda
 * o `tool_use` e a timeline mostra "executando…" na hora — antes de qualquer decisão de permissão)
 * mas que na verdade tem um pedido de permissão pendente pra ELE MESMO, ligado pelo `toolUseId` real
 * do SDK (`opts.toolUseID` do `canUseTool`, repassado por `server/claude/runner.ts` — ver
 * `toolRunningLabel`). Pura: devolve uma lista nova só quando algo muda (mesma referência de volta
 * quando `pendingToolUseIds` está vazio ou não bate com nada — evita re-render à toa); nunca mexe em
 * eventos que não são `tool`, que já têm `output`, ou cujo status não é `'running'` (uma ferramenta já
 * `success`/`failure`/`warning` não regride pra `'waiting'` só porque calhou de aparecer aqui).
 */
export function applyPendingToolWaitStatus(events: ConvEvent[], pendingToolUseIds: ReadonlySet<string> | readonly string[]): ConvEvent[] {
  const ids = pendingToolUseIds instanceof Set ? pendingToolUseIds : new Set(pendingToolUseIds);
  if (ids.size === 0) return events;
  let changed = false;
  const out = events.map(e => {
    if (e.kind === 'tool' && e.status === 'running' && ids.has(e.toolUseId)) { changed = true; return { ...e, status: 'waiting' as ToolStatus }; }
    return e;
  });
  return changed ? out : events;
}

/**
 * Barras de uso da barra lateral: usa os limites reais da conta quando `/api/claude/usage` os
 * encontrou (`computeRealUsageBars`); cai para o proxy por custo (`computeProxyUsageBars`) quando
 * não há dado real — que é o caso hoje, com o token de `claude setup-token` (ver PARIDADE.md).
 */
export function computeUsageBars(rows: UsageRow[], real?: RealUsage, now = Date.now()): UsageBar[] {
  const realBars = real ? computeRealUsageBars(real.rate_limits, real.subscription_type, now) : [];
  if (realBars.length) return realBars;
  return computeProxyUsageBars(rows);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const min = Math.round(d / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Filtro combinado da lista de sessões: termo (título ou projeto), projeto exato e só-ativas. Pura. */
export type SessionFilter = { term?: string; project?: string; activeOnly?: boolean };
export function filterSessions(sessions: SessionSummary[], f: SessionFilter): SessionSummary[] {
  const term = (f.term ?? '').trim().toLowerCase();
  return sessions.filter(s => {
    if (f.project && s.project !== f.project) return false;
    if (f.activeOnly && s.status !== 'running' && s.status !== 'waiting') return false;
    if (term) {
      const hit = s.title.toLowerCase().includes(term)
        || (s.project ?? '').toLowerCase().includes(term)
        || (s.projectName ?? '').toLowerCase().includes(term);
      if (!hit) return false;
    }
    return true;
  });
}

/**
 * Como a extensão agrupa a lista lateral: nenhum agrupamento (um grupo só), por projeto, por
 * recência, ou por pasta nomeada manual (`'folder'`, ver PARIDADE.md item 12 da seção 13). Os três
 * primeiros são automáticos, derivados só das sessões (nunca persistidos — `useState` local em
 * Sidebar.tsx, reseta a cada reload); `'folder'` é o modo ADICIONAL novo, que lê uma lista à parte
 * de pastas persistidas (`folders`, 4º parâmetro de `groupSessions` abaixo) — não substitui os
 * outros três, que continuam funcionando exatamente como antes.
 */
export type GroupBy = 'none' | 'project' | 'recency' | 'folder';
export type SessionGroup = { key: string; label: string; sessions: SessionSummary[] };

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * `folders`: só usado pelo critério `'folder'` — lista de pastas nomeadas persistidas (`GET
 * /api/claude/session-groups`), na ordem em que foram criadas (`createdAt` ascendente; sem
 * reordenação manual nesta rodada, ver PARIDADE.md). Parâmetro novo, opcional (default `[]`) — não
 * quebra nenhuma chamada existente com `'none'`/`'project'`/`'recency'`.
 */
export function groupSessions(sessions: SessionSummary[], groupBy: GroupBy, now = Date.now(), folders: SessionGroupInfo[] = []): SessionGroup[] {
  if (groupBy === 'folder') {
    // Diferente de 'project' (grupo só existe se alguma sessão tiver aquele projeto): uma pasta é uma
    // entidade persistida à parte das sessões, então aparece mesmo vazia (usuário acabou de criar,
    // ainda não moveu nada pra dentro) — ordenada pela ordem de criação, nunca alfabética.
    const byId = new Map(folders.map(f => [f.id, f] as const));
    const out: SessionGroup[] = [...folders].sort((a, b) => a.createdAt - b.createdAt)
      .map(f => ({ key: `folder:${f.id}`, label: f.name, sessions: [] as SessionSummary[] }));
    const byKey = new Map(out.map(g => [g.key, g] as const));
    const ungrouped: SessionSummary[] = [];
    for (const s of sessions) {
      // Sem groupId, ou groupId de uma pasta que não existe mais na lista atual (apagada) — cai em
      // "Sem pasta" em vez de sumir da lateral (nunca perde uma sessão de vista).
      const g = s.groupId ? byKey.get(`folder:${s.groupId}`) : undefined;
      if (g && byId.has(s.groupId!)) g.sessions.push(s); else ungrouped.push(s);
    }
    out.push({ key: 'ungrouped', label: 'Sem pasta', sessions: ungrouped });
    return out;
  }
  if (groupBy === 'project') {
    const byKey = new Map<string, SessionGroup>();
    for (const s of sessions) {
      const key = s.project ?? '__sem_projeto__';
      const label = s.projectName ?? s.project ?? 'Sem projeto';
      if (!byKey.has(key)) byKey.set(key, { key, label, sessions: [] });
      byKey.get(key)!.sessions.push(s);
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }
  if (groupBy === 'recency') {
    const today = startOfDay(now);
    const dayMs = 86_400_000;
    const buckets: Record<'today' | 'yesterday' | 'week' | 'older', SessionSummary[]> = { today: [], yesterday: [], week: [], older: [] };
    for (const s of sessions) {
      const diffDays = Math.round((today - startOfDay(s.updatedAt)) / dayMs);
      if (diffDays <= 0) buckets.today.push(s);
      else if (diffDays === 1) buckets.yesterday.push(s);
      else if (diffDays <= 7) buckets.week.push(s);
      else buckets.older.push(s);
    }
    return ([
      { key: 'today', label: 'Hoje', sessions: buckets.today },
      { key: 'yesterday', label: 'Ontem', sessions: buckets.yesterday },
      { key: 'week', label: 'Esta semana', sessions: buckets.week },
      { key: 'older', label: 'Mais antigas', sessions: buckets.older },
    ] satisfies SessionGroup[]).filter(g => g.sessions.length > 0);
  }
  return [{ key: 'all', label: 'Sem grupo', sessions }];
}

/**
 * Histórico de mensagens do usuário nesta sessão, mais recente primeiro — espelha `cx()` no webview
 * decompilado v2.1.282 da extensão real: filtra os eventos `kind: 'user'`, pega o texto, descarta
 * vazio/só espaço, e inverte (a lista de eventos é cronológica, mais antiga primeiro; o recall quer o
 * oposto — item [0] é o último enviado). Alimenta o ciclo ArrowUp/ArrowDown do compositor
 * (ver `cycleMessageIndex`).
 */
export function messageHistory(events: ConvEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== 'user') continue;
    const t = e.text.trim();
    if (t) out.push(t);
  }
  return out.reverse();
}

/** Estado do ciclo de recall de mensagens: índice atual no histórico (-1 = fora do ciclo) e o rascunho original salvo antes de começar a ciclar. */
export type CycleState = { index: number; saved: string };
export type CycleResult = { index: number; saved: string; text: string };

/**
 * Passo puro do ciclo ArrowUp(-1)/ArrowDown(1) pelo histórico de mensagens — mesma lógica de
 * `cycleMessage` (a função `q`, dentro do hook `Cq0`) no webview decompilado v2.1.282: na 1ª
 * ArrowUp guarda o texto atual em `saved` e mostra o item mais recente (índice 0); ArrowUp de novo
 * avança pro item seguinte mais antigo; no item mais antigo, ArrowUp não dá a volta — retorna null
 * (deixa o comportamento padrão da tecla acontecer). ArrowDown volta em direção ao mais recente e,
 * a partir do índice 0, restaura `saved` — o rascunho **original**, exatamente como estava antes de
 * começar a ciclar (mesmo que o meio do ciclo tenha sido editado: só o texto salvo no início conta).
 * ArrowDown fora de um ciclo (index -1) não faz nada — null. Sem histórico, sempre null. A checagem
 * de "o cursor está no início/fim do texto" (só aí a tecla vira recall) é responsabilidade de quem
 * chama, não desta função — aqui é só o índice.
 */
export function cycleMessageIndex(direction: -1 | 1, state: CycleState, history: string[], currentInput: string): CycleResult | null {
  if (history.length === 0) return null;
  if (direction === -1) {
    if (state.index === -1) return { index: 0, saved: currentInput, text: history[0] };
    if (state.index < history.length - 1) return { index: state.index + 1, saved: state.saved, text: history[state.index + 1] };
    return null;
  }
  if (state.index === -1) return null;
  if (state.index > 0) return { index: state.index - 1, saved: state.saved, text: history[state.index - 1] };
  return { index: -1, saved: state.saved, text: state.saved };
}

/**
 * URL pra buscar de volta a imagem de um anexo já enviado — alimenta a miniatura clicável do
 * histórico (`Attachments` em Timeline.tsx) e o popup de imagem (`Lightbox.tsx`, 28/09/2026, pedido
 * ao vivo do Bayerl: "a thumbnail de imagem... copia a regra, UI... do plugin de claude code pra
 * ficar 100% igual" — ver PARIDADE.md pro achado completo no webview decompilado da extensão real).
 * Só imagens: `kind !== 'image'`, ou faltando `path`/`media_type` (anexo persistido ANTES desta
 * rodada, quando a nota compacta só guardava kind/name/media_type — ver `UserAttachment` em
 * types.ts), devolve `undefined` — quem chama cai pro chip de sempre (ícone + nome, sem link), nunca
 * um `<img>` quebrado apontando pra uma URL sem sentido. O arquivo em si já existe no servidor desde
 * o upload (`server/routes/claude.ts`, endpoint `POST /api/claude/uploads` salva em
 * `<uploadRoot>/<user_id>/<uuid>-<nome>` e NUNCA apaga depois de usado num turno) — só faltava uma
 * rota pra servir de volta; `GET /api/claude/attachments` (mesmo arquivo) é essa rota, `type` restrito
 * à lista real de mídia de imagem que o SDK aceita (`IMAGE_MEDIA_TYPES`, mesma constante de
 * `attachmentBlocks` em runner.ts) pra nunca refletir um Content-Type arbitrário vindo da query.
 */
export function attachmentImageUrl(a: { kind: 'image' | 'file'; media_type?: string; path?: string }): string | undefined {
  if (a.kind !== 'image' || !a.path || !a.media_type) return undefined;
  return `/api/claude/attachments?path=${encodeURIComponent(a.path)}&type=${encodeURIComponent(a.media_type)}`;
}

/**
 * "Mapa de agentes" (Agent map) — pedido ao vivo do Bayerl 28/09/2026, retomando o que a rodada de
 * Task/Agent (ver `taskStatusLabel` acima) tinha deixado de fora de propósito: telemetria de tempo
 * decorrido e tokens por subagente. Achados completos, com citações do webview decompilado real
 * (v2.1.282 e v2.1.283) e do `.d.ts` do Agent SDK, em PARIDADE.md — resumo aqui:
 * - A extensão real tem um painel de verdade (`title:"Agent map"`) com uma árvore raiz→agentes.
 * - Duração de cada agente (`b85`/`v85` no webview real): enquanto roda, `Date.now()-startTime`
 *   (`startTime` é observado no CLIENTE no instante em que o `tool_use` chega, não um timestamp de
 *   servidor — a extensão real faz exatamente isso também); depois de terminar, prefere
 *   `usage.durationMs` (quando `status==="finished"`) sobre o `endTime-startTime` computado; abaixo
 *   de 1s, não mostra nada.
 * - Tokens (`usage.totalTokens`): vêm de um campo REAL do SDK, `SDKUserMessage.tool_use_result`
 *   (`sdk.d.ts`: "Structured tool output... For the Agent/Task tool the completed shape is the
 *   subagent's final report... plus run totals — render from it instead of parsing the tool_result
 *   text"), forma `AgentOutput` (`sdk-tools.d.ts`, branch `status:"completed"`:
 *   `totalTokens`/`totalToolUseCount`/`totalDurationMs`). O runner do Orion já persiste a mensagem
 *   inteira do SDK (`server/claude/runner.ts`: `appendEvent(id, m.type, m)`), então esse campo,
 *   quando o SDK o populam, já chega ao front sem nenhuma mudança de backend — não confirmado ao vivo
 *   em produção nesta rodada (sem acesso a credenciais de banco neste ambiente); ver PARIDADE.md.
 */

/**
 * Lê `tool_use_result` (ver `SdkMessage` em types.ts) de forma defensiva, nunca lança. Só devolve
 * algo quando o SDK realmente mandou a forma `AgentOutput` com `status:"completed"` E pelo menos um
 * dos 3 totais é um número de verdade — nunca inventa um campo ausente (um subagente disparado em
 * background, por exemplo, chega com `status:"async_launched"`, sem totais ainda: `undefined`, de
 * propósito, não um objeto vazio).
 */
export function parseAgentTaskUsage(toolUseResult: unknown): AgentTaskUsage | undefined {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return undefined;
  const r = toolUseResult as Rec;
  if (r.status !== 'completed') return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const totalTokens = num(r.totalTokens);
  const toolUses = num(r.totalToolUseCount);
  const durationMs = num(r.totalDurationMs);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) return undefined;
  return { totalTokens, toolUses, durationMs };
}

/**
 * Atualiza o mapa de subagentes (`LiveState.agentTasks`, ver live.ts) a partir de UMA mensagem do SDK
 * já reduzida — usado tanto por `fromRows` (histórico reconstruído, `when` = `ts` real da linha)
 * quanto por `applyLive` (mensagem ao vivo do SSE, `when` = instante observado no navegador). Pura:
 * devolve a MESMA referência quando nada muda (mesma disciplina de `applyPendingToolWaitStatus`) —
 * cria uma entrada nova só no `tool_use` da tool `Task` (nunca sobrescreve uma já existente com o
 * mesmo id — o SDK não repete `tool_use.id`), e só fecha (status final + `endedAt` + `usage`) no
 * `tool_result` casado por `tool_use_id`, e só se ainda não tiver sido fechada antes (protege o
 * `endedAt`/`usage` REAIS de uma reconexão/replay que reenvie o mesmo `tool_result` com um `when`
 * mais novo, o que aconteceria toda vez que `fromRows` roda de novo num reconnect do SSE).
 */
export function noteAgentTask(tasks: Record<string, AgentTask>, message: SdkMessage, when: number): Record<string, AgentTask> {
  if (message.type === 'assistant') {
    let next: Record<string, AgentTask> | undefined;
    for (const b of message.message.content) {
      if (b.type !== 'tool_use' || b.name !== 'Task' || tasks[b.id] || next?.[b.id]) continue;
      const i = (b.input ?? {}) as Rec;
      const entry: AgentTask = {
        toolUseId: b.id,
        description: typeof i.description === 'string' ? i.description : b.name,
        subagentType: typeof i.subagent_type === 'string' ? i.subagent_type : undefined,
        status: 'running',
        startedAt: when,
      };
      next = { ...(next ?? tasks), [b.id]: entry };
    }
    return next ?? tasks;
  }
  if (message.type === 'user') {
    const c = message.message.content;
    if (typeof c === 'string') return tasks;
    let next: Record<string, AgentTask> | undefined;
    for (const b of c) {
      if (b.type !== 'tool_result') continue;
      const cur = (next ?? tasks)[b.tool_use_id];
      if (!cur || cur.endedAt !== undefined) continue;
      const usage = parseAgentTaskUsage(message.tool_use_result);
      const closed: AgentTask = { ...cur, status: b.is_error ? 'failure' : 'success', endedAt: when, usage };
      next = { ...(next ?? tasks), [b.tool_use_id]: closed };
    }
    return next ?? tasks;
  }
  return tasks;
}

/**
 * Duração de um subagente pra exibir no card do Mapa de agentes — mesma prioridade da extensão real
 * (funções `b85`/`v85` do webview decompilado, ver PARIDADE.md): rodando/aguardando, tempo decorrido
 * até `now`; terminado com sucesso, prefere `usage.durationMs` (o total que o próprio SDK reportou)
 * sobre o `endedAt-startedAt` computado; terminado com falha (ou outro status), o inverso — prefere o
 * computado. `undefined` sem nenhum dado de tempo, ou quando o resultado é menor que 1s (mesmo
 * limiar da extensão real — não vale a pena mostrar durações irrisórias).
 */
export function agentTaskDuration(task: AgentTask, now: number): number | undefined {
  if (task.status === 'running' || task.status === 'waiting') {
    return task.startedAt === undefined ? undefined : now - task.startedAt;
  }
  const computed = task.startedAt !== undefined && task.endedAt !== undefined && task.endedAt > task.startedAt
    ? task.endedAt - task.startedAt : undefined;
  const reported = task.usage?.durationMs !== undefined && task.usage.durationMs > 0 ? task.usage.durationMs : undefined;
  const ms = task.status === 'success' ? (reported ?? computed) : (computed ?? reported);
  return ms === undefined || ms < 1000 ? undefined : ms;
}

/** Formata uma duração de subagente no estilo compacto do print do Bayerl ("25m 44s"). */
export function formatAgentDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

/**
 * Total de tokens (entrada+saída) já gastos nesta sessão, somando todos os turnos já concluídos —
 * mesma soma que já alimenta o "N↑ / N↓ tokens" do `Result` em Timeline.tsx (`sumModelUsage`), só que
 * acumulada pra sessão inteira em vez de por turno. Usado como a meta do nó raiz do Mapa de agentes.
 * `undefined` sem nenhum turno concluído ainda — nunca mostra "0 tokens" fabricado antes do 1º turno
 * terminar.
 */
export function sumSessionTokens(events: ConvEvent[]): number | undefined {
  let total: number | undefined;
  for (const e of events) {
    if (e.kind !== 'result') continue;
    total = (total ?? 0) + (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
  }
  return total;
}

/** `LiveState.agentTasks` (mapa por `toolUseId`) como lista ordenada pro Mapa de agentes — ordem de
 * disparo (`startedAt` crescente); entradas sem `startedAt` (não deveria acontecer na prática, já que
 * `noteAgentTask` sempre grava um `startedAt`) vão por último, de forma estável. */
export function agentTaskList(tasks: Record<string, AgentTask>): AgentTask[] {
  return Object.values(tasks).sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
}

/**
 * Validação ao vivo do nome de worktree digitado no compositor (Composer.tsx, seletor "Worktree" —
 * ver PARIDADE.md seção 14) — MESMA regra da extensão real (função `fF0` no webview decompilado
 * v2.1.283): só letras/números/ponto/hífen/sublinhado, até 64 caracteres, nunca "." nem ".." nem
 * contendo "..", nunca termina em "." nem ".lock", nunca é ".git" (mesmo com pontos finais ou
 * maiúsculas). Mensagens em PT-BR, igual ao resto da tela. Duplicada de propósito em
 * `server/claude/worktree.ts` (mesma regra, nunca importada de lá pra cá): esta função aqui é só
 * conveniência de UI (mostra o erro cedo, sem round-trip); o servidor sempre revalida antes de
 * qualquer `git worktree add` — nunca confia neste resultado.
 */
export function validateWorktreeName(name: string): string | null {
  if (!name) return 'nome é obrigatório';
  if (name.length > 64) return 'nome deve ter até 64 caracteres';
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return 'use só letras, números, pontos, hífens e sublinhados';
  if (name === '.' || name === '..' || name.includes('..')) return 'nome não pode ser "." nem ".." nem conter ".."';
  if (name.endsWith('.') || name.endsWith('.lock')) return 'nome não pode terminar em "." nem ".lock"';
  if (name.toLowerCase().replace(/\.+$/, '') === '.git') return 'nome não pode ser ".git"';
  return null;
}

/**
 * Nome do worktree de uma sessão, a partir do `cwd` já exposto por `ApiSession` — sem coluna nova no
 * Postgres (decisão de escopo, ver PARIDADE.md seção 14). Espelha a checagem real da extensão
 * (`worktree.value.path !== defaultCwd.value` — só mostra pill/banner quando a sessão está FORA do
 * cwd padrão do projeto), adaptada: aqui não existe um objeto `worktree` com `.name` próprio vindo do
 * host — o nome é sempre o último segmento do `cwd`, porque toda sessão em worktree tem seu `cwd`
 * calculado como `<worktreesBaseDir(project.path)>/<nome>` (ver `server/claude/worktree.ts`), então o
 * último segmento do caminho É o nome que o usuário digitou. `null` quando a sessão está na raiz do
 * projeto (sem worktree) ou quando falta `cwd`/`projectPath` pra comparar.
 */
export function sessionWorktreeName(cwd: string | null | undefined, projectPath: string | null | undefined): string | null {
  if (!cwd || !projectPath) return null;
  const norm = (p: string) => p.replace(/\/+$/, '');
  const c = norm(cwd);
  if (c === norm(projectPath)) return null;
  const segs = c.split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : null;
}

export const GROUP_NAME_MAX = 120;

/**
 * Validação ao vivo do nome de uma pasta nomeada (Sidebar.tsx — ver PARIDADE.md item 12 da seção
 * 13). Diferente de `validateWorktreeName` acima (que espelha uma regra REAL da extensão, porque o
 * nome do worktree vira nome de branch git): um nome de pasta é só um rótulo livre guardado no
 * Postgres, sem restrição de caractere nenhuma na extensão real (não achamos função de validação
 * dedicada pra `groupName` no webview decompilado — só o limite implícito de UI). Por isso a regra
 * aqui é a MAIS simples possível, e deliberadamente igual à que `POST
 * /api/claude/sessions/:id/rename` já usa pro título da sessão (`title.trim().slice(0, 120)`) — mesmo
 * limite (120), mesma ideia ("vazio depois de trim é inválido"), em vez de inventar um limite novo só
 * pra pastas. Cópia do lado cliente da validação autoritativa (`server/claude/groups.ts`,
 * `validateGroupName` — nunca importada de lá pra cá, mesmo padrão de duplicação deliberada que
 * `validateWorktreeName`/`server/claude/worktree.ts` já usam): esta função aqui só mostra o erro
 * cedo; o servidor sempre revalida antes de gravar.
 */
export function validateGroupName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'nome é obrigatório';
  if (trimmed.length > GROUP_NAME_MAX) return `nome deve ter até ${GROUP_NAME_MAX} caracteres`;
  return null;
}
