import { randomUUID } from 'node:crypto';
import { policyHook } from './policy.js';
import { readFile } from 'node:fs/promises';
import type { McpServerConfig, Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage, SdkPluginConfig, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

/** Evento vivo enviado aos assinantes (SSE) e, quando persistente, gravado no banco. */
export type LiveEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'message'; message: SDKMessage }
  | { type: 'partial'; event: unknown }
  /**
   * `toolUseId`: o id real do SDK pro tool_use que gerou este pedido (`opts.toolUseID` do callback
   * `canUseTool`, campo documentado em `sdk.d.ts` — "Unique identifier for this specific tool call
   * within the assistant message"). Investigação de 28/09/2026 (Bayerl: "não é o mesmo padrão do
   * plugin"): esse campo existia no SDK mas era descartado aqui — o `pid` (id do pedido de permissão)
   * é um `randomUUID()` do próprio Orion, sem NENHUMA relação com o id do tool_use, então o mapper
   * nunca conseguia ligar o bloco de ferramenta (que já aparece na timeline assim que o SDK manda o
   * tool_use, status "running"/"executando…") ao pedido de permissão pendente pra ELE — o bloco da
   * ferramenta mostrava "executando…" antes mesmo do usuário aprovar. Ver PARIDADE.md e
   * `applyPendingToolWaitStatus` em web/src/claude/mapper.ts. Opcional: pode faltar em eventos
   * antigos, persistidos antes desta correção.
   */
  | { type: 'permission_request'; id: string; toolName: string; input: Record<string, unknown>; hasSuggestions: boolean; toolUseId?: string }
  | { type: 'permission_resolved'; id: string; decision: Decision; message?: string }
  | { type: 'error'; message: string }
  /**
   * Turno abortado manualmente (botão Parar) — distinto de 'error' de propósito (ver runner.stop()/
   * catch de run()): um erro genuíno do SDK continua emitindo só 'error' com status 'error'; um stop
   * do usuário emite só 'interrupted' com status 'idle', pra não conflitar os dois casos na tela nem
   * nos dados persistidos (bug corrigido em 28/09/2026, ver PARIDADE.md). `partialText`/`partialThinking`
   * é o que já tinha sido gerado no streaming até o abort (acumulado em `run()` a partir dos
   * `stream_event`) — sem isso, o texto parcial se perde pra sempre ao recarregar a página, porque
   * mensagens parciais nunca são persistidas em `claude_events` (só a mensagem completa seria, e ela
   * nunca chega quando o turno é interrompido no meio). `duringTool`: havia um pedido de permissão de
   * ferramenta pendente no momento do stop() — proxy pro que a extensão real distingue lendo o texto
   * literal "[Request interrupted by user for tool use]" (rótulo "Tool interrupted"; ver `Qw` no
   * webview decompilado) — aqui não existe esse sentinela (a interrupção é uma exceção de
   * AbortController, não um bloco de texto do SDK), então usamos o sinal equivalente que já temos.
   */
  | { type: 'interrupted'; message: string; duringTool: boolean; partialText: string; partialThinking: string }
  | { type: 'turn_end'; costUsd: number; turns: number; ok: boolean }
  | { type: 'commands'; commands: SlashCommand[] };

export type SessionStatus = 'running' | 'waiting' | 'idle' | 'error';
export type Decision = 'allow' | 'allow_always' | 'deny' | 'answer' | 'timeout';

export interface Store {
  appendEvent(sessionId: string, type: string, payload: unknown): Promise<void>;
  updateSession(sessionId: string, patch: { status?: SessionStatus; costUsd?: number; turns?: number; lastError?: string | null; model?: string | null }): Promise<void>;
  createApproval(a: { id: string; sessionId: string; toolName: string; input: unknown }): Promise<void>;
  decideApproval(id: string, decision: Decision, decidedBy: number | null): Promise<void>;
}

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query | AsyncIterable<SDKMessage>;

/** Anexo já salvo em disco pelo endpoint de upload; o runner lê o caminho na hora de montar o prompt. */
export type Attachment = { kind: 'image' | 'file'; media_type: string; name: string; path: string };

