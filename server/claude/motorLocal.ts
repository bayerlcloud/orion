import type { Pool } from 'pg';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Decision, LiveEvent, Runner, SessionStatus, TurnParams } from './runner.js';
import type { FilaIntegracao } from '../integracao/fila.js';
import { montarTurno, type PedidoTurno } from './montarTurno.js';
import type { CampoAoVivo, Motor } from './motor.js';

/**
 * Motor no mesmo processo do Runner (ORION_RUNNER ausente ou 'local'): delega 1:1. É exatamente o
 * caminho que routes/claude.ts fazia direto no runner antes do plano B1; só mudou de lugar.
 */
export class MotorLocal implements Motor {
  constructor(private d: { runner: Runner; pool: Pool; fila: FilaIntegracao; log: (m: string) => void }) {}

  /**
   * Dispara um turno numa sessão (mensagem nova, sessão nova ou retomada pós-restart): a montagem do
   * TurnParams está em montarTurno.ts; aqui só o que precisa do runner (avisos) e o startTurn.
   */
  async iniciarTurno(o: PedidoTurno): Promise<{ queued: boolean }> {
    const { runner, pool, fila, log } = this.d;
    const params = await montarTurno(pool, fila, o, { registrar: (texto) => { runner.aviso(o.sessionId, texto); }, log });
    if (o.avisoPasta) runner.aviso(o.sessionId, o.avisoPasta);
    if (!o.isNew) {
      // Duas sessões da mesma pessoa no projeto dividem a worktree dela: avisa quando a outra está rodando.
      const { rows: paralelas } = await pool.query<{ title: string }>(
        `SELECT title FROM claude_sessions WHERE cwd = $1 AND id <> $2 AND status = 'running' LIMIT 3`, [params.cwd, o.sessionId]);
      if (paralelas.length) runner.aviso(o.sessionId, `Atenção: ${paralelas.map(p => `"${p.title}"`).join(', ')} está rodando agora na mesma pasta. As duas sessões mexem nos mesmos arquivos.`);
    }
    runner.startTurn(params);
    // Mesma conta que o POST /messages fazia depois do startTurn.
    return { queued: runner.status(o.sessionId) !== 'idle' };
  }

  parar(id: string): Promise<void> { return this.d.runner.stop(id); }

  decidir(id: string, approvalId: string, decision: Exclude<Decision, 'timeout'>, decidedBy: number | null, message?: string): Promise<boolean> {
    return this.d.runner.decide(id, approvalId, decision, decidedBy, message);
  }

  aoVivo(id: string, campo: CampoAoVivo, valor: string | null | undefined): Promise<boolean> {
    const r = this.d.runner;
    switch (campo) {
      case 'mode': return r.setPermissionModeLive(id, valor as TurnParams['permissionMode']);
      case 'model': return r.setModelLive(id, valor ?? undefined);
      case 'effort': return r.setEffortLive(id, (valor ?? undefined) as TurnParams['effort']);
      case 'outputStyle': return r.setOutputStyleLive(id, valor ?? null);
    }
  }

  status(id: string): SessionStatus { return this.d.runner.status(id); }
  pendentes(id: string): { id: string; toolName: string }[] { return this.d.runner.pendingPermissions(id); }
  async comandos(id: string): Promise<SlashCommand[]> { return this.d.runner.commandsFor(id); }
  assinar(id: string, fn: (e: LiveEvent) => void): () => void { return this.d.runner.subscribe(id, fn); }
  online(): boolean { return true; }
}
