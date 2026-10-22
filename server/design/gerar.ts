import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from '../settings.js';

export type DesignQuery = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
export type HistoricoItem = { role: 'pedido' | 'ajuste'; texto: string; ts: string };
export type GeradorHtml = (prompt: string, token: string | null) => Promise<string>;

export function montarPromptInicial(tema: string): string {
  return 'Gere um único arquivo HTML autocontido (CSS e JS inline, sem dependência externa obrigatória). '
    + `Devolva só o HTML, sem texto em volta. Pedido: ${tema}`;
}

export function montarPromptAjuste(tema: string, htmlAtual: string, historico: HistoricoItem[], instrucao: string): string {
  const resumo = historico.map(h => `- ${h.texto}`).join('\n');
  const base = htmlAtual
    ? `Ajuste o HTML a seguir conforme o pedido novo e devolva o HTML completo revisado. Devolva só o HTML, sem texto em volta.\n\nHTML atual:\n${htmlAtual}`
    : 'A geração anterior falhou. Gere um único arquivo HTML autocontido (CSS e JS inline, sem dependência externa obrigatória) do zero, considerando o pedido novo. Devolva só o HTML, sem texto em volta.';
  return `${base}\n\nTema original: ${tema}\n\nHistórico de pedidos:\n${resumo}\n\nPedido novo: ${instrucao}`;
}

/** Tira a cerca ```html ou ``` em volta da resposta, se vier cercada; tolera texto antes/depois da cerca. */
function limparHtml(texto: string): string {
  const t = texto.trim();
  const m = t.match(/```(?:html)?\s*\n([\s\S]*?)\n?```/);
  return (m ? m[1] : t).trim();
}

/** Mesmo padrão de `tituloCurto` em claude/titulo.ts: turno único, sem ferramentas, timeout próprio. */
export const gerarHtmlReal: GeradorHtml = async (prompt, token) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  let texto = '';
  let erro: string | null = null;
  try {
    const q = query({ prompt, options: {
      cwd: '/tmp', maxTurns: 1, tools: [], permissionMode: 'default', settingSources: [], abortController: abort,
      strictMcpConfig: true, mcpServers: {}, plugins: [], skills: [], env: { ...(sdkEnv(token) ?? process.env), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    } });
    for await (const m of q) {
      if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') texto += b.text;
      if (m.type === 'result' && m.is_error) erro = m.subtype;
    }
  } finally { clearTimeout(timer); }
  if (erro) throw new Error(`erro do modelo: ${erro}`);
  const html = limparHtml(texto);
  if (!html) throw new Error('o modelo não devolveu HTML');
  return html;
};

/** Gera (instrucao null) ou ajusta (instrucao preenchida) o HTML de um design. Nunca lança: grava status='erro' no banco. */
export async function gerarOuAjustarDesign(
  query: DesignQuery, id: number, instrucao: string | null, token: string | null, gerador: GeradorHtml = gerarHtmlReal,
): Promise<void> {
  try {
    const { rows } = await query('SELECT tema, html, historico FROM designs WHERE id = $1', [id]);
    const tema: string = rows[0]?.tema ?? '';
    const prompt = instrucao === null
      ? montarPromptInicial(tema)
      : montarPromptAjuste(tema, rows[0]?.html ?? '', rows[0]?.historico ?? [], instrucao);
    const html = await gerador(prompt, token);
    const item: HistoricoItem = { role: instrucao ? 'ajuste' : 'pedido', texto: instrucao ?? tema, ts: new Date().toISOString() };
    await query(
      "UPDATE designs SET html = $2, status = 'pronto', historico = historico || $3::jsonb, updated_at = now() WHERE id = $1",
      [id, html, JSON.stringify([item])],
    );
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    try {
      await query("UPDATE designs SET status = 'erro', erro = $2, updated_at = now() WHERE id = $1", [id, msg]);
    } catch { /* banco indisponível: nada a fazer, mas esta função não pode lançar */ }
  }
}

/** No boot: designs que ficaram presos em 'gerando' (ex.: reinício no meio de uma geração) viram erro. */
export async function limparGerandoPreso(query: DesignQuery): Promise<void> {
  await query("UPDATE designs SET status = 'erro', erro = 'interrompido por reinício do servidor', updated_at = now() WHERE status = 'gerando'");
}