/** Prompt de um turno: texto puro (comportamento antigo) ou texto + anexos. */
export type TurnPrompt = string | { text: string; attachments: Attachment[] };

/** Tipos de imagem que o modelo aceita como bloco base64 (Base64ImageSource do SDK). */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type AttachmentImageBlock = { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } };

/**
 * Traduz anexos em blocos de conteúdo do SDK. Puro (recebe o leitor por injeção, para teste).
 * Imagens (png/jpeg/webp/gif) viram bloco `image` base64; os demais arquivos viram uma
 * linha anexada ao texto apontando o caminho no servidor (o modelo lê com ferramentas).
 */
export async function attachmentBlocks(
  attachments: Attachment[],
  read: (path: string) => Promise<Buffer> = readFile,
): Promise<{ blocks: AttachmentImageBlock[]; textSuffix: string }> {
  const blocks: AttachmentImageBlock[] = [];
  const notes: string[] = [];
  for (const a of attachments ?? []) {
    const mt = (a.media_type || '').toLowerCase();
    if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(mt)) {
      const buf = await read(a.path);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mt as ImageMediaType, data: buf.toString('base64') } });
    } else {
      notes.push(`\n\n[arquivo anexado: ${a.name} em ${a.path} — use ferramentas para lê-lo]`);
    }
  }
  return { blocks, textSuffix: notes.join('') };
}

export type TurnParams = {
  sessionId: string;
  cwd: string;
  prompt: TurnPrompt;
  isNew: boolean;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'auto';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  systemAppend: string;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  /** Composição por pessoa (server/tools/skillPrefs.ts): plugins do catálogo ligados e skills bloqueadas. */
  plugins?: SdkPluginConfig[];
  disallowedTools?: string[];
  /**
   * Output style da sessão (coluna claude_sessions.output_style — ver server/tools/outputStyles.ts
   * e PARIDADE-marketplace.md). Vai pro SDK pela camada de settings de flag (`Options.settings`,
   * equivalente ao `--settings` do CLI), que aceita `outputStyle` — canal DIRETO, sem gambiarra de
   * systemAppend. Ausente = sem estilo (o "default" do CLI).
   */
  outputStyle?: string;
};

type Pending = { resolve: (r: PermissionResult) => void; suggestions?: PermissionUpdate[]; timer: NodeJS.Timeout; toolName: string; toolUseId?: string };

type Live = {
  status: SessionStatus;
  abort: AbortController | null;
  subscribers: Set<(e: LiveEvent) => void>;
  pending: Map<string, Pending>;
  queue: TurnParams[];
  stderr: string[];
  /** Últimos comandos de barra conhecidos (Query.supportedCommands() do SDK) — só em memória, como `pending`; some se o processo reiniciar (mesma limitação já aceita para permissões, ver mapper.ts/foldExpiredPermissions). */
  commands: SlashCommand[];
  /** `stop()` marca aqui se havia pedido(s) de permissão de ferramenta pendente(s) no momento do abort — lido uma única vez pelo catch de `run()` (evento 'interrupted') e resetado em seguida. */
  stopHadPendingTool: boolean;
  /**
   * A Query viva do turno atual — só existe entre o `queryFn(...)` de `run()` e o `finally` que a
   * fecha (null quando a sessão está ociosa entre turnos). Guardada aqui (e não só na variável local
   * `q` de dentro de `run()`, que já é usada pra `supportedCommands()` fire-and-forget) pra que
   * `setPermissionModeLive`/`setModelLive`/`setEffortLive` — chamados por uma rota HTTP a qualquer
   * momento, fora do `for await` do turno — consigam achar a Query certa. Mesma vida útil em memória
   * de `pending`/`commands`: some se o processo reiniciar (aceito, mesma limitação já documentada
   * pra permissões pendentes).
   */
  query: Query | null;
};

export class Runner {
  private live = new Map<string, Live>();
  constructor(private deps: { queryFn: QueryFn; store: Store; permissionTimeoutMs?: number; log?: (msg: string) => void }) {}

  private get(id: string): Live {
    let l = this.live.get(id);
    if (!l) { l = { status: 'idle', abort: null, subscribers: new Set(), pending: new Map(), queue: [], stderr: [], commands: [], stopHadPendingTool: false, query: null }; this.live.set(id, l); }
    return l;
  }

