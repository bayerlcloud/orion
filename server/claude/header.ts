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
  /** null = sessão neutra (sem projeto). */
  projectName: string | null;
  projectPath: string;
  createdBy: string;
  rules?: string | null;
  userMemory?: string | null;
  regras?: MemoriaRegra[] | null;
  decisoes?: MemoriaDecisao[] | null;
  /** Contas GitHub da aba Tools: nome do MCP, login e o que vive em cada uma. */
  github?: { nome: string; login: string; email?: string; notes: string }[] | null;
  /** Contas Cloudflare da aba Tools (conector simples): nome, URL do proxy local, account id e o que vive em cada uma. */
  cloudflare?: { nome: string; url: string; account_id: string; account_name?: string; email?: string; notes: string }[] | null;
  /** Evolution API (WhatsApp) como conector simples: URL do proxy local e servidor real. */
  evolution?: { nome: string; url: string; servidor: string } | null;
  /** WhatsApp do Orion pelo gateway orion-wa (o próprio Orion como app): URL do conector local. */
  whatsapp?: { url: string } | null;
  /** Cofre: Chrome compartilhado com perfil persistente (MCP `cofre`) e o painel web para login manual. */
  cofre?: { painel: string } | null;
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
    h.projectName === null
      ? `Esta é uma sessão neutra, sem projeto (pasta ${h.projectPath}), para perguntas gerais. Se o pedido for trabalho num projeto do painel, sugira abrir uma sessão nova nesse projeto.`
      : `Esta sessão pertence ao projeto "${h.projectName}", na pasta ${h.projectPath}. O projeto de uma sessão não muda: se o pedido for trabalho em outro projeto, sugira abrir uma sessão nova nele.`,
    `Foi criada pela pessoa "${h.createdBy}" pelo painel Orion.`,
    'Várias pessoas podem escrever nesta mesma sessão. Cada mensagem chega prefixada com o nome de quem escreveu, entre colchetes. Trate cada uma como vinda dessa pessoa.',
    'Responda em português do Brasil.',
  ];
  if (h.rules?.trim()) lines.push('', 'Regras do projeto definidas no painel:', h.rules.trim());
  if (h.userMemory?.trim()) lines.push('', `Memória sobre ${h.createdBy}:`, h.userMemory.trim());
  if (h.github?.length) {
    lines.push('', 'Contas GitHub conectadas (cada uma é um MCP server; as tools são mcp__<nome>__*):');
    for (const g of h.github) lines.push(`- ${g.nome} (login ${g.login}${g.email?.trim() ? `, e-mail ${g.email.trim()}` : ''})${g.notes.trim() ? `: ${g.notes.trim()}` : ''}`);
  }
  if (h.cloudflare?.length) {
    lines.push('', 'Contas Cloudflare conectadas (conector simples, não é MCP): chame a API v4 da Cloudflare com curl na URL da conta + caminho da API, SEM token; o Orion injeta a autenticação e devolve o JSON da Cloudflare. Ex.: curl <url>/accounts/<account>/pages/projects. Corpo em JSON com -H "Content-Type: application/json". Apagar zona ou projeto Pages inteiro é bloqueado.');
    for (const c of h.cloudflare) lines.push(`- ${c.nome}: ${c.url} (account ${c.account_id}${c.email?.trim() ? `, e-mail ${c.email.trim()}` : ''})${c.notes.trim() ? `: ${c.notes.trim()}` : ''}`);
  }
  if (h.evolution) {
    lines.push('', `Evolution API (WhatsApp, ${h.evolution.servidor}) como conector simples, não é MCP: chame a API da Evolution v2 com curl em ${h.evolution.url}/<caminho>, SEM apikey; o Orion injeta a chave global. Ex.: curl ${h.evolution.url}/instance/fetchInstances; enviar texto: POST ${h.evolution.url}/message/sendText/<instância> com {"number":"55...","text":"..."}. Instâncias de clientes (Brandspace, TrackingMachine) vivem lá: não mexa em webhook nem reinicie instância de cliente sem pedido explícito. Apagar ou deslogar instância é bloqueado.`);
  }
  if (h.whatsapp) {
    lines.push('', `WhatsApp do Orion (conector "whatsapp", passa pelo gateway com fila e limites): para avisar alguém ou um grupo, use POST ${h.whatsapp.url}/message/sendText/alertas com {"number":"55... ou <jid>@g.us","text":"..."}, SEM apikey. Grupos do número: GET ${h.whatsapp.url}/group/fetchAllGroups/alertas?getParticipants=false (demora ~25 s). Prefira este conector ao da Evolution para mandar mensagem; o da Evolution é para administrar instâncias.`);
  }

  if (h.cofre) {
    lines.push('', `Cofre (browser compartilhado): um Chrome real com perfil persistente e logins salvos, disponível pelas tools mcp__cofre__* (navegar, clicar, digitar, screenshot, pdf). Use-o para qualquer coisa que precise de browser. Se um site pedir login, código ou captcha, peça ao Bayerl para abrir ${h.cofre.painel} e resolver na mão; depois continue. É uma instância só, compartilhada: feche as abas que abrir e não faça logout de nada.`);
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
