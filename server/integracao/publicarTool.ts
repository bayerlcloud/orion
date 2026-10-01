import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Publicador, Resultado } from './turno.js';

/**
 * MCP `orion-publicar`, só em sessão numa worktree de projeto: os dois únicos caminhos para o trabalho
 * sair da worktree (Danilo, 01/10/2026). "publica" sobe para a raiz (preview <projeto>.bayerl.cloud);
 * "deploy" sobe para a raiz, atualiza o GitHub e publica em produção a partir da raiz.
 */
export const INSTRUCOES_PUBLICAR =
  'Esta sessão trabalha numa worktree própria; nada sai dela sozinho. Quando a pessoa pedir "publica" (ou publicar na raiz/main/preview), use publicar. '
  + 'Quando pedir "deploy" (ou subir para produção), use deploy: ele publica na raiz, atualiza o GitHub e faz o deploy, nessa ordem. '
  + 'Nunca rode deploy.sh, wrangler, git push para a main ou o pedido de publicação do Orion na mão: só por estas ferramentas. '
  + 'Ao terminar uma entrega que mudou arquivos, termine a resposta perguntando: "Posso publicar na raiz?" (para ninguém esquecer de subir o trabalho).';

const resposta = (r: Resultado) => ({ content: [{ type: 'text' as const, text: r.texto }], ...(r.ok ? {} : { isError: true }) });

export function orionPublicarServer(p: Publicador): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'orion-publicar',
    version: '1.0.0',
    instructions: INSTRUCOES_PUBLICAR,
    tools: [
      tool('publicar', `Publica na raiz (${p.raiz}): commita a worktree, traz a raiz, roda os testes e junta. A raiz é o preview do projeto; produção não muda.`,
        {}, async () => resposta(await p.publicar())),
      tool('deploy', 'Deploy em produção: publica na raiz, manda a raiz para o GitHub e roda o deploy da raiz. Para no primeiro passo que falhar.',
        {}, async () => resposta(await p.deploy())),
    ],
  });
}