  status(id: string): SessionStatus { return this.live.get(id)?.status ?? 'idle'; }
  pendingPermissions(id: string): { id: string; toolName: string }[] {
    return [...(this.live.get(id)?.pending ?? new Map()).entries()].map(([pid, p]) => ({ id: pid, toolName: p.toolName }));
  }
  /** Comandos de barra reais da sessão, do último `Query.supportedCommands()` (ou push `commands_changed`) que chegou — [] antes do primeiro turno rodar neste processo. */
  commandsFor(id: string): SlashCommand[] { return this.live.get(id)?.commands ?? []; }

  /**
   * Troca o modo de permissão AO VIVO, sem esperar a próxima mensagem — bug real reportado pelo
   * Bayerl em 28/09/2026 (sessão c4380a41-d263-408e-9543-4be08d1aea01, confirmado ao vivo no
   * Postgres de produção, read-only: `status: 'waiting'`, `permission_mode: 'acceptEdits'`, com um
   * `permission_request` pendente — a UI mostrava "Auto" selecionado, mas o Postgres nunca via a
   * troca, porque `onMode` só atualizava `useState` local em `ClaudePage.tsx`; o valor novo só seria
   * mandado ao servidor no PRÓXIMO `create`/`send`). Usa `Query.setPermissionMode()` do SDK — control
   * method que existe exatamente pra isso (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`);
   * a extensão real faz o mesmo (webview decompilado: o `onSelect` do menu de modo chama
   * `connection.setPermissionMode(...)` na hora, nunca espera a próxima mensagem).
   *
   * Sem Query viva agora (sessão ociosa entre turnos, ou nunca rodou neste processo): não há o que
   * aplicar aqui — devolve `false` sem lançar. A rota (`server/routes/claude.ts`) sempre persiste o
   * modo novo no Postgres primeiro, então o PRÓXIMO turno já nasce certo de qualquer forma (mesmo
   * comportamento de antes desta correção, preservado). Mesma checagem defensiva de
   * `typeof === 'function'` já usada acima pra `supportedCommands()`: um fake de teste "burro" (ou
   * uma versão do CLI que não tenha esse control method) não deve derrubar o runner.
   *
   * @returns `true` quando havia uma Query viva e o método de controle foi chamado; `false` quando
   * não havia nada ao vivo pra atualizar (só a persistência no Postgres, feita pela rota, vale).
   */
  async setPermissionModeLive(sessionId: string, mode: TurnParams['permissionMode']): Promise<boolean> {
    const q = this.live.get(sessionId)?.query as unknown as Partial<Query> | undefined;
    if (!q || typeof q.setPermissionMode !== 'function') return false;
    await q.setPermissionMode(mode);
    return true;
  }

  /**
   * Troca o modelo AO VIVO — mesmo bug/mesma correção de `setPermissionModeLive` acima, aplicado ao
   * seletor de modelo do compositor (`onModel`/`setModel` em `ClaudePage.tsx`, implementado antes
   * desta rodada só como "vale pro próximo turno"). Usa `Query.setModel()` do SDK (mesmo arquivo
   * `sdk.d.ts`, mesma vizinhança de `setPermissionMode`); a extensão real também aplica na hora
   * (webview: `setModel` da classe de conexão chama o control method direto, sem esperar mensagem
   * nova). `undefined` = "sem override" (volta pro modelo padrão da sessão/conta), igual ao
   * `model?: string` do control method real.
   */
  async setModelLive(sessionId: string, model: string | undefined): Promise<boolean> {
    const q = this.live.get(sessionId)?.query as unknown as Partial<Query> | undefined;
    if (!q || typeof q.setModel !== 'function') return false;
    await q.setModel(model);
    return true;
  }

