/**
 * Lado servidor do socket do orion-runner (plano B1, T3): expõe um Motor por HTTP num socket unix. Sem
 * auth de propósito: o socket nasce 0660 danilo:orion (unit orion-runner.service). Quem chama é o
 * MotorSocket do painel (motorSocket.ts). `criarServidorMotor` só monta o Fastify; quem escuta é o
 * runnerMain (socket real) ou o teste (socket em mkdtemp).
 */
import Fastify from 'fastify';
import type { Decision } from './runner.js';
import type { CampoAoVivo, Motor } from './motor.js';
import type { PedidoTurno } from './montarTurno.js';
import { enxugarEventoAoVivo } from '../tools/leveza.js';

/** Bytes pendentes no stream /eventos antes de derrubar a conexão; o painel reconecta e recarrega pelo hello. */
export const EVENTOS_BUFFER_MAX = 16 * 1024 * 1024;

type Id = { Params: { id: string } };

export function criarServidorMotor(motor: Motor, opts: { logger?: boolean; log?: (m: string) => void } = {}) {
  // forceCloseConnections: o /eventos é um stream aberto pra sempre; sem isso app.close() esperaria ele fechar.
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });
  const iniciadoEm = new Date().toISOString();
  const log = opts.log ?? (() => {});

  app.get('/saude', async () => ({ ok: true, pid: process.pid, iniciadoEm, vivas: motor.vivas().length }));

  // Stream global NDJSON: hello com o estado de todas as sessões vivas, depois {sessionId, event}, hb a cada 15 s.
  app.get('/eventos', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const linha = (o: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if ((res.socket?.writableLength ?? 0) > EVENTOS_BUFFER_MAX) { log('stream /eventos com mais de 16 MB pendentes; derrubando pro painel reconectar'); res.destroy(); return; }
      res.write(`${JSON.stringify(o)}\n`);
    };
    // vivas() e assinarTudo() são síncronos e seguidos: nenhum evento escapa entre o hello e a assinatura.
    linha({ type: 'hello', pid: process.pid, iniciadoEm, sessoes: motor.vivas() });
    // Mesmo recorte do SSE do painel (routes/claude.ts): sem a cópia do tool_result nem o workflow_progress de 272 KB.
    const unsub = motor.assinarTudo((sessionId, event) => linha({ sessionId, event: enxugarEventoAoVivo(event) }));
    const hb = setInterval(() => linha({ type: 'hb' }), 15_000);
    req.raw.on('close', () => { clearInterval(hb); unsub(); });
  });

  app.post<Id & { Body: Omit<PedidoTurno, 'sessionId'> }>('/sessoes/:id/turno', async (req) => {
    const { queued } = await motor.iniciarTurno({ ...req.body, sessionId: req.params.id });
    return { ok: true, queued };
  });

  app.post<Id>('/sessoes/:id/parar', async (req) => { await motor.parar(req.params.id); return { ok: true }; });

  app.post<Id & { Body: { approvalId: string; decision: Exclude<Decision, 'timeout'>; decidedBy: number | null; message?: string } }>('/sessoes/:id/decisao', async (req, reply) => {
    const b = req.body;
    const ok = await motor.decidir(req.params.id, b.approvalId, b.decision, b.decidedBy ?? null, b.message);
    if (!ok) return reply.code(404).send({ error: 'pedido de permissão não está pendente' });
    return { ok: true };
  });

  app.post<Id & { Body: { campo: CampoAoVivo; valor: string | null | undefined } }>('/sessoes/:id/ao-vivo', async (req) => ({
    live: await motor.aoVivo(req.params.id, req.body.campo, req.body.valor),
  }));

  app.get<Id>('/sessoes/:id/comandos', async (req) => ({ commands: await motor.comandos(req.params.id) }));

  app.get<Id>('/sessoes/:id', async (req) => ({ status: motor.status(req.params.id), pending: motor.pendentes(req.params.id) }));

  return app;
}
