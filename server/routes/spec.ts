import type { FastifyInstance } from 'fastify';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inventoryResponse } from '../inventory.js';

function titleOf(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

export async function specRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });

  app.get('/api/spec/docs', async () => {
    const repo = app.repoDir;
    const docs: { id: string; title: string; markdown: string }[] = [];
    const decisoes = await readFile(path.join(repo, 'docs', 'DECISOES.md'), 'utf8').catch(() => '');
    if (decisoes) docs.push({ id: 'decisoes', title: 'Decisões', markdown: decisoes });
    const specDir = path.join(repo, 'docs', 'specs');
    const files = (await readdir(specDir).catch(() => [] as string[])).filter(f => f.endsWith('.md')).sort();
    for (const f of files) {
      const md = await readFile(path.join(specDir, f), 'utf8');
      docs.push({ id: `spec:${f}`, title: titleOf(md, f), markdown: md });
    }
    return { docs };
  });

  // Último snapshot (coletado pelo timer orion-inventory a cada hora) + o que mudou desde o anterior.
  // Sem snapshot ainda: coleta ao vivo uma vez, guarda e devolve.
  app.get('/api/spec/inventory', async () => inventoryResponse(app.pool, app.repoDir));

  // Coleta agora (qualquer usuário logado), guarda um snapshot novo e devolve a mesma forma.
  app.post('/api/spec/inventory/refresh', async () => inventoryResponse(app.pool, app.repoDir, { refresh: true }));
}
