import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from '../settings.js';

export type DesignQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
export type HistoricoItem = { role: 'pedido' | 'ajuste'; texto: string; ts: string };
export type GeradorHtml = (prompt: string, token: string | null) => Promise<string>;

const INSTRUCAO_FIXA = 'Gere um único arquivo HTML autocontido (CSS e JS inline, sem dependência externa obrigatória). '
  + 'Devolva só o HTML, sem texto em volta.';

export function montarPromptInicial(tema: string): string {
  return `${INSTRUCAO_FIXA} Pedido: ${tema}`;
}

export function montarPromptAjuste(htmlAtual: string, historico: HistoricoItem[], instrucao: string): string {
  const resumo = historico.map(h => `- ${h.texto}`).join('\n');
  return `${INSTRUCAO_FIXA.replace('Gere', 'Ajuste o HTML a seguir conforme o pedido novo e devolva o HTML completo revisado; não gere')}\n\n`
    + `HTML atual:\n${htmlAtual}\n\nHistórico de pedidos:\n${resumo}\n\nPedido novo: ${instrucao}`;
}

/** Tira a cerca ```html ou ``` em volta da resposta, se vier cercada. */
function limparHtml(texto: string): string {
  const t = texto.trim();
  const m = t.match(/^```(?:html)?\s*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

/** Mesmo padrão de `tituloCurto` em claude/titulo.ts: turno único, sem ferramentas, timeout próprio. */
export const gerarHtmlReal: GeradorHtml = async (prompt, token) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  let texto = '';
  try {
    const q = query({ prompt, options: {
      cwd: '/tmp', maxTurns: 1, tools: [], permissionMode: 'default', settingSources: [], abortController: abort,
      strictMcpConfig: true, mcpServers: {}, plugins: [], skills: [], env: { ...(sdkEnv(token) ?? process.env), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    } });
    for await (const m of q) if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') texto += b.text;
  } finally { clearTimeout(timer); }
  const html = limparHtml(texto);
  if (!html) throw new Error('o modelo não devolveu HTML');
  return html;
};

/** Gera (instrucao null) ou ajusta (instrucao preenchida) o HTML de um design. Nunca lança: grava status='erro' no banco. */
export async function gerarOuAjustarDesign(
  query: DesignQuery, id: number, instrucao: string | null, token: string | null, gerador: GeradorHtml = gerarHtmlReal,
): Promise<void> {
  try {
    let prompt: string;
    let texto: string;
    if (instrucao === null) {
      const { rows } = await query('SELECT tema FROM designs WHERE id = $1', [id]);
      texto = rows[0]?.tema ?? '';
      prompt = montarPromptInicial(texto);
    } else {
      const { rows } = await query('SELECT html, historico FROM designs WHERE id = $1', [id]);
      prompt = montarPromptAjuste(rows[0]?.html ?? '', rows[0]?.historico ?? [], instrucao);
      texto = instrucao;
    }
    const html = await gerador(prompt, token);
    const item: HistoricoItem = { role: instrucao ? 'ajuste' : 'pedido', texto, ts: new Date().toISOString() };
    await query(
      "UPDATE designs SET html = $2, status = 'pronto', historico = historico || $3::jsonb, updated_at = now() WHERE id = $1",
      [id, html, JSON.stringify([item])],
    );
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await query("UPDATE designs SET status = 'erro', erro = $2, updated_at = now() WHERE id = $1", [id, msg]);
  }
}