  /**
   * Troca o esforço de raciocínio AO VIVO. Diferente de modo/modelo, o SDK não tem um `setEffort()`
   * dedicado — o control method real é o genérico `Query.applyFlagSettings()`, que aceita
   * `effortLevel` entre as chaves que mescla na camada de settings da sessão (`sdk.d.ts`). Confirmado
   * que é exatamente esse o caminho que a extensão real usa, lendo o webview decompilado: o handler
   * `setEffortLevel` da classe de conexão chama `this.applySettings({ effortLevel: $ })` na hora, o
   * mesmo padrão "aplica agora" de modo/modelo — não "só no próximo turno" como se poderia supor por
   * não existir um método com nome dedicado. `effort` agora também é persistido por sessão no
   * Postgres (coluna `claude_sessions.effort`, migração `009_claude_effort` — trazido a paridade com
   * modo/modelo num follow-up de 28/09/2026), mas a persistência acontece na rota HTTP
   * (`server/routes/claude.ts`, mesmo padrão condicional de modo/modelo: só grava quando muda),
   * ANTES de chamar este método — este método aqui no Runner continua tendo só o lado "ao vivo".
   */
  async setEffortLive(sessionId: string, effort: TurnParams['effort']): Promise<boolean> {
    const q = this.live.get(sessionId)?.query as unknown as Partial<Query> | undefined;
    if (!q || typeof q.applyFlagSettings !== 'function') return false;
    await q.applyFlagSettings({ effortLevel: effort });
    return true;
  }

  /**
   * Troca o output style AO VIVO — mesmo desenho de `setEffortLive` acima: não existe um
   * `setOutputStyle()` dedicado no SDK, mas `Query.applyFlagSettings()` aceita `outputStyle` entre
   * as chaves de Settings que mescla na camada de flag da sessão (sdk.d.ts; é a MESMA camada que
   * `Options.settings` alimenta no início do turno — ver TurnParams.outputStyle). `null` = volta
   * pro padrão (sem estilo), semântica documentada do applyFlagSettings ("null restores neither a
   * query() option nor a settings-file value"). A persistência por sessão acontece na rota HTTP
   * (server/routes/claude.ts, POST /:id/output-style), ANTES desta chamada — mesmo contrato de
   * modo/modelo/esforço.
   */
  async setOutputStyleLive(sessionId: string, style: string | null): Promise<boolean> {
    const q = this.live.get(sessionId)?.query as unknown as Partial<Query> | undefined;
    if (!q || typeof q.applyFlagSettings !== 'function') return false;
    await q.applyFlagSettings({ outputStyle: style });
    return true;
  }

  subscribe(id: string, fn: (e: LiveEvent) => void): () => void {
    const l = this.get(id); l.subscribers.add(fn);
    return () => { l.subscribers.delete(fn); };
  }

  private emit(id: string, e: LiveEvent) {
    for (const fn of this.get(id).subscribers) { try { fn(e); } catch { /* assinante morto */ } }
  }

  private async setStatus(id: string, status: SessionStatus, extra?: Parameters<Store['updateSession']>[1]) {
    const l = this.get(id);
    if (l.status !== status) { l.status = status; this.emit(id, { type: 'status', status }); }
    await this.deps.store.updateSession(id, { status, ...(extra ?? {}) });
  }

  /** Enfileira um turno. Se a sessão está ociosa, começa agora. Retorna sem esperar o turno acabar. */
  startTurn(p: TurnParams): void {
    const l = this.get(p.sessionId);
    if (l.status === 'running' || l.status === 'waiting') { l.queue.push(p); return; }
    void this.run(p);
  }

  async stop(id: string): Promise<void> {
    const l = this.get(id);
    l.queue = [];
    // Antes de negar as pendências (o que esvazia l.pending): se havia pedido(s) de permissão de
    // ferramenta esperando resposta, o catch de run() usa isso pra rotular a interrupção como "durante
    // uso de ferramenta" (ver LiveEvent 'interrupted').
    l.stopHadPendingTool = l.pending.size > 0;
    for (const [pid, p] of l.pending) { clearTimeout(p.timer); p.resolve({ behavior: 'deny', message: 'Sessão interrompida pelo usuário', interrupt: true }); l.pending.delete(pid); this.emit(id, { type: 'permission_resolved', id: pid, decision: 'deny' }); }
    l.abort?.abort();
  }

