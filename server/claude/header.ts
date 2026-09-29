/**
 * Cabeçalho de sessão (decisão 10): quem, qual projeto, qual pasta, regras e memória. Puro, testável.
 *
 * Injeção por nível (decisões fechadas 28/09/2026):
 * - Níveis 0 e 1 NUNCA entram aqui: já chegam pelo CLAUDE.md nativo (constituição + @import dos
 *   mapas). Duplicar no systemAppend é pagar o mesmo contexto duas vezes.
 * - Nível 2 (regras/preferências): título + corpo, com teto de linhas por memória e de memórias.
 * - Nível 3 (decisões fechadas): só a linha de índice; o corpo é lido sob demanda pela tool.
 * - Nível 4 (micro-fatos): nunca no append; só via busca da tool orion-memory.
 */
export type MemoriaRegra = { title: string; body: string; scope: 'universal' | 'projeto' | 'usuário' };
export type MemoriaDecisao = { code: string; title: string; summary: string };

export const REGRAS_MAX = 10;
export const REGRA_LINHAS_MAX = 15;
export const DECISOES_MAX = 20;
export const FRASE_TOOL =
  'Para ler o corpo de uma decisão nível 3 ou buscar micro-fatos (nível 4), use a tool orion-memory.';

export type SessionHeader = {
  projectName: string;
  projectPath: string;
  createdBy: string;
  rules?: string | null;
  userMemory?: string | null;
  regras?: MemoriaRegra[] | null;
  decisoes?: MemoriaDecisao[] | null;
  /** Contas GitHub da aba Tools: nome do MCP, login e o que vive em cada uma. */
  github?: { nome: string; login: string; notes: string }[] | null;
};

/** Corpo de uma regra nível 2, limitado a REGRA_LINHAS_MAX linhas e indentado sob o título. */
function corpoRegra(body: string): string[] {
  const linhas = (body ?? '').split('\n');
  const corte = linhas.slice(0, REGRA_LINHAS_MAX).map((l) => `  ${l}`.trimEnd());
  if (linhas.length > REGRA_LINHAS_MAX) corte.push(`  (corpo cortado na linha ${REGRA_LINHAS_MAX}; o resto fica no painel)`);
  return corte;
}

export function buildSystemAppend(h: SessionHeader): string {
  const lines = [
    `Esta sessão pertence ao projeto "${h.projectName}", na pasta ${h.projectPath}.`,
    `Foi criada pela pessoa "${h.createdBy}" pelo painel Orion.`,
    'Várias pessoas podem escrever nesta mesma sessão. Cada mensagem chega prefixada com o nome de quem escreveu, entre colchetes. Trate cada uma como vinda dessa pessoa.',
    'Responda em português do Brasil.',
  ];
  if (h.rules?.trim()) lines.push('', 'Regras do projeto definidas no painel:', h.rules.trim());
  if (h.userMemory?.trim()) lines.push('', `Memória sobre ${h.createdBy}:`, h.userMemory.trim());
  if (h.github?.length) {
    lines.push('', 'Contas GitHub conectadas (cada uma é um MCP server; as tools são mcp__<nome>__*):');
    for (const g of h.github) lines.push(`- ${g.nome} (login ${g.login})${g.notes.trim() ? `: ${g.notes.trim()}` : ''}`);
  }

  const regras = (h.regras ?? []).slice(0, REGRAS_MAX);
  const decisoes = (h.decisoes ?? []).slice(0, DECISOES_MAX);
  if (regras.length) {
    lines.push('', 'Regras e preferências (nível 2) que valem para esta sessão. Siga-as sem precisar confirmar:');
    for (const m of regras) {
      lines.push(`- [${m.scope}] ${m.title}:`);
      lines.push(...corpoRegra(m.body));
    }
  }
  if (decisoes.length) {
    lines.push('', 'Decisões fechadas (nível 3), só o índice:');
    for (const d of decisoes) lines.push(`- [${d.code}] ${d.title}: ${d.summary}`);
  }
  if (regras.length || decisoes.length) lines.push(FRASE_TOOL);
  return lines.join('\n');
}

export function prefixPrompt(userName: string, prompt: string): string {
  const name = userName.trim() || 'alguém';
  return `[${name}] ${prompt}`;
}

/** Título automático: primeira linha do primeiro prompt, curta. */
export function titleFromPrompt(prompt: string, max = 60): string {
  const first = prompt.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!first) return 'Nova sessão';
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}
