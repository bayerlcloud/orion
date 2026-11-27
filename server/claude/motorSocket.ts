/**
 * Motor do painel em modo ORION_RUNNER=socket (plano B1, T3): cliente HTTP do orion-runner pelo socket
 * unix (motorServidor.ts), só stdlib. O estado síncrono (status/pendentes/vivas) sai de um espelho em
 * memória alimentado pelo stream global GET /eventos; o hello de cada (re)conexão substitui o espelho
 * inteiro e chama `aoReconectar` (o painel fecha os SSE abertos e os navegadores recarregam pelo GET).
 */
import http from 'node:http';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Decision, LiveEvent, SessionStatus } from './runner.js';
import type { PedidoTurno } from './montarTurno.js';
import type { CampoAoVivo, Motor } from './motor.js';

/** Runner fora (socket sem ninguém escutando, conexão caiu): as rotas de escrita do painel respondem 503. */
export class MotorIndisponivel extends Error {
  constructor(detalhe: string) { super(`motor de sessões indisponível: ${detalhe}`); this.name = 'MotorIndisponivel'; }
}

type Pendente = { id: string; toolName: string };
type Espelho = { status: SessionStatus; pending: Pendente[] };
type Linha = { type: 'hello'; pid: number; iniciadoEm: string; sessoes: ({ id: string } & Espelho)[] } | { type: 'hb' } | { sessionId: string; event: LiveEvent };

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;
const CHAMADA_TIMEOUT_MS = 60_000;

