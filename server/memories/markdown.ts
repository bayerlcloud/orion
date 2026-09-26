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
