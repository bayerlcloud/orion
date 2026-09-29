/**
 * API do botão Deploy. GET mostra main x no ar, o build atual, o pedido na fila e o histórico;
 * POST (só owner) escreve o pedido; o systemd (orion-deploy.path) constrói e publica.
 * Trigger sem sudo: o painel roda com NoNewPrivileges, então não escala; só deixa um arquivo.
 */
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  BUILDS_DIR, escreverPedido, lerHistorico, lerStatus, limparPor, nomeDeBuildValido, pedidoPendente, tailDoLog, validarRef, versaoNoAr,
} from '../deploy/estado.js';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile('git', ['-c', 'safe.directory=*', ...args], { cwd, timeout: 10_000 }, (err, out) => resolve(err ? '' : String(out).trim())));
}

export async function deployRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.get('/api/deploy', async () => {
    const [mainLine, atual, historico, pedido, noAr] = await Promise.all([
      git(app.repoDir, ['log', '-1', '--format=%h|%cs|%s', 'main']),
      lerStatus(), lerHistorico(), pedidoPendente(), versaoNoAr(),
    ]);
    const [sha = '', data = '', ...resto] = mainLine.split('|');
    return {
      main: { sha, data, msg: resto.join('|') },
      no_ar: noAr,
      atual, pedido, historico,
      // "ativo" = tem build em andamento ou pedido esperando: a UI usa para pollar o log.
      ativo: !!pedido || atual?.estado === 'fila' || atual?.estado === 'rodando',
    };
  });

  app.get<{ Querystring: { nome?: string; n?: string } }>('/api/deploy/log', async (req, reply) => {
    const n = Math.min(Math.max(Number(req.query.n) || 200, 20), 2000);
    let arquivo: string;
    if (req.query.nome) {
      if (!nomeDeBuildValido(req.query.nome)) return reply.code(400).send({ error: 'nome de build inválido' });
      arquivo = path.join(BUILDS_DIR, `${req.query.nome}.log`);
    } else {
      const s = await lerStatus();
      if (!s?.log) return { log: '' };
      arquivo = s.log;
    }
    return { log: await tailDoLog(arquivo, n) };
  });

  app.post<{ Body: { ref?: string } }>('/api/deploy', async (req, reply) => {
    if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin publica' });
    const ref = validarRef(req.body?.ref);
    if (!ref) return reply.code(400).send({ error: 'ref precisa ser "main" ou um sha' });
    const pedido = await pedidoPendente();
    if (pedido) return reply.code(409).send({ error: `já existe um pedido na fila (${pedido.ref}, por ${pedido.por}); espere ele começar` });
    try {
      await escreverPedido(ref, limparPor(req.user!.name));
    } catch (e: any) {
      return reply.code(500).send({ error: `não consegui escrever o pedido em ${BUILDS_DIR}: ${e?.message ?? e}` });
    }
    app.log.info(`deploy pedido por ${req.user!.email}: ${ref}`);
    return { ok: true, ref, aviso: 'pedido escrito; o build começa em segundos (ou entra na fila se já houver um rodando)' };
  });
}