export class MotorSocket implements Motor {
  private espelho = new Map<string, Espelho>();
  private assinantes = new Map<string, Set<(e: LiveEvent) => void>>();
  private globais = new Set<(sessionId: string, e: LiveEvent) => void>();
  private aberto = false;
  private fechado = false;
  private backoff = BACKOFF_MIN_MS;
  private stream: http.ClientRequest | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private o: { sock: string; log: (m: string) => void; aoReconectar?: () => void }) { this.ligar(); }

  // ---- stream global ----
  private ligar() {
    if (this.fechado) return;
    let resto = '';
    const req = http.request({ socketPath: this.o.sock, path: '/eventos', method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); req.destroy(new Error(`HTTP ${res.statusCode}`)); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        resto += chunk;
        let i: number;
        while ((i = resto.indexOf('\n')) >= 0) {
          const bruto = resto.slice(0, i); resto = resto.slice(i + 1);
          if (!bruto) continue;
          let l: Linha;
          try { l = JSON.parse(bruto) as Linha; } catch { this.o.log(`motor de sessões: linha inválida no stream: ${bruto.slice(0, 120)}`); continue; }
          this.receber(l);
        }
      });
    });
    req.on('error', (e) => this.caiu(req, e.message));
    req.on('close', () => this.caiu(req, 'stream fechado'));
    req.end();
    this.stream = req;
  }

  private caiu(req: http.ClientRequest, motivo: string) {
    if (this.stream !== req) return; // já tratado (error + close do mesmo stream) ou stream velho
    this.stream = null;
    if (this.aberto) this.o.log(`motor de sessões: ${motivo}; reconectando`);
    this.aberto = false;
    if (this.fechado) return;
    this.timer = setTimeout(() => this.ligar(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private receber(l: Linha) {
    if ('type' in l && l.type === 'hb') return;
    if ('type' in l && l.type === 'hello') {
      this.espelho = new Map(l.sessoes.map(s => [s.id, { status: s.status, pending: s.pending }]));
      this.aberto = true;
      this.backoff = BACKOFF_MIN_MS;
      this.o.log(`motor de sessões conectado (pid ${l.pid}, ${l.sessoes.length} sessão(ões) viva(s))`);
      // Também no primeiro hello: se o painel subiu com o runner fora, as abas já abertas recarregam agora.
      this.o.aoReconectar?.();
      return;
    }
    const { sessionId, event } = l;
    const e = this.espelho.get(sessionId) ?? { status: 'idle', pending: [] };
    this.espelho.set(sessionId, e);
    if (event.type === 'status') e.status = event.status;
    else if (event.type === 'permission_request') e.pending.push({ id: event.id, toolName: event.toolName });
    else if (event.type === 'permission_resolved') e.pending = e.pending.filter(p => p.id !== event.id);
    else if (event.type === 'turn_end') e.pending = [];
    for (const fn of this.assinantes.get(sessionId) ?? []) { try { fn(event); } catch { /* assinante morto */ } }
    for (const fn of this.globais) { try { fn(sessionId, event); } catch { /* assinante morto */ } }
  }

  /** Encerra o stream e o laço de reconexão (testes; o painel vive enquanto o processo vive). */
  fechar() {
    this.fechado = true;
    if (this.timer) clearTimeout(this.timer);
    this.stream?.destroy();
    this.stream = null; this.aberto = false;
  }

  // ---- chamadas ----
  private chamar<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    return new Promise((resolve, reject) => {
      const dados = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ socketPath: this.o.sock, path, method, headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {} }, (res) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json: T;
          try { json = (texto ? JSON.parse(texto) : {}) as T; } catch { reject(new Error(`resposta inválida do motor em ${path}: ${texto.slice(0, 200)}`)); return; }
          if ((res.statusCode ?? 500) >= 500) { reject(new Error(`motor de sessões falhou em ${path}: ${(json as { message?: string; error?: string }).message ?? (json as { error?: string }).error ?? res.statusCode}`)); return; }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', reject);
      });
      req.setTimeout(CHAMADA_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      // Socket sem ninguém (ENOENT/ECONNREFUSED) ou conexão cortada no meio: o runner está fora ou reiniciando.
      req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE' ? new MotorIndisponivel(e.message) : e));
      req.end(dados);
    });
  }

  async iniciarTurno(p: PedidoTurno): Promise<{ queued: boolean }> {
    const { sessionId, ...corpo } = p;
    const { json } = await this.chamar<{ queued: boolean }>('POST', `/sessoes/${encodeURIComponent(sessionId)}/turno`, corpo);
    return { queued: json.queued };
  }

  async parar(id: string): Promise<void> { await this.chamar('POST', `/sessoes/${encodeURIComponent(id)}/parar`); }

  async decidir(id: string, approvalId: string, decision: Exclude<Decision, 'timeout'>, decidedBy: number | null, message?: string): Promise<boolean> {
    const { status } = await this.chamar('POST', `/sessoes/${encodeURIComponent(id)}/decisao`, { approvalId, decision, decidedBy, message });
    return status !== 404;
  }

  async aoVivo(id: string, campo: CampoAoVivo, valor: string | null | undefined): Promise<boolean> {
    const { json } = await this.chamar<{ live: boolean }>('POST', `/sessoes/${encodeURIComponent(id)}/ao-vivo`, { campo, valor: valor ?? null });
    return json.live;
  }

  async comandos(id: string): Promise<SlashCommand[]> {
    const { json } = await this.chamar<{ commands: SlashCommand[] }>('GET', `/sessoes/${encodeURIComponent(id)}/comandos`);
    return json.commands;
  }

  // ---- espelho ----
  status(id: string): SessionStatus { return this.espelho.get(id)?.status ?? 'idle'; }
  pendentes(id: string): Pendente[] { return this.espelho.get(id)?.pending ?? []; }
  vivas() { return [...this.espelho.entries()].map(([id, e]) => ({ id, status: e.status, pending: e.pending })); }

  assinar(id: string, fn: (e: LiveEvent) => void): () => void {
    let s = this.assinantes.get(id);
    if (!s) { s = new Set(); this.assinantes.set(id, s); }
    s.add(fn);
    return () => { s!.delete(fn); if (!s!.size) this.assinantes.delete(id); };
  }

  assinarTudo(fn: (sessionId: string, e: LiveEvent) => void): () => void {
    this.globais.add(fn);
    return () => { this.globais.delete(fn); };
  }

  online(): boolean { return this.aberto; }
}
