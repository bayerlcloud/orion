import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tabelaAlvo } from './claude/sqlGuard.js';

/**
 * Backup dos bancos de produção dos projetos (spec 2026-09-30-preview-design, Parte 3): `pg_dump`
 * de uma tabela antes de um SQL destrutivo aprovado, e dump completo toda noite. A URL do banco
 * (`db_url:<projeto>` na tabela settings) é segredo: vai só no argumento do pg_dump, nunca em
 * mensagem ou log.
 */

const DIR_PADRAO = '/srv/backups/db';
const PG_DUMP_PADRAO = '/usr/bin/pg_dump';
const TIMEOUT_TABELA = 5 * 60_000;
const TIMEOUT_COMPLETO = 60 * 60_000;

export function dbUrlKey(projectId: number): string {
  return `db_url:${projectId}`;
}

/** AAAAMMDD-HHMMSS em UTC. */
function carimbo(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

type Dump = { dbUrl: string; slug: string; dir?: string; pgDump?: string; now?: Date };

async function rodarDump(o: Dump, tabela: string | null, timeout: number): Promise<{ ok: boolean; arquivo?: string; erro?: string }> {
  const pasta = path.join(o.dir ?? DIR_PADRAO, o.slug);
  const nome = `${carimbo(o.now ?? new Date())}-${(tabela ?? 'completo').replace(/[^A-Za-z0-9_.-]/g, '_')}.dump`;
  const arquivo = path.join(pasta, nome);
  try {
    await mkdir(pasta, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
  const args = ['-Fc', '-f', arquivo, ...(tabela ? ['-t', tabela] : []), '--dbname', o.dbUrl];
  return new Promise((resolve) => {
    execFile(o.pgDump ?? PG_DUMP_PADRAO, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true, arquivo });
      const bruto = `${String(stderr ?? '')} ${err.message}`.split(o.dbUrl).join('<db_url>');
      resolve({ ok: false, erro: bruto.trim().slice(-300) || 'pg_dump falhou' });
    });
  });
}

/** Dump da tabela que o SQL destrutivo atinge (ou completo, se não der para saber); devolve o texto do cartão. */
export async function backupAntes(o: Dump & { sql: string }): Promise<string> {
  const r = await rodarDump(o, tabelaAlvo(o.sql), TIMEOUT_TABELA);
  return r.ok ? `backup salvo em ${r.arquivo}` : `backup falhou: ${r.erro}`;
}

export function dumpCompleto(o: Dump): Promise<{ ok: boolean; arquivo?: string; erro?: string }> {
  return rodarDump(o, null, TIMEOUT_COMPLETO);
}

/** Apaga arquivos com mais de `dias` dias na pasta; devolve quantos apagou. */
export async function limparAntigos(dir: string, dias: number, now: Date = new Date()): Promise<number> {
  const limite = now.getTime() - dias * 86_400_000;
  let apagados = 0;
  for (const nome of await readdir(dir).catch(() => [] as string[])) {
    const arq = path.join(dir, nome);
    const st = await stat(arq).catch(() => null);
    if (st?.isFile() && st.mtimeMs < limite) { await unlink(arq); apagados++; }
  }
  return apagados;
}

/** URL de conexão aceita no cadastro: postgres:// ou postgresql://, com host, sem espaço. */
export function ehDbUrl(s: string): boolean {
  return /^postgres(ql)?:\/\/[^\s/]+(\/\S*)?$/.test(s);
}
