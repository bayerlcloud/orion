/**
 * orion-runner: motor das sessões do Claude em serviço próprio (plano B1, T3). Hospeda o Runner (SDK,
 * permissões, ganchos, retomada, vigia) e o expõe pelo socket unix ORION_RUNNER_SOCK (motorServidor.ts).
 * O painel (orion-central) em ORION_RUNNER=socket fala com ele pelo MotorSocket, então um deploy do painel
 * não corta turno nenhum. Precedente: server/wa/main.ts.
 *
 * Enquanto a flag NÃO é 'socket' (deploy 1, antes da virada), o painel local é o dono das sessões: este
 * processo fica OCIOSO servindo só /saude. Se hospedasse o motor, pararia os scopes orion-sessao-* do
 * painel no boot (matando as sessões vivas) e rodaria retomada e vigia em paralelo com ele.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as dormir } from 'node:timers/promises';
import { createPool } from './db.js';
import { hospedarMotor } from './claude/hospedarMotor.js';
import { criarServidorMotor } from './claude/motorServidor.js';

/** Mesmo central.env do painel: só com ORION_RUNNER=socket este processo é o dono das sessões. */
export function modoDoRunner(env: NodeJS.ProcessEnv): 'socket' | 'ocioso' {
  return env.ORION_RUNNER === 'socket' ? 'socket' : 'ocioso';
}

export type DepsRunner = {
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  logger?: boolean;
  /** Injetáveis nos testes: nem pool nem motor podem nascer no modo ocioso. */
  hospedar?: typeof hospedarMotor;
  criarPool?: typeof createPool;
};

/** Monta o Fastify do runner (não escuta): ocioso = só /saude; socket = banco, motor hospedado e rotas do motor. */
export async function montarRunner(d: DepsRunner = {}): Promise<FastifyInstance> {
  const env = d.env ?? process.env;
  const log = d.log ?? ((m: string) => console.warn(m));
  if (modoDoRunner(env) === 'ocioso') {
    log('ORION_RUNNER não é socket: o painel é dono das sessões; runner ocioso até a virada (restart)');
    const app = Fastify({ logger: d.logger ?? false });
    const iniciadoEm = new Date().toISOString();
    app.get('/saude', async () => ({ ok: true, ocioso: true, pid: process.pid, iniciadoEm }));
    return app;
  }
  const pool = (d.criarPool ?? createPool)();
  // Quem migra é o painel; aqui só espera (até 60 s) a tabela existir, pra subir junto no boot da máquina.
  for (let i = 0; ; i++) {
    try { await pool.query('SELECT 1 FROM claude_sessions'); break; }
    catch (e) {
      if (i >= 59) throw new Error(`banco sem claude_sessions depois de 60 s: ${(e as Error).message}`);
      await dormir(1000);
    }
  }
  // hospedarMotor para os scopes orion-sessao-* no boot e no SIGTERM (e sai), retoma turnos cortados e liga o vigia.
  const { motor } = await (d.hospedar ?? hospedarMotor)({ pool, log });
  return criarServidorMotor(motor, { logger: d.logger ?? false, log });
}

async function main() {
  const sock = process.env.ORION_RUNNER_SOCK ?? '/run/orion/runner.sock';
  // O log é o pino do Fastify (mesmo formato do painel), mas o Fastify só existe depois do motor: antes disso, console.
  let app: FastifyInstance | undefined;
  const log = (m: string) => { if (app) app.log.warn(m); else console.warn(m); };
  process.on('unhandledRejection', (e) => { if (app) app.log.error({ err: e }, 'rejeição não tratada'); else console.error(e); });

  app = await montarRunner({ log, logger: true });
  const pasta = path.dirname(sock);
  await mkdir(pasta, { recursive: true }).catch((e: Error) => { throw new Error(`não consegui criar ${pasta} para o socket (${e.message}); fora do systemd, aponte ORION_RUNNER_SOCK para uma pasta sua`); });
  await unlink(sock).catch(() => {}); // socket órfão de um processo que morreu sem limpar
  await app.listen({ path: sock });
  await chmod(sock, 0o660); // o painel (grupo orion) fala; mais ninguém
  app.log.info(`motor de sessões (${modoDoRunner(process.env)}) ouvindo em ${sock}`);
}

if (process.argv[1]?.endsWith('/runnerMain.js')) main().catch((e) => { console.error(e); process.exit(1); });
