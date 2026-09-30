import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupAntes, limparAntigos, dbUrlKey, dumpCompleto, ehDbUrl } from '../server/dbBackup';

async function fakePgDump(dir: string): Promise<string> {
  const fake = path.join(dir, 'pg_dump');
  await writeFile(fake, '#!/bin/sh\necho "$@" > "$(echo "$@" | sed -n "s/.*-f \\([^ ]*\\).*/\\1/p")"\n', { mode: 0o755 });
  return fake;
}

describe('dbBackup', () => {
  it('chama pg_dump com -t da tabela e devolve o arquivo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bk-'));
    const txt = await backupAntes({ dbUrl: 'postgres://u:p@h/db', slug: 'fisio', sql: 'drop table public.pacientes', dir, pgDump: await fakePgDump(dir), now: new Date('2026-09-30T12:00:00Z') });
    expect(txt).toMatch(/^backup salvo em .*fisio\/20260930-120000-public\.pacientes\.dump$/);
  });
  it('sem tabela identificada faz dump completo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bk-'));
    const txt = await backupAntes({ dbUrl: 'postgres://u:p@h/db', slug: 's', sql: 'drop schema x cascade', dir, pgDump: await fakePgDump(dir), now: new Date('2026-09-30T12:00:00Z') });
    expect(txt).toMatch(/s\/20260930-120000-completo\.dump$/);
  });
  it('pg_dump falhando vira texto, não exceção, e não vaza a URL', async () => {
    const txt = await backupAntes({ dbUrl: 'postgres://u:segredo@h/db', slug: 's', sql: 'truncate a', dir: tmpdir(), pgDump: '/bin/false' });
    expect(txt).toMatch(/^backup falhou:/);
    expect(txt).not.toContain('segredo');
  });
  it('dumpCompleto devolve ok e arquivo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bk-'));
    const r = await dumpCompleto({ dbUrl: 'postgres://u:p@h/db', slug: 'fisio', dir, pgDump: await fakePgDump(dir), now: new Date('2026-09-30T03:00:00Z') });
    expect(r).toMatchObject({ ok: true });
    expect(r.arquivo).toMatch(/fisio\/20260930-030000-completo\.dump$/);
  });
  it('limparAntigos apaga só o que passou de 7 dias', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bk-'));
    await writeFile(path.join(dir, 'velho.dump'), ''); await writeFile(path.join(dir, 'novo.dump'), '');
    const velho = new Date('2026-09-20T00:00:00Z'); await utimes(path.join(dir, 'velho.dump'), velho, velho);
    const novo = new Date('2026-09-29T00:00:00Z'); await utimes(path.join(dir, 'novo.dump'), novo, novo);
    expect(await limparAntigos(dir, 7, new Date('2026-09-30T00:00:00Z'))).toBe(1);
    expect(await readdir(dir)).toEqual(['novo.dump']);
  });
  it('chave do setting', () => expect(dbUrlKey(3)).toBe('db_url:3'));
});

describe('ehDbUrl', () => {
  it('aceita só postgres:// e postgresql://', () => {
    expect(ehDbUrl('postgres://u:p@h:5432/db')).toBe(true);
    expect(ehDbUrl('postgresql://u:p@h/db?sslmode=require')).toBe(true);
    expect(ehDbUrl('https://x.supabase.co')).toBe(false);
    expect(ehDbUrl('postgres://')).toBe(false);
    expect(ehDbUrl(' postgres://u@h/db\n')).toBe(false);
  });
});