  async decide(sessionId: string, approvalId: string, decision: Exclude<Decision, 'timeout'>, decidedBy: number | null, message?: string): Promise<boolean> {
    const l = this.get(sessionId);
    const p = l.pending.get(approvalId);
    if (!p) return false;
    clearTimeout(p.timer); l.pending.delete(approvalId);
    // Grava a decisão ANTES de soltar a ferramenta: o helper root (deploy/root-run.py) confere a
    // aprovação no banco assim que o pedido chega, então ela precisa já estar lá.
    await this.deps.store.decideApproval(approvalId, decision, decidedBy);
    if (decision === 'answer') p.resolve({ behavior: 'deny', message: `O usuário respondeu à sua pergunta: "${(message ?? '').trim()}". Continue a partir dessa escolha, sem repetir a pergunta.` });
    else if (decision === 'deny') p.resolve({ behavior: 'deny', message: message?.trim() || 'Negado pelo usuário no painel Orion' });
    else p.resolve({ behavior: 'allow', ...(decision === 'allow_always' && p.suggestions ? { updatedPermissions: p.suggestions } : {}) });
    await this.deps.store.appendEvent(sessionId, 'permission_resolved', { id: approvalId, decision, message: message ?? null });
    // A mensagem (ex.: a resposta escolhida num AskUserQuestion) vai junto do evento ao vivo também,
    // não só do persistido — senão a tela não tem o que mostrar no bubble "Você respondeu" sem recarregar.
    this.emit(sessionId, { type: 'permission_resolved', id: approvalId, decision, ...(message !== undefined ? { message } : {}) });
    if (l.pending.size === 0 && l.status === 'waiting') await this.setStatus(sessionId, 'running');
    return true;
  }

  private async run(p: TurnParams): Promise<void> {
    const id = p.sessionId;
    const l = this.get(id);
    const abort = new AbortController();
    l.abort = abort; l.stderr = [];
    // Normaliza: texto puro (comportamento antigo) ou { text, attachments }.
    const promptObj = typeof p.prompt === 'string' ? { text: p.prompt, attachments: [] as Attachment[] } : p.prompt;
    const text = promptObj.text;
    const attachments = promptObj.attachments ?? [];
    // Nota compacta persistida: nomes + o bastante pra reexibir os anexos ao reabrir a sessão. `path`
    // (28/09/2026, popup de imagem/Lightbox — ver PARIDADE.md) já era devolvido ao navegador pelo
    // endpoint de upload (POST /api/claude/uploads) antes de chegar aqui, então não é uma exposição
    // nova; é o que permite `attachmentImageUrl` (web/src/claude/mapper.ts) montar a URL de
    // `GET /api/claude/attachments` e mostrar a miniatura clicável do anexo já enviado no histórico,
    // mesmo depois de recarregar a página (o arquivo em si nunca é apagado depois de usado num turno).
    const attachNote = attachments.map(a => ({ kind: a.kind, name: a.name, media_type: a.media_type, path: a.path }));
    await this.setStatus(id, 'running', { lastError: null });
    await this.deps.store.appendEvent(id, 'user_prompt', { prompt: text, ...(attachNote.length ? { attachments: attachNote } : {}) });
    this.emit(id, { type: 'message', message: { type: 'user', message: { role: 'user', content: text, ...(attachNote.length ? { attachments: attachNote } : {}) }, parent_tool_use_id: null, session_id: id } as unknown as SDKMessage });

    const canUseTool: Options['canUseTool'] = (toolName, input, opts) => new Promise<PermissionResult>((resolve) => {
      const pid = randomUUID();
      const timer = setTimeout(() => {
        l.pending.delete(pid);
        resolve({ behavior: 'deny', message: 'Sem resposta em 30 minutos; negado automaticamente' });
        void this.deps.store.decideApproval(pid, 'timeout', null);
        void this.deps.store.appendEvent(id, 'permission_resolved', { id: pid, decision: 'timeout' });
        this.emit(id, { type: 'permission_resolved', id: pid, decision: 'timeout' });
        if (l.pending.size === 0) void this.setStatus(id, 'running');
      }, this.deps.permissionTimeoutMs ?? 30 * 60_000);
      opts.signal.addEventListener('abort', () => { clearTimeout(timer); l.pending.delete(pid); });
      // opts.toolUseID: id real do SDK pro tool_use (ver comentário de LiveEvent 'permission_request'
      // acima) — repassado pro evento persistido/ao vivo pra o mapper poder ligar o bloco de
      // ferramenta ao pedido de permissão que é dele de verdade, em vez de duas coisas soltas na tela.
      l.pending.set(pid, { resolve, suggestions: opts.suggestions, timer, toolName, toolUseId: opts.toolUseID });
      void this.deps.store.createApproval({ id: pid, sessionId: id, toolName, input });
      void this.deps.store.appendEvent(id, 'permission_request', { id: pid, toolName, input, toolUseId: opts.toolUseID });
      void this.setStatus(id, 'waiting');
      this.emit(id, { type: 'permission_request', id: pid, toolName, input, hasSuggestions: !!opts.suggestions?.length, toolUseId: opts.toolUseID });
    });

    const options: Options = {
      cwd: p.cwd,
      permissionMode: p.permissionMode,
      canUseTool,
      // Política padrão (policy.ts): comum roda direto, sensível vira o botão do canUseTool, em qualquer modo.
      hooks: { PreToolUse: [{ hooks: [policyHook] }] },
      abortController: abort,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: p.systemAppend },
      // Sem teto de custo por padrão (pedido do Danilo, 30/09/2026): só limita se alguém configurar.
      ...(p.maxBudgetUsd ? { maxBudgetUsd: p.maxBudgetUsd } : {}),
      stderr: (d) => { l.stderr.push(d); if (l.stderr.length > 40) l.stderr.shift(); },
      ...(p.isNew ? { sessionId: id } : { resume: id }),
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...(p.env ? { env: p.env } : {}),
      ...(p.mcpServers ? { mcpServers: p.mcpServers } : {}),
      ...(p.plugins?.length ? { plugins: p.plugins } : {}),
      ...(p.disallowedTools?.length ? { disallowedTools: p.disallowedTools } : {}),
      ...(p.outputStyle ? { settings: { outputStyle: p.outputStyle } } : {}),
    };

