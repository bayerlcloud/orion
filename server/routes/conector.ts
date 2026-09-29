import type { FastifyInstance } from 'fastify';
import { bloqueadoNoConector, contaDoConector, ehPedidoLocal, listarContasCloudflare } from '../tools/cloudflareAccounts.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Proxy local dos conectores simples: a sessão chama /conector/<nome>/<caminho da API v4> sem token e o Orion
 *  injeta o Bearer da conta. Não tem login: só aceita pedido direto em loopback (o que vem pelo Caddy traz
 *  X-Forwarded-For e é recusado). Quem já roda na c3 tem esse poder de qualquer forma; o token é o que não vaza. */
export async function conectorRoutes(app: FastifyInstance) {
  app.route<{ Params: { nome: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/conector/:nome/*',
    handler: async (req, reply) => {
      if (!ehPedidoLocal(req.socket.remoteAddress, req.headers['x-forwarded-for'])) return reply.code(403).send({ error: 'o conector só aceita chamadas locais (de dentro da c3)' });
      const conta = contaDoConector(req.params.nome, await listarContasCloudflare(app.pool));
      if (!conta) return reply.code(404).send({ error: `conector ${req.params.nome} não existe; veja a aba Tools › Conectores` });
      const caminho = req.params['*'];
      if (bloqueadoNoConector(req.method, caminho)) return reply.code(403).send({ error: 'apagar zona ou projeto Pages inteiro é bloqueado no conector; faça no painel da Cloudflare' });
      const url = req.raw.url ?? '';
      const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      const temCorpo = req.method !== 'GET' && req.body !== undefined && req.body !== null;
      const r = await fetch(`${CF_API}/${caminho}${qs}`, {
        method: req.method,
        headers: { Authorization: `Bearer ${conta.token}`, ...(temCorpo ? { 'Content-Type': 'application/json' } : {}) },
        body: temCorpo ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined,
      });
      return reply.code(r.status).header('content-type', r.headers.get('content-type') ?? 'application/json').send(await r.text());
    },
  });
}
