import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from '../settings.js';

/** Limpa a resposta do Haiku: 1 linha, sem aspas/ponto final/travessão, até 40 caracteres. Vazio = descartar. */
export function limparTitulo(texto: string): string {
  const t = texto.trim().split('\n')[0]
    .replace(/^(t[ií]tulo\s*:\s*)/i, '')
    .replace(/[—–]/g, ' ')
    .replace(/^["'`*]+|["'`*.!]+$/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Título curto (1 a 3 palavras, tipo "Ajuste home") a partir do primeiro prompt, com um turno de Haiku sem ferramentas. */
export async function tituloCurto(prompt: string, token: string | null): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  let texto = '';
  try {
    const q = query({ prompt: prompt.slice(0, 2000), options: {
      cwd: '/tmp', maxTurns: 1, tools: [], permissionMode: 'default', settingSources: [], abortController: abort,
      // ponytail: sem isto herda plugins e conectores claude.ai (~215k tokens) e estoura o contexto do Haiku.
      strictMcpConfig: true, mcpServers: {}, plugins: [], skills: [], env: { ...(sdkEnv(token) ?? process.env), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'Você dá nome a sessões de trabalho. Leia o pedido e responda SÓ com um título de 1 a 3 palavras em português do Brasil, '
        + 'substantivo e literal, como "Ajuste home", "Gestão de usuários", "Migração de banco". Sem frase, sem aspas, sem ponto final. '
        + 'Ignore o prefixo [Nome] se houver.',
    } });
    for await (const m of q) if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') texto += b.text;
  } catch { /* erro no fim do turno: o texto que já veio serve */ } finally { clearTimeout(timer); }
  return limparTitulo(texto);
}
