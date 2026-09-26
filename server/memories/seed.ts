import type { Pool } from 'pg';
import type { Status } from './util.js';

type SeedMemory = {
  code: string;
  title: string;
  summary: string;
  status: Status;
  learning_level: number | null;
  rewritable: boolean;
  keywords: string[];
  body_md: string;
  scope: 'orion' | 'universal';
};

const SEED: SeedMemory[] = [
  {
    code: 'orion-central-unico-painel',
    title: 'Orion é o painel único da infraestrutura',
    summary: 'A Central do Orion é o único lugar de verdade: 3 VPS mandam dados por push e o painel nunca puxa dos servidores.',
    status: 'deus',
    learning_level: null,
    rewritable: false,
    keywords: ['orion', 'central', 'infra', 'push'],
    scope: 'orion',
    body_md: [
      '# Orion é o painel único',
      '',
      'O **Orion** existe para ser a única fonte de verdade sobre a infraestrutura. Nada de abrir cinco abas para saber se um serviço caiu.',
      '',
      'Cada VPS (c1, c2 e a Hostinger) **empurra** seus dados para a Central por uma chave restrita. O painel nunca inicia conexão de volta para os servidores — isso mantém a superfície de ataque pequena e o fluxo previsível.',
      '',
      '## Por que isso importa',
      '',
      '- Um só painel para olhar de manhã.',
      '- Se um coletor para de empurrar, o silêncio já é o alerta.',
      '- A Central guarda o histórico; os servidores ficam leves.',
      '',
      'Essa memória é **nível Deus**: manda em qualquer decisão de arquitetura do Orion. Não deve ser reescrita pela IA sem revisão humana.',
    ].join('\n'),
  },
  {
    code: 'orion-coletor-cpu-sem-iowait',
    title: 'Coletor não soma iowait na CPU',
    summary: 'O bug clássico do coletor v1 era somar iowait no uso de CPU. O v2 usa cgroup + PSI e conta iowait à parte.',
    status: 'aprendizagem',
    learning_level: 4,
    rewritable: true,
    keywords: ['coletor', 'cpu', 'iowait', 'psi'],
    scope: 'orion',
    body_md: [
      '# Coletor v2: CPU sem iowait',
      '',
      'No coletor v1 o número de CPU vinha inflado porque **iowait** era somado ao uso de processador. Resultado: alarme falso de carga alta enquanto o gargalo era disco.',
      '',
      '## O que o v2 faz',
      '',
      '1. Lê a CPU via **cgroup** do próprio serviço, não do host inteiro.',
      '2. Usa **PSI** (pressure stall information) para separar espera de disco.',
      '3. Publica 12 contadores distintos — `iowait` é um deles, mas fica fora do `cpu`.',
      '',
      'Também corrigiu o JSON inválido que o `bc` gerava quando o locale usava vírgula decimal.',
      '',
      'Aprendizado nível 4: quase virou regra fixa. Ainda pode ser refinado conforme aparecem casos novos.',
    ].join('\n'),
  },
  {
    code: 'ideia-aba-memoria',
    title: 'Rascunho: aba Memória do painel',
    summary: 'Ideia solta da tela dividida de memórias: lista à esquerda, leitor à direita, com cartão de metadados editável.',
    status: 'rascunho',
    learning_level: null,
    rewritable: true,
    keywords: ['memoria', 'ui', 'rascunho'],
    scope: 'universal',
    body_md: [
      '# Aba Memória (rascunho)',
      '',
      'Anotação rápida antes de virar spec de verdade.',
      '',
      '- Tela dividida: **lista** à esquerda, **leitor** à direita.',
      '- Cada memória é uma nota em markdown com um cartão de metadados.',
      '- Sete níveis de importância, de *Deus* a *Rascunho*.',
      '- A IA pode reescrever memórias marcadas como `rewritable`.',
      '',
      'Ainda é rascunho: falta decidir como a IA vai registrar *por que* acessou cada memória.',
    ].join('\n'),
  },
];

/** Insere 3 memórias de exemplo apenas se a tabela estiver vazia. */
export async function seedMemories(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::int AS n FROM memories');
  if (Number(rows[0]?.n ?? 0) > 0) return;

  const proj = await pool.query<{ id: number }>(`SELECT id FROM projects WHERE slug = 'orion' LIMIT 1`);
  const orionId: number | null = proj.rows[0]?.id ?? null;

  for (const m of SEED) {
    const scopeProject = m.scope === 'orion' ? orionId : null;
    await pool.query(
      `INSERT INTO memories (code, title, summary, body_md, status, learning_level, rewritable, keywords, scope_project_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO NOTHING`,
      [m.code, m.title, m.summary, m.body_md, m.status, m.learning_level, m.rewritable, m.keywords, scopeProject],
    );
  }
}
