import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import { lerStatus } from '../deploy/estado.js';

/**
 * Resposta do Orion dentro do chat entre pessoas: chamada pontual e sem estado (nenhuma sessão
 * persistida, nenhuma ferramenta de edição) — decisão do conclave de 22/10/2026 (ver chat-conclave):
 * a sessão contínua por pessoa do OrionPanel fica intocada, essa é uma pergunta-resposta avulsa por
 * mensagem de chat, com contexto (memória, tarefas, build) buscado no banco antes do turno, não por
 * tool-calling do modelo. allowedTools: [] trava qualquer ferramenta — é um bot de canal
 * compartilhado, não dá pra deixar rodar Bash/editar arquivo a partir de uma mensagem de chat.
 */

/** Memórias relevantes à mensagem: ILIKE nas palavras com 4+ letras, mesmo filtro do GET /api/memories. */
async function buscarMemoriasRelevantes(pool: Pool, texto: string): Promise<string> {
  const palavras = [...new Set(texto.toLowerCase().match(/[\p{L}]{4,}/gu) ?? [])].slice(0, 6);
  if (!palavras.length) return '';
  const where = palavras.map((_, i) => `(m.title ILIKE $${i + 1} OR m.summary ILIKE $${i + 1} OR EXISTS (SELECT 1 FROM unnest(m.keywords) k WHERE k ILIKE $${i + 1}))`).join(' OR ');
  const { rows } = await pool.query(
    `SELECT m.title, m.summary FROM memories m WHERE ${where} ORDER BY m.level ASC, m.nota DESC NULLS LAST LIMIT 3`,
    palavras.map((p) => `%${p}%`),
  );
  if (!rows.length) return '';
  return `Memórias relacionadas:\n${rows.map((r: any) => `- ${r.title}: ${r.summary}`).join('\n')}`;
}

/** Tarefas em andamento ou revisão: visão rápida do kanban, sem filtrar por projeto citado (lazy). */
async function buscarTarefasAbertas(pool: Pool): Promise<string> {
  const { rows } = await pool.query(
    `SELECT t.title, t.status, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status IN ('fazendo', 'revisao') ORDER BY t.updated_at DESC LIMIT 5`,
  );
  if (!rows.length) return '';
  return `Tarefas em andamento:\n${rows.map((r: any) => `- [${r.status}] ${r.project_name}: ${r.title}`).join('\n')}`;
}

async function buscarStatusBuild(): Promise<string> {
  const s = await lerStatus().catch(() => null);
  if (!s) return '';
  return `Última publicação do Orion: ${s.estado} (${s.etapa || s.msg || 'sem detalhe'})`;
}

export type MensagemHistorico = { from_name: string; text: string; from_agent: boolean };

export async function responderNoChat(opts: {
  pool: Pool;
  repoDir: string;
  autor: string;
  texto: string;
  historico: MensagemHistorico[];
}): Promise<string> {
  const [memorias, tarefas, build] = await Promise.all([
    buscarMemoriasRelevantes(opts.pool, opts.texto),
    buscarTarefasAbertas(opts.pool),
    buscarStatusBuild(),
  ]);
  const contexto = [memorias, tarefas, build].filter(Boolean).join('\n\n');
  const historico = opts.historico
    .slice(-10)
    .map((m) => `${m.from_agent ? 'Orion' : m.from_name}: ${m.text}`)
    .join('\n');

  const systemPrompt = [
    'Você é o Orion, o assistente do painel interno da Bayerl Studio, respondendo dentro do chat em que a equipe (Danilo, Laís, Guilherme, Gustavo, Natan) conversa.',
    'Responda em português do Brasil, curto e direto (poucas frases, sem travessão —).',
    'Use o contexto abaixo quando ajudar a responder; se não tiver dado relevante, diga que não sabe em vez de inventar.',
    'Você não tem acesso a ferramentas nesta conversa: não prometa executar nada, só responda com o que já sabe pelo contexto.',
    contexto ? `Contexto do sistema:\n${contexto}` : 'Sem contexto adicional do sistema para esta pergunta.',
  ].join('\n\n');

  const prompt = historico
    ? `Histórico recente do canal:\n${historico}\n\n${opts.autor} pergunta: ${opts.texto}`
    : `${opts.autor} pergunta: ${opts.texto}`;

  const q = query({
    prompt,
    options: {
      cwd: opts.repoDir,
      permissionMode: 'default',
      allowedTools: [],
      systemPrompt,
      settingSources: [],
    },
  });

  for await (const m of q as AsyncIterable<any>) {
    if (m.type === 'result') {
      return m.subtype === 'success' && typeof m.result === 'string' && m.result.trim()
        ? m.result.trim()
        : 'Não consegui responder agora.';
    }
  }
  return 'Não consegui responder agora.';
}
