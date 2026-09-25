import { randomUUID } from 'node:crypto';
import type { Options, PermissionResult, PermissionUpdate, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Evento vivo enviado aos assinantes (SSE) e, quando persistente, gravado no banco. */
export type LiveEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'message'; message: SDKMessage }
  | { type: 'partial'; event: unknown }
  | { type: 'permission_request'; id: string; toolName: string; input: Record<string, unknown>; hasSuggestions: boolean }
  | { type: 'permission_resolved'; id: string; decision: Decision }
  | { type: 'error'; message: string }
  | { type: 'turn_end'; costUsd: number; turns: number; ok: boolean };

export type SessionStatus = 'running' | 'waiting' | 'idle' | 'error';
export type Decision = 'allow' | 'allow_always' | 'deny' | 'timeout';

export interface Store {
  appendEvent(sessionId: string, type: string, payload: unknown): Promise<void>;
  updateSession(sessionId: string, patch: { status?: SessionStatus; costUsd?: number; turns?: number; lastError?: string | null; model?: string | null }): Promise<void>;
  createApproval(a: { id: string; sessionId: string; toolName: string; input: unknown }): Promise<void>;
  decideApproval(id: string, decision: Decision, decidedBy: number | null): Promise<void>;
}

export type QueryFn = (params: { prompt: string; options?: Options }) => Query | AsyncIterable<SDKMessage>;

export type TurnParams = {
  sessionId: string;
  cwd: string;
  prompt: string;
  isNew: boolean;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'auto';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  systemAppend: string;
  maxBudgetUsd?: number;
};

type Pending = { resolve: (r: PermissionResult) => void; suggestions?: PermissionUpdate[]; timer: NodeJS.Timeout; toolName: string };

type Live = {
  status: SessionStatus;
  abort: AbortController | null;
  subscribers: Set<(e: LiveEvent) => void>;
  pending: Map<string, Pending>;
  queue: TurnParams[];
  stderr: string[];
};

export class Runner {
  private live = new Map<string, Live>();
  constructor(private deps: { queryFn: QueryFn; store: Store; permissionTimeoutMs?: number; log?: (msg: string) => void }) {}

  private get(id: string): Live {
    let l = this.live.get(id);
    if (!l) { l = { status: 'idle', abort: null, subscribers: new Set(), pending: new Map(), queue: [], stderr: [] }; this.live.set(id, l); }
    return l;
  }

  status(id: string): SessionStatus { return this.live.get(id)?.status ?? 'idle'; }
  pendingPermissions(id: string): { id: string; toolName: string }[] {
    return [...(this.live.get(id)?.pending ?? new Map()).entries()].map(([pid, p]) => ({ id: pid, toolName: p.toolName }));
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
    for (const [pid, p] of l.pending) { clearTimeout(p.timer); p.resolve({ behavior: 'deny', message: 'Sessão interrompida pelo usuário', interrupt: true }); l.pending.delete(pid); this.emit(id, { type: 'permission_resolved', id: pid, decision: 'deny' }); }
    l.abort?.abort();
  }

  async decide(sessionId: string, approvalId: string, decision: Exclude<Decision, 'timeout'>, decidedBy: number | null, message?: string): Promise<boolean> {
    const l = this.get(sessionId);
    const p = l.pending.get(approvalId);
    if (!p) return false;
    clearTimeout(p.timer); l.pending.delete(approvalId);
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: message?.trim() || 'Negado pelo usuário no painel Orion' });
    else p.resolve({ behavior: 'allow', ...(decision === 'allow_always' && p.suggestions ? { updatedPermissions: p.suggestions } : {}) });
    await this.deps.store.decideApproval(approvalId, decision, decidedBy);
    await this.deps.store.appendEvent(sessionId, 'permission_resolved', { id: approvalId, decision, message: message ?? null });
    this.emit(sessionId, { type: 'permission_resolved', id: approvalId, decision });
    if (l.pending.size === 0 && l.status === 'waiting') await this.setStatus(sessionId, 'running');
    return true;
  }

  private async run(p: TurnParams): Promise<void> {
    const id = p.sessionId;
    const l = this.get(id);
    const abort = new AbortController();
    l.abort = abort; l.stderr = [];
    await this.setStatus(id, 'running', { lastError: null });
    await this.deps.store.appendEvent(id, 'user_prompt', { prompt: p.prompt });
    this.emit(id, { type: 'message', message: { type: 'user', message: { role: 'user', content: p.prompt }, parent_tool_use_id: null, session_id: id } as SDKMessage });

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
      l.pending.set(pid, { resolve, suggestions: opts.suggestions, timer, toolName });
      void this.deps.store.createApproval({ id: pid, sessionId: id, toolName, input });
      void this.deps.store.appendEvent(id, 'permission_request', { id: pid, toolName, input });
      void this.setStatus(id, 'waiting');
      this.emit(id, { type: 'permission_request', id: pid, toolName, input, hasSuggestions: !!opts.suggestions?.length });
    });

    const options: Options = {
      cwd: p.cwd,
      permissionMode: p.permissionMode,
      canUseTool,
      abortController: abort,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: p.systemAppend },
      maxBudgetUsd: p.maxBudgetUsd ?? 5,
      stderr: (d) => { l.stderr.push(d); if (l.stderr.length > 40) l.stderr.shift(); },
      ...(p.isNew ? { sessionId: id } : { resume: id }),
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
    };

    let ok = false, cost = 0, turns = 0;
    try {
      const q = this.deps.queryFn({ prompt: p.prompt, options });
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'stream_event') { this.emit(id, { type: 'partial', event: m.event }); continue; }
        if (m.type === 'system' && m.subtype === 'init') await this.deps.store.updateSession(id, { model: m.model });
        await this.deps.store.appendEvent(id, m.type, m);
        this.emit(id, { type: 'message', message: m });
        if (m.type === 'result') { ok = !m.is_error; cost = m.total_cost_usd ?? 0; turns = m.num_turns ?? 0; if (m.is_error) l.stderr.push(m.subtype); }
      }
      await this.setStatus(id, ok ? 'idle' : 'error', { costUsd: cost, turns, lastError: ok ? null : (l.stderr.slice(-3).join('\n') || 'erro') });
      this.emit(id, { type: 'turn_end', costUsd: cost, turns, ok });
    } catch (e: any) {
      const msg = abort.signal.aborted ? 'Interrompido pelo usuário' : `${e?.message ?? e}\n${l.stderr.slice(-5).join('\n')}`.trim();
      this.deps.log?.(`sessão ${id}: ${msg}`);
      await this.deps.store.appendEvent(id, 'error', { message: msg });
      this.emit(id, { type: 'error', message: msg });
      await this.setStatus(id, abort.signal.aborted ? 'idle' : 'error', { lastError: msg });
      this.emit(id, { type: 'turn_end', costUsd: cost, turns, ok: false });
    } finally {
      l.abort = null;
      for (const [pid, pend] of l.pending) { clearTimeout(pend.timer); l.pending.delete(pid); }
      const next = l.queue.shift();
      if (next) void this.run({ ...next, isNew: false });
    }
  }
}
