/**
 * O CURADOR da memória: agente diário (orion-curador.timer, 03:10 UTC) que cuida do enxame de
 * micro-fatos. Roda uma query() headless do Agent SDK como o runner (mesmo env/token via
 * settings, cwd /srv/orion, modelo padrão da conta), mas com um mundo minúsculo: as ÚNICAS tools
 * são as do servidor MCP in-process "curadoria" (server/curador/tools.ts). Sem Bash, sem Write,
 * sem leitura de disco; canUseTool nega tudo que não for mcp__curadoria__* (não há humano para
 * responder prompt de permissão). Loga no journal: quantas listou, fundiu, propôs e o custo US$.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPool } from '../db.js';
import { KEYS, ensureSettingsTable, getSetting, sdkEnv } from '../settings.js';
import { ensureCuradoriaTable } from './proposals.js';
import { curadoriaServer, type CuradorStats } from './tools.js';

const SYSTEM_PROMPT = [
  'Você é o curador da memória do painel Orion. Analise as memórias listadas pela tool listar (níveis 2 a 4).',
  'Ações, nesta ordem de prioridade:',
  '1. funda duplicatas claras de nível 4 com a tool fundir (só micro-fato com micro-fato; se os corpos se complementam, mande corpo_final unificado);',
  '2. proponha promoção (propor, tipo promocao) para toda memória nível 4 com nota 10;',
  '3. proponha reescrita (tipo reescrita) de memória desatualizada marcada rewritable, enviando o texto novo completo;',
  '4. proponha deleção (tipo delecao) do que está obviamente morto;',
  '5. registre conflito (tipo conflito) quando duas memórias se contradizem;',
  '6. memória universal que claramente pertence a um projeto específico: proponha reescopo (tipo reescopo, com escopo_novo apontando um projeto da lista de listar); seja conservador, na dúvida não proponha.',
  'Seja conservador: na dúvida, não faça nada. Não invente fatos. Justifique toda proposta em uma ou duas frases.',
  'Você só tem as tools do servidor curadoria; não tente ler arquivos, rodar comandos nem usar outras ferramentas.',
].join('\n');

async function main() {
  const pool = createPool();
  await ensureSettingsTable(pool);
  await ensureCuradoriaTable(pool);
  const stats: CuradorStats = { listadas: 0, fundidas: 0, propostas: 0 };
  const env = sdkEnv(await getSetting(pool, KEYS.claudeToken));

  let custo = 0;
  let ok = false;
  const q = query({
    prompt: 'Rode a curadoria diária da memória: liste as memórias e aplique as suas instruções. Ao final, resuma em uma linha o que fez.',
    options: {
      cwd: process.env.ORION_REPO ?? '/srv/orion',
      systemPrompt: SYSTEM_PROMPT,
      maxBudgetUsd: 2,
      permissionMode: 'default',
      allowedTools: ['mcp__curadoria__listar', 'mcp__curadoria__fundir', 'mcp__curadoria__propor'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
      // Não há humano na frente: permite só as tools do curador e nega o resto na hora.
      canUseTool: async (toolName) =>
        toolName.startsWith('mcp__curadoria__')
          ? { behavior: 'allow' as const }
          : { behavior: 'deny' as const, message: 'o curador só usa as tools mcp__curadoria__*' },
      mcpServers: { curadoria: curadoriaServer(pool, stats) },
      ...(env ? { env } : {}),
    },
  });

  try {
    for await (const m of q) {
      if (m.type === 'result') {
        custo = m.total_cost_usd ?? 0;
        ok = !m.is_error;
        if (m.subtype === 'success') console.log(`curador (resposta final): ${m.result}`);
        else console.log(`curador terminou com ${m.subtype}`);
      }
    }
  } finally {
    console.log(
      `curador: listou ${stats.listadas} memórias, fundiu ${stats.fundidas}, propôs ${stats.propostas}, custo US$ ${custo.toFixed(4)}`,
    );
    await pool.end();
  }
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error('curador falhou:', e); process.exit(1); });
