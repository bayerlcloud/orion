import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { GITHUB_MCP_UPSTREAM, listarContasGithub, nomeMcpGithub } from '../tools/githubAccounts.js';
import { bloqueadoNaEvolution, evolutionConfig, NOME_CONECTOR_EVOLUTION, NOME_CONECTOR_WHATSAPP, WA_TOKEN_ORION, urlGatewayLocal } from '../tools/evolution.js';
import { getSetting } from '../settings.js';
import { bloqueadoNoHttp, listarConectoresHttp } from '../tools/conectoresHttp.js';
import { bloqueadoNoConector, contaDoConector, ehPedidoLocal, listarContasCloudflare } from '../tools/cloudflareAccounts.js';
import { bloqueadoNoConectorGcp, contaDoConectorGcp, googleAccessTokenDe, listarContasGoogleCloud } from '../tools/googleCloudAccounts.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Proxy local dos conectores simples: a sessão chama /conector/<nome>/<caminho da API> sem token e o Orion
 *  injeta o Bearer da conta (ou a apikey, na Evolution). Não tem login: só aceita pedido direto em loopback (o que vem pelo Caddy traz
 *  X-Forwarded-For e é recusado). Quem já roda na c3 tem esse poder de qualquer forma; o token é o que não vaza. */
export async function conectorRoutes(app: FastifyInstance) {
  app.route<{ Params: { nome: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/conector/:nome/*',
    handler: async (req, reply) => {
      if (!ehPedidoLocal(req.socket.remoteAddress, req.headers['x-forwarded-for'])) return reply.code(403).send({ error: 'o conector só aceita chamadas locais (de dentro da c3)' });
      const url = req.raw.url ?? '';
      const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      const temCorpo = req.method !== 'GET' && req.body !== undefined && req.body !== null;
      const corpo = temCorpo ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined;
      const repassar = async (destino: string, headers: Record<string, string>) => {
        const r = await fetch(destino, { method: req.method, headers: { ...headers, ...(temCorpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo });
        return reply.code(r.status).header('content-type', r.headers.get('content-type') ?? 'application/json').send(await r.text());
      };
      if (req.params.nome === NOME_CONECTOR_EVOLUTION) {
        const evo = await evolutionConfig(app.pool);
        if (!evo) return reply.code(404).send({ error: 'conector evolution sem URL/chave configuradas (settings evolution_url e evolution_api_key)' });
        if (bloqueadoNaEvolution(req.method, req.params['*'])) return reply.code(403).send({ error: 'apagar ou deslogar instância é bloqueado no conector; faça no manager da Evolution' });
        return repassar(`${evo.url}/${req.params['*']}${qs}`, { apikey: evo.apiKey });
      }
      if (req.params.nome === NOME_CONECTOR_WHATSAPP) {
        const token = await getSetting(app.pool, WA_TOKEN_ORION);
        if (!token) return reply.code(404).send({ error: 'app orion do gateway sem token (settings whatsapp_token_orion)' });
        return repassar(`${urlGatewayLocal()}/${req.params['*']}${qs}`, { apikey: token });
      }
      if (req.params.nome.startsWith('github-')) {
        // MCP oficial do GitHub (streamable HTTP) com o PAT injetado aqui — a sessão só conhece esta URL local
        // (ver githubMcpServers). A resposta vem como SSE mesmo no initialize: repassa o corpo como stream,
        // sem bufferizar, e devolve Mcp-Session-Id pro cliente seguir a conversa.
        const conta = (await listarContasGithub(app.pool)).find(c => nomeMcpGithub(c.label) === req.params.nome);
        if (!conta) return reply.code(404).send({ error: `conta GitHub ${req.params.nome} não existe; veja a aba Tools › GitHub` });
        if (!/^mcp\/?$/.test(req.params['*'])) return reply.code(404).send({ error: 'esse conector só serve o MCP do GitHub em /mcp/' });
        // X-MCP-Toolsets (header oficial do servidor): só o que a equipe usa — 45 tools viram ~20.
        const h: Record<string, string> = { Authorization: `Bearer ${conta.token}`, 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' };
        for (const k of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) { const v = req.headers[k]; if (typeof v === 'string') h[k] = v; }
        const r = await fetch(GITHUB_MCP_UPSTREAM + qs, { method: req.method, headers: h, body: corpo });
        reply.code(r.status);
        for (const k of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) { const v = r.headers.get(k); if (v) reply.header(k, v); }
        return reply.send(r.body ? Readable.fromWeb(r.body as unknown as import('node:stream/web').ReadableStream) : '');
      }
      const http = (await listarConectoresHttp(app.pool)).find(c => c.nome === req.params.nome);
      if (http) {
        if (bloqueadoNoHttp(http, req.method, req.params['*'])) return reply.code(403).send({ error: `essa operação é bloqueada no conector ${http.nome}; faça no painel do serviço` });
        return repassar(`${http.base.replace(/\/+$/, '')}/${req.params['*']}${qs}`, { [http.header]: http.valor });
      }
      const gcp = contaDoConectorGcp(req.params.nome, await listarContasGoogleCloud(app.pool));
      if (gcp) {
        const caminhoGcp = req.params['*'];
        if (bloqueadoNoConectorGcp(req.method, caminhoGcp)) return reply.code(403).send({ error: 'apagar projeto ou organização inteira é bloqueado no conector; faça no console do Google Cloud' });
        const token = await googleAccessTokenDe(gcp);
        if (!token) return reply.code(502).send({ error: 'o Google recusou a credencial dessa conta' });
        return repassar(`https://${caminhoGcp}${qs}`, { Authorization: `Bearer ${token}` });
      }
      const conta = contaDoConector(req.params.nome, await listarContasCloudflare(app.pool));
      if (!conta) return reply.code(404).send({ error: `conector ${req.params.nome} não existe; veja a aba Tools › Conectores` });
      const caminho = req.params['*'];
      if (bloqueadoNoConector(req.method, caminho)) return reply.code(403).send({ error: 'apagar zona ou projeto Pages inteiro é bloqueado no conector; faça no painel da Cloudflare' });
      return repassar(`${CF_API}/${caminho}${qs}`, { Authorization: `Bearer ${conta.token}` });
    },
  });
}
