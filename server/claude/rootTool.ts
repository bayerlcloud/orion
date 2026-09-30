/**
 * Tool MCP in-process "orion-root": o caminho de uma sessão para fazer algo como root na c3 sem SSH
 * (o orion-central roda com NoNewPrivileges, então `sudo` nunca funciona dentro dele).
 *
 * `exec` sempre vira o botão Aprovar/Recusar (policy.ts). Aprovado, este handler grava
 * /srv/root/pedidos/<id>.json; a unit root orion-root.path roda /usr/local/lib/orion/root-run.py
 * (cópia root de deploy/root-run.py), que só executa se achar em claude_approvals uma aprovação
 * humana desta sessão para ESTE comando byte a byte (< 30 min, uso único) e grava a resposta.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

const ROOT_DIR = '/srv/root';
const ESPERA_MS = 11 * 60_000; // o helper corta o comando em 10 min

export async function pedirRoot(sessionId: string, command: string, opts: { dir?: string; esperaMs?: number; intervaloMs?: number } = {}): Promise<{ code: number | null; out: string }> {
  const dir = opts.dir ?? ROOT_DIR;
  const id = randomUUID();
  const tmp = `${dir}/pedidos/.${id}.tmp`;
  await writeFile(tmp, JSON.stringify({ id, session_id: sessionId, command }));
  await rename(tmp, `${dir}/pedidos/${id}.json`);
  const resp = `${dir}/respostas/${id}.json`;
  const fim = Date.now() + (opts.esperaMs ?? ESPERA_MS);
  while (Date.now() < fim) {
    try {
      const r = JSON.parse(await readFile(resp, 'utf8'));
      await rm(resp, { force: true });
      return { code: typeof r.code === 'number' ? r.code : null, out: String(r.out ?? '') };
    } catch { await new Promise(r => setTimeout(r, opts.intervaloMs ?? 500)); }
  }
  await rm(`${dir}/pedidos/${id}.json`, { force: true });
  return { code: null, out: 'O helper root não respondeu (a unit orion-root.path está ativa? ela é instalada pelo Publicar).' };
}

export function orionRootServer(sessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'orion-root',
    version: '1.0.0',
    instructions: 'Para qualquer coisa que precise de root na c3 (o que usaria sudo: systemctl restart, apt install, editar /etc), use exec. Nunca peça para a pessoa entrar por SSH: exec mostra o botão Aprovar/Recusar no chat e roda como root depois de aprovado. '
      + 'Cada exec é uma aprovação manual, mesmo no modo auto: use só quando root for indispensável e junte os passos root num comando só. '
      + 'Não precisa de root: Postgres do Orion (docker exec orion-postgres psql -U orion orion, o danilo está no grupo docker), docker em geral, arquivos do danilo, systemctl --user.',
    tools: [
      tool(
        'exec',
        'Executa um comando bash como root na c3, depois que um humano aprova no chat. Não use sudo no comando. Timeout de 10 minutos. Devolve o código de saída e a saída combinada (últimos 20 KB).',
        { command: z.string().min(1).describe('Comando bash exato que vai rodar como root') },
        async (a) => {
          const r = await pedirRoot(sessionId, a.command);
          return { content: [{ type: 'text' as const, text: `exit ${r.code ?? '?'}\n${r.out}` }], ...(r.code === 0 ? {} : { isError: true }) };
        },
      ),
    ],
  });
}
