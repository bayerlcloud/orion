import path from 'node:path';

export type ParsedMemory = {
  name: string;
  description: string;
  type: 'user' | 'project' | 'reference' | 'feedback' | null;
  body: string;
};

/** Pasta de memórias que o Claude Code usa para um projeto: ~/.claude/projects/<cwd com / virando ->/memory */
export function claudeMemoryDir(home: string, projectPath: string): string {
  const encoded = projectPath.replace(/\//g, '-');
  return path.join(home, '.claude', 'projects', encoded, 'memory');
}

/** Lê frontmatter YAML simples (chave: valor e metadata.type) + corpo. Tolerante. */
export function parseFrontmatter(md: string): ParsedMemory {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', type: null, body: md.trim() };
  const head = m[1], body = (m[2] ?? '').trim();
  const get = (k: string): string => {
    const r = head.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm'));
    if (!r) return '';
    return r[1].trim().replace(/^["']|["']$/g, '');
  };
  const rawType = get('type').toLowerCase();
  const type = (['user', 'project', 'reference', 'feedback'].includes(rawType) ? rawType : null) as ParsedMemory['type'];
  return { name: get('name'), description: get('description'), type, body };
}

/** Gera o arquivo .md (frontmatter + corpo) a partir de uma memória do painel. */
export function toMarkdown(mem: { code: string; title: string; summary: string; body_md: string; scope: 'user' | 'project' | 'reference' }): string {
  const esc = (s: string) => (/[:#"']/.test(s) ? JSON.stringify(s) : s);
  return `---\nname: ${mem.code}\ndescription: ${esc(mem.summary || mem.title)}\nmetadata:\n  node_type: memory\n  type: ${mem.scope}\n---\n\n# ${mem.title}\n\n${mem.body_md}\n`;
}

/** Só nomes de arquivo .md seguros dentro da pasta. */
export function isSafeMdName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.md$/.test(name) && !name.includes('..');
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Dono de uma memória type: user importada do disco. Todas as sessões rodam como danilo, então o
 * arquivo não diz de quem é: procura o nome das pessoas no nome/descrição/corpo. Só devolve id se
 * exatamente uma pessoa for citada; senão null (quem importa trata como regra do projeto).
 */
export function donoPorNome(texto: string, pessoas: { id: number; name: string }[]): number | null {
  const t = semAcento(texto);
  const achadas = pessoas.filter(p => {
    const nome = semAcento(p.name.trim().split(/\s+/)[0] ?? '');
    return nome.length > 1 && new RegExp(`(^|[^a-z0-9])${nome}([^a-z0-9]|$)`).test(t);
  });
  return achadas.length === 1 ? achadas[0].id : null;
}

/**
 * MEMORY.md montado a partir de TODOS os .md da pasta: os que vieram do painel usam a linha pronta
 * (doPainel, por nome de arquivo); os que o Claude escreveu e ninguém importou entram pelo próprio
 * frontmatter. Assim o export não some com memória que só existe no disco.
 */
export function indiceMemory(projeto: string, arquivos: { nome: string; raw: string }[], doPainel: Map<string, string>): string {
  const linhas = [...arquivos]
    .filter(a => isSafeMdName(a.nome) && a.nome.toLowerCase() !== 'memory.md')
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map(a => {
      const pronta = doPainel.get(a.nome);
      if (pronta) return pronta;
      const p = parseFrontmatter(a.raw);
      return `- [${p.name || a.nome.replace(/\.md$/, '')}](${a.nome}): ${p.description}`;
    });
  return `# Memórias do projeto ${projeto}\n\n${linhas.join('\n')}\n`;
}
