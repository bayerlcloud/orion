/** Cabeçalho de sessão (decisão 10): quem, qual projeto, qual pasta, regras e memória. Puro, testável. */
export type SessionHeader = {
  projectName: string;
  projectPath: string;
  createdBy: string;
  rules?: string | null;
  userMemory?: string | null;
  memories?: { title: string; summary: string; status: string; scope: 'universal' | 'projeto' | 'usuário' }[] | null;
};

export function buildSystemAppend(h: SessionHeader): string {
  const lines = [
    `Esta sessão pertence ao projeto "${h.projectName}", na pasta ${h.projectPath}.`,
    `Foi criada pela pessoa "${h.createdBy}" pelo painel Orion.`,
    'Várias pessoas podem escrever nesta mesma sessão. Cada mensagem chega prefixada com o nome de quem escreveu, entre colchetes. Trate cada uma como vinda dessa pessoa.',
    'Responda em português do Brasil.',
  ];
  if (h.rules?.trim()) lines.push('', 'Regras do projeto definidas no painel:', h.rules.trim());
  if (h.userMemory?.trim()) lines.push('', `Memória sobre ${h.createdBy}:`, h.userMemory.trim());
  if (h.memories && h.memories.length) {
    lines.push('', 'Memórias que valem para esta sessão (do painel Memória). Leve-as em conta e, se aprender algo novo e durável, sugira registrar:');
    for (const m of h.memories) lines.push(`- [${m.scope}${m.status === 'deus' ? ', importância máxima' : ''}] ${m.title}: ${m.summary}`);
  }
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