    let ok = false, cost = 0, turns = 0;
    // Acumula o texto/thinking parcial do streaming (deltas de 'stream_event') pra poder persistir
    // no evento 'interrupted' se o turno for abortado no meio de uma resposta ainda incompleta — sem
    // isso, esse texto se perde pra sempre ao recarregar a página: mensagens parciais nunca são
    // gravadas em claude_events (só a mensagem completa seria, e ela nunca chega quando o turno é
    // interrompido). Mesma lógica de reset/acúmulo do lado cliente (ver applyLive/pushMessage em
    // web/src/claude/live.ts), reimplementada aqui porque o servidor não vê os eventos que ele mesmo
    // emite.
    let partialText = '', partialThinking = '';
    try {
      // Sem anexos: mantém o prompt string (não muda o comportamento antigo).
      // Com anexos: monta UMA SDKUserMessage com [texto, ...imagens] e o texto ganha as notas dos arquivos.
      let promptArg: string | AsyncIterable<SDKUserMessage> = text;
      if (attachments.length) {
        const { blocks, textSuffix } = await attachmentBlocks(attachments);
        const content = [{ type: 'text', text: text + textSuffix }, ...blocks];
        const userMsg = { type: 'user', parent_tool_use_id: null, session_id: id, message: { role: 'user', content } } as unknown as SDKUserMessage;
        promptArg = (async function* () { yield userMsg; })();
      }
      const q = this.deps.queryFn({ prompt: promptArg, options });
      // Guardada em l.query (não só na variável local `q`) pra que setPermissionModeLive/setModelLive/
      // setEffortLive — chamados por uma rota HTTP a qualquer momento, fora deste for-await — consigam
      // achar a Query certa enquanto o turno está rodando. Limpa no finally, junto de l.abort.
      l.query = q as unknown as Query;
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'stream_event') {
          const se = (m.event ?? {}) as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } };
          if (se.type === 'message_start') { partialText = ''; partialThinking = ''; }
          else if (se.type === 'content_block_start') {
            if (se.content_block?.type === 'text') partialText = '';
            else if (se.content_block?.type === 'thinking') partialThinking = '';
          } else if (se.type === 'content_block_delta') {
            if (se.delta?.type === 'text_delta') partialText += se.delta.text ?? '';
            else if (se.delta?.type === 'thinking_delta') partialThinking += se.delta.thinking ?? '';
          }
          this.emit(id, { type: 'partial', event: m.event });
          continue;
        }
        if (m.type === 'system' && m.subtype === 'init') {
          await this.deps.store.updateSession(id, { model: m.model });
          // Lista real de comandos de barra (/clear, /compact, skills, comandos de projeto em
          // .claude/commands/*.md, etc.) — só existe depois que a Query começou; um fake de teste sem
          // controle (fakeQuery em runner.test.ts) não tem esse método, daí a checagem defensiva.
          // Fire-and-forget: não atrasa o processamento das mensagens do turno.
          const withCommands = q as unknown as Partial<Query>;
          if (typeof withCommands.supportedCommands === 'function') {
            withCommands.supportedCommands()
              .then(commands => { l.commands = commands; this.emit(id, { type: 'commands', commands }); })
              .catch(() => { /* melhor esforço: sem lista real, o front cai no fallback fixo */ });
          }
        }
        // Push do SDK quando a lista muda no meio da sessão (skill descoberta em subpasta, etc.) —
        // mesma forma (SlashCommand[]) do supportedCommands(), sem precisar pedir de novo.
        if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray((m as any).commands)) {
          l.commands = (m as any).commands;
          this.emit(id, { type: 'commands', commands: l.commands });
        }
        await this.deps.store.appendEvent(id, m.type, m);
        this.emit(id, { type: 'message', message: m });
        // Mensagem completa: mesmo reset que o lado cliente faz em pushMessage() ao ver 'assistant'/
        // 'result' — o que estava acumulado em partialText/partialThinking já virou (ou vai virar)
        // conteúdo definitivo dessa mensagem, não sobra parcial órfão pro próximo bloco.
        if (m.type === 'assistant' || m.type === 'result') { partialText = ''; partialThinking = ''; }
        if (m.type === 'result') { ok = !m.is_error; cost = m.total_cost_usd ?? 0; turns = m.num_turns ?? 0; if (m.is_error) l.stderr.push(m.subtype); }
      }
      await this.setStatus(id, ok ? 'idle' : 'error', { costUsd: cost, turns, lastError: ok ? null : (l.stderr.slice(-3).join('\n') || 'erro') });
      this.emit(id, { type: 'turn_end', costUsd: cost, turns, ok });
    } catch (e: any) {
      const interrupted = abort.signal.aborted;
      const msg = interrupted ? 'Interrompido pelo usuário' : `${e?.message ?? e}\n${l.stderr.slice(-5).join('\n')}`.trim();
      this.deps.log?.(`sessão ${id}: ${msg}`);
      if (interrupted) {
        // Stop manual do usuário: evento e persistência PRÓPRIOS ('interrupted'), nunca 'error' — ver
        // LiveEvent.interrupted e PARIDADE.md ("Mensagem interrompida", corrigido 28/09/2026). Carrega
        // o texto parcial já gerado (senão ele se perde ao recarregar) e se havia ferramenta pendente.
        const duringTool = l.stopHadPendingTool; l.stopHadPendingTool = false;
        await this.deps.store.appendEvent(id, 'interrupted', { message: msg, duringTool, partialText, partialThinking });
        this.emit(id, { type: 'interrupted', message: msg, duringTool, partialText, partialThinking });
      } else {
        await this.deps.store.appendEvent(id, 'error', { message: msg });
        this.emit(id, { type: 'error', message: msg });
      }
      await this.setStatus(id, interrupted ? 'idle' : 'error', { lastError: msg });
      this.emit(id, { type: 'turn_end', costUsd: cost, turns, ok: false });
    } finally {
      l.abort = null;
      l.query = null;
      for (const [pid, pend] of l.pending) { clearTimeout(pend.timer); l.pending.delete(pid); }
      const next = l.queue.shift();
      if (next) void this.run({ ...next, isNew: false });
    }
  }
}
