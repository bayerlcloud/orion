/**
 * Hospeda o motor de sessões (plano B1, T2): tudo que SÓ pode rodar no processo que tem o Runner.
 * Hoje é o painel (ORION_RUNNER ausente ou 'local'); em T3 passa a ser o serviço orion-runner, e o
 * painel em modo socket NÃO chama isto (senão pararia os scopes das sessões do runner a cada deploy).
 */
import type { Pool } from 'pg';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Runner, type QueryFn } from './runner.js';
import { pgStore } from './store.js';
import { envDoGerente, envStrings, pararScopes as pararScopesReal } from './isolamento.js';
import { MotorLocal } from './motorLocal.js';
import { iniciarRetomada } from './retomada.js';
import { FilaIntegracao } from '../integracao/fila.js';
import { sdkFalso } from './sdkFalso.js';

export type OpcoesHospedagem = {
  pool: Pool;
  log: (m: string) => void;
  /** Só pra teste: SDK falso no lugar do query() real (sem ele, ORION_SDK_FALSO=1 liga o sdkFalso.ts). */
  queryFn?: QueryFn;
  /** Só pra teste: não chamar o systemctl de verdade. */
  pararScopes?: typeof pararScopesReal;
};

export async function hospedarMotor(o: OpcoesHospedagem): Promise<{ motor: MotorLocal; fechar(): Promise<void> }> {
  const pararScopes = o.pararScopes ?? pararScopesReal;
  // SDK falso (sdkFalso.ts): eco sem token, só pra testar o painel. No ar nunca liga sem querer: com
  // NODE_ENV=production exige ORION_SDK_FALSO_PERMITIDO=1, e a recusa derruba o boot com a causa clara.
  let queryFn = o.queryFn;
  if (!queryFn && process.env.ORION_SDK_FALSO === '1') {
    if (process.env.NODE_ENV === 'production' && process.env.ORION_SDK_FALSO_PERMITIDO !== '1') throw new Error('ORION_SDK_FALSO=1 em produção: recusado (sem ORION_SDK_FALSO_PERMITIDO=1 as sessões responderiam eco em vez do claude)');
    o.log('motor: SDK FALSO ligado (sem tokens)');
    queryFn = sdkFalso;
  }
  // Os claude das sessões vivem em scopes do gerente de usuário (isolamento.ts), fora deste serviço: um
  // restart não os mata mais, e seguiriam o turno com o stdin fechado, sem ninguém ouvindo. Boot cobre
  // crash sem handler; SIGTERM cobre o deploy. Antes da retomada, que religa os turnos cortados.
  const envGerente = envDoGerente(envStrings(), process.getuid?.() ?? 0);
  const pararSessoes = () => pararScopes('orion-sessao-*', envGerente, o.log);
  await pararSessoes();
  const aoTerm = () => { void pararSessoes().finally(() => process.exit(0)); };
  process.once('SIGTERM', aoTerm);

  const store = pgStore(o.pool);
  const runner = new Runner({ queryFn: queryFn ?? query, store, log: o.log });
  const motor = new MotorLocal({ runner, pool: o.pool, fila: new FilaIntegracao(), log: o.log });
  const retomada = await iniciarRetomada({ pool: o.pool, motor, store, log: o.log });
  return {
    motor,
    async fechar() { retomada.fechar(); process.removeListener('SIGTERM', aoTerm); },
  };
}
