import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ponytail: cache por pasta com 30 s de vida; arquivo novo aparece no máximo 30 s depois.
const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Arquivos do projeto (git ls-files: respeita .gitignore). Fora de repositório, lista vazia. */
export function arquivosDoProjeto(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files = execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 8000 })
    .then(r => r.stdout.split('\n').filter(Boolean))
    .catch(() => [] as string[]);
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/** Ordena por relevância: nome do arquivo começando pela busca, depois nome contendo, depois caminho contendo. */
export function rankearArquivos(files: string[], q: string, limite = 15): string[] {
  const t = q.toLowerCase();
  if (!t) return files.slice(0, limite);
  const score = (f: string) => {
    const l = f.toLowerCase(), base = l.slice(l.lastIndexOf('/') + 1);
    if (base.startsWith(t)) return 0;
    if (base.includes(t)) return 1;
    if (l.includes(t)) return 2;
    return -1;
  };
  return files.map(f => [score(f), f] as const).filter(([s]) => s >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, limite).map(([, f]) => f);
}
