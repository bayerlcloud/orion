/**
 * Fronteira painel <-> motor de sessões (plano B1, tarefa T2). O painel (routes/claude.ts) só fala com
 * o Motor. Quem tem o Runner de verdade é o MotorLocal (mesmo processo, comportamento de hoje) e, em
 * T3, o MotorSocket (cliente do serviço orion-runner). Só dado simples cruza a fronteira (PedidoTurno,
 * ids, strings): o TurnParams carrega closures e MCPs em processo, por isso o Runner não é a fronteira.
 */
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Decision, LiveEvent, SessionStatus } from './runner.js';
import type { PedidoTurno } from './montarTurno.js';

/** Opções com control method no SDK, trocáveis no meio do turno (rotas /mode, /model, /effort, /output-style). */
export type CampoAoVivo = 'mode' | 'model' | 'effort' | 'outputStyle';

export interface Motor {
  /** Monta e começa (ou enfileira) um turno. `queued`: a sessão já não estava ociosa depois do pedido (contrato do POST /messages). */
  iniciarTurno(p: PedidoTurno): Promise<{ queued: boolean }>;
  parar(id: string): Promise<void>;
  decidir(id: string, approvalId: string, decision: Exclude<Decision, 'timeout'>, decidedBy: number | null, message?: string): Promise<boolean>;
  /** Aplica ao vivo; true quando havia Query viva pra receber. A persistência fica na rota, antes da chamada. */
  aoVivo(id: string, campo: CampoAoVivo, valor: string | null | undefined): Promise<boolean>;
  /** Síncronos: no socket saem de um espelho em memória alimentado pelo stream global. */
  status(id: string): SessionStatus;
  pendentes(id: string): { id: string; toolName: string }[];
  /** Assíncrono de propósito: a lista pesa 150 a 350 KB e no socket vai por pedido, não pelo stream. */
  comandos(id: string): Promise<SlashCommand[]>;
  assinar(id: string, fn: (e: LiveEvent) => void): () => void;
  /** Local: sempre true. Socket: stream /eventos aberto. */
  online(): boolean;
}
