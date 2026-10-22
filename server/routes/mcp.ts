import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { KEYS, getSetting, setSetting } from '../settings.js';
import { buscarMemorias } from '../claude/memoryTool.js';
import { buscarHistorico, materializarTurnos } from '../memories/historico.js';

/**
 * Conector MCP público (claude.ai > Configurações > Conectores > adicionar personalizado):
 * só leitura (busca de memória e histórico), protegido por token Bearer. Sem salvar/atualizar/
 * encerrar aqui — essas tools têm efeito colateral (gravação, arquivamento) e o ctx desta rota
 * não é uma sessão real do painel, então ficam de fora por segurança (pedido do Guilherme,
 * 22/10/2026: só "ter acesso" via claude.ai).
 */
const CTX = { sessionId: 'mcp-connector', projectId: null, userId: 1 };

function buildServer(pool: FastifyInstance['pool']): McpServer {
  const query = (sql: string, params?: unknown[]) => pool.query(sql, params as any[]);
  const server = new McpServer({ name: 'orion', version: '1.0.0' });
  server.registerTool(
    'buscar_memoria',
    {
      description: 'Busca memórias do painel Orion (regras, decisões, micro-fatos) por texto e similaridade semântica, escopo universal.',
      inputSchema: { consulta: z.string().describe('Palavras a buscar'), nivel: z.number().int().min(2).max(4).optional() },
    },
    async ({ consulta, nivel }) => {
      const memorias = await buscarMemorias(query, CTX, { consulta, nivel, todos_projetos: true });
      return { content: [{ type: 'text', text: JSON.stringify({ encontradas: memorias.length, memorias }) }] };
    },
  );
  server.registerTool(
    'buscar_historico',
    {
      description: 'Busca no histórico das sessões do painel Orion (o que foi pedido e respondido) por texto.',
      inputSchema: { consulta: z.string(), pessoa: z.string().optional(), desde: z.string().optional() },
    },
    async ({ consulta, pessoa, desde }) => {
      await materializarTurnos(query).catch(() => 0);
      const turnos = await buscarHistorico(query, CTX, { consulta, pessoa, desde, todos_projetos: true });
      return { content: [{ type: 'text', text: JSON.stringify({ encontrados: turnos.length, turnos }) }] };
    },
  );
  return server;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (req, reply) => {
    let token = await getSetting(app.pool, KEYS.mcpToken);
    if (!token) {
      token = randomBytes(24).toString('hex');
      await setSetting(app.pool, KEYS.mcpToken, token, null);
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) return reply.code(401).send({ error: 'token inválido' });

    const server = buildServer(app.pool);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.hijack();
  });
}
