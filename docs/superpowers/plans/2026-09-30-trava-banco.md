# Trava do banco (Parte 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SQL destrutivo pede clique em qualquer modo (inclusive `auto`), com `pg_dump` antes; SQL comum pelo MCP do Supabase passa direto; backup completo diário.

**Architecture:** Um detector puro (`sqlGuard.ts`) classifica SQL. `policy.ts` usa o detector e ganha a noção de "pergunta sempre", que o hook respeita mesmo no modo `auto`. O hook vira fábrica para receber, por sessão, uma função de backup que o `routes/claude.ts` monta com o `db_url` do projeto. Um script noturno faz o dump completo.

**Tech Stack:** TypeScript, Fastify, vitest, `@anthropic-ai/claude-agent-sdk` (hook PreToolUse), `pg_dump` (postgresql-client), systemd timer.

**Spec:** `docs/superpowers/specs/2026-09-30-preview-design.md` (Parte 3)

## Global Constraints

- Nunca travessão (— ou –) em texto gerado, inclusive comentários e mensagens de UI.
- Segredos (`db_url`) só na tabela `settings`; nunca no repositório, na memória ou em log.
- Git: trabalhar numa worktree de tarefa; o integrador junta. Publicar só pela fila (`/srv/builds/pedido.json` com `{"ref":"main","por":"<nome>"}`); nunca `npm run build` em `/srv/orion` nem restart manual.
- Comandos externos com `execFile` (nunca shell), com timeout.
- Destrutivo = `DROP`, `TRUNCATE`, `ALTER TABLE ... DROP`, `ALTER TABLE ... RENAME`, `DELETE` sem `WHERE`, `UPDATE` sem `WHERE`.
- Backups em `/srv/backups/db/<slug>/`, retenção 7 dias; timer diário às 03:00.

## Review Focus

- SQL com várias instruções (`select 1; drop table x`): a destrutiva no meio precisa ser pega. Teste em Task 1.
- Palavra destrutiva dentro de string ou comentário (`insert into log values ('drop table')`, `-- drop table`): não deve pedir clique. Teste em Task 1.
- `DELETE ... WHERE` em minúsculas e com quebra de linha: não é destrutivo. Teste em Task 1.
- Backup que demora ou falha (`db_url` errado, pg_dump de versão menor que o servidor): o cartão ainda aparece, com o motivo "backup falhou: ...", e nada trava. Teste em Task 3.
- Modo `plan` e ferramentas interativas continuam fora do hook, como hoje. Teste em Task 2.

---

### Task 1: Detector de SQL destrutivo

**Files:**
- Create: `server/claude/sqlGuard.ts`
- Test: `tests/sqlGuard.test.ts`

**Interfaces:**
- Produces: `sqlDestrutivo(sql: string): string | null` (motivo curto em pt-BR, ou `null`), `tabelaAlvo(sql: string): string | null` (primeira tabela da primeira instrução destrutiva, ex. `public.pacientes`, ou `null`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { sqlDestrutivo, tabelaAlvo } from '../server/claude/sqlGuard';

describe('sqlDestrutivo', () => {
  it('pega destrutivo', () => {
    for (const s of ['DROP TABLE pacientes', 'drop table if exists x', 'TRUNCATE agenda', 'alter table p drop column nome',
      'ALTER TABLE p RENAME COLUMN a TO b', 'alter table p rename to q', 'DELETE FROM p', 'delete from p;',
      'UPDATE p SET ativo = false', 'select 1; drop table x', 'DROP SCHEMA s CASCADE', 'drop function f'])
      expect(sqlDestrutivo(s), s).not.toBeNull();
  });
  it('deixa passar o comum', () => {
    for (const s of ['select * from p', "insert into log values ('drop table x')", '-- drop table x\nselect 1',
      '/* truncate */ select 1', 'delete from p where id = 3', 'DELETE FROM p\n  WHERE criado < now()',
      'update p set a = 1 where id = 2', 'create table t (id int)', 'alter table p add column x int', 'create or replace function f() returns int as $$ select 1 $$ language sql'])
      expect(sqlDestrutivo(s), s).toBeNull();
  });
  it('tabelaAlvo', () => {
    expect(tabelaAlvo('drop table public.pacientes')).toBe('public.pacientes');
    expect(tabelaAlvo('select 1; delete from agenda')).toBe('agenda');
    expect(tabelaAlvo('drop schema s')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sqlGuard.test.ts`
Expected: FAIL, módulo não existe.

- [ ] **Step 3: Implement `sqlDestrutivo` e `tabelaAlvo` em `server/claude/sqlGuard.ts`**

Antes de testar as regex: remover comentários `--` e `/* */`, trocar literais `'...'` e `$$...$$` por `''`, dividir por `;`, e testar cada instrução normalizada (espaços colapsados, minúsculas). `DELETE`/`UPDATE` só são destrutivos se a instrução não contém `\bwhere\b`. `tabelaAlvo` só devolve nome para `drop table`, `truncate`, `alter table`, `delete from`, `update`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sqlGuard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/claude/sqlGuard.ts tests/sqlGuard.test.ts
git commit -m "feat(policy): detector de SQL destrutivo"
```

### Task 2: Política pergunta sempre no destrutivo e libera SQL comum

**Files:**
- Modify: `server/claude/policy.ts` (tipo `Verdict`, `classify`, `policyHook`)
- Modify: `server/claude/runner.ts:365` (uso do hook)
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `sqlDestrutivo`, `tabelaAlvo` (Task 1).
- Produces:
  - `type Verdict = { decision: 'allow' | 'ask'; reason?: string; always?: boolean; sql?: string }` (`always` = pergunta até no `auto`; `sql` = o SQL destrutivo, para o backup).
  - `type BackupFn = (sql: string) => Promise<string>` (devolve texto para o cartão: "backup salvo em ..." ou "backup falhou: ..." ou "sem backup automático (projeto sem db_url)").
  - `makePolicyHook(backup?: BackupFn): HookCallback`. `policyHook` continua exportado como `makePolicyHook()` para quem já usa.
  - `TurnParams.backupSql?: BackupFn` em `runner.ts`, passado para `makePolicyHook(p.backupSql)` na linha 365.

- [ ] **Step 1: Write the failing tests** (adicionar ao `tests/policy.test.ts`; trocar a linha existente `execute_sql select 1 → ask` por `allow`)

```ts
it('SQL comum pelo MCP do Supabase passa direto', () => {
  expect(classify('mcp__supabase__execute_sql', { query: 'select 1' }).decision).toBe('allow');
  expect(classify('mcp__supabase__apply_migration', { name: 'x', query: 'alter table p add column y int' }).decision).toBe('allow');
});
it('SQL destrutivo pergunta sempre', () => {
  const v = classify('mcp__supabase__execute_sql', { query: 'drop table pacientes' });
  expect(v).toMatchObject({ decision: 'ask', always: true, sql: 'drop table pacientes' });
  expect(classify('Bash', { command: 'psql "$URL" -c "truncate agenda"' })).toMatchObject({ decision: 'ask', always: true });
});
it('no modo auto, destrutivo ainda pergunta e chama o backup', async () => {
  const chamadas: string[] = [];
  const hook = makePolicyHook(async (sql) => { chamadas.push(sql); return 'backup salvo em /srv/backups/db/x/a.dump'; });
  const out = await hook({ hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'drop table p' } } as any, undefined, { signal: new AbortController().signal });
  expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  expect((out.hookSpecificOutput as any).permissionDecisionReason).toContain('backup salvo em');
  expect(chamadas).toEqual(['drop table p']);
});
it('no modo auto, comum continua liberado e plan continua fora', async () => {
  const hook = makePolicyHook();
  const auto = await hook({ hook_event_name: 'PreToolUse', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } } as any, undefined, { signal: new AbortController().signal });
  expect(auto.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
  const plan = await hook({ hook_event_name: 'PreToolUse', permission_mode: 'plan', tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'drop table p' } } as any, undefined, { signal: new AbortController().signal });
  expect(plan).toEqual({});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL (`makePolicyHook` não existe; `execute_sql select 1` devolve `ask`).

- [ ] **Step 3: Implement**

Em `classify`: primeiro, para `mcp__supabase__execute_sql`/`apply_migration` (campo `query`) e para `Bash` (campo `command`), se `sqlDestrutivo(...)` não é `null`, devolver `{ decision: 'ask', always: true, reason: 'SQL destrutivo: <motivo>', sql }`. Tirar `execute_sql` e `apply_migration` de `MCP_NOME_BANCO` (os `*_branch` continuam). Em `makePolicyHook`: `plan` e interativas saem como hoje; calcula `classify`; se `always`, chama `backup?.(v.sql)` com timeout de 5 min (erro vira "backup falhou: <mensagem>"; sem função vira "sem backup automático (projeto sem db_url)") e devolve `ask` com o motivo seguido do texto do backup; senão, no `auto` devolve `allow`; nos outros modos, o veredito.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/policy.test.ts tests/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/claude/policy.ts server/claude/runner.ts tests/policy.test.ts
git commit -m "feat(policy): SQL destrutivo pergunta até no modo auto; SQL comum passa direto"
```

### Task 3: Backup antes do destrutivo e `db_url` por projeto

**Files:**
- Create: `server/dbBackup.ts`
- Modify: `server/settings.ts` (chave), `server/routes/settings.ts` (rotas), `server/routes/claude.ts` (monta `backupSql` nos dois `startTurn`, linhas ~116 e ~323)
- Modify: tela de Configurações do projeto em `web/src` (campo "URL do banco de produção", mascarado)
- Test: `tests/dbBackup.test.ts`

**Interfaces:**
- Consumes: `tabelaAlvo` (Task 1), `BackupFn`/`TurnParams.backupSql` (Task 2), `getSetting`/`setSetting`/`maskToken` de `server/settings.ts`.
- Produces:
  - `dbUrlKey(projectId: number): string` → `` `db_url:${projectId}` ``.
  - `backupAntes(o: { dbUrl: string; slug: string; sql: string; dir?: string; pgDump?: string; now?: Date }): Promise<string>` (texto do cartão).
  - `dumpCompleto(o: { dbUrl: string; slug: string; dir?: string; pgDump?: string; now?: Date }): Promise<{ ok: boolean; arquivo?: string; erro?: string }>`.
  - `limparAntigos(dir: string, dias: number, now?: Date): Promise<number>`.
  - Rotas (só admin): `GET /api/projects/:id/db-url` → `{ configurado: boolean, mascarado: string | null }`; `PUT /api/projects/:id/db-url` body `{ url: string | null }` (aceita só `postgres://` ou `postgresql://`; `null` apaga).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import path from 'node:path';
import { backupAntes, limparAntigos, dbUrlKey } from '../server/dbBackup';

describe('dbBackup', () => {
  it('chama pg_dump com -t da tabela e devolve o arquivo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bk-'));
    const fake = path.join(dir, 'pg_dump'); await writeFile(fake, '#!/bin/sh\necho "$@" > "$(echo "$@" | sed -n "s/.*-f \\([^ ]*\\).*/\\1/p")"\n', { mode: 0o755 });
    const txt = await backupAntes({ dbUrl: 'postgres://u:p@h/db', slug: 'fisio', sql: 'drop table public.pacientes', dir, pgDump: fake, now: new Date('2026-09-30T12:00:00Z') });
    expect(txt).toMatch(/^backup salvo em .*fisio\/20260930-120000-public\.pacientes\.dump$/);
  });
  it('pg_dump falhando vira texto, não exceção', async () => {
    const txt = await backupAntes({ dbUrl: 'postgres://x', slug: 's', sql: 'truncate a', dir: tmpdir(), pgDump: '/bin/false' });
    expect(txt).toMatch(/^backup falhou:/);
  });
  it('limparAntigos apaga só o que passou de 7 dias', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bk-'));
    await writeFile(path.join(dir, 'velho.dump'), ''); await writeFile(path.join(dir, 'novo.dump'), '');
    const velho = new Date('2026-09-20T00:00:00Z'); await utimes(path.join(dir, 'velho.dump'), velho, velho);
    expect(await limparAntigos(dir, 7, new Date('2026-09-30T00:00:00Z'))).toBe(1);
    expect(await readdir(dir)).toEqual(['novo.dump']);
  });
  it('chave do setting', () => expect(dbUrlKey(3)).toBe('db_url:3'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dbBackup.test.ts`
Expected: FAIL, módulo não existe.

- [ ] **Step 3: Implement `server/dbBackup.ts`**

`pg_dump` padrão `/usr/bin/pg_dump`, `dir` padrão `/srv/backups/db`. Formato custom (`-Fc`, já comprimido), arquivo `<dir>/<slug>/<AAAAMMDD-HHMMSS>-<tabela|completo>.dump`, `-t <tabela>` quando `tabelaAlvo` acha uma. URL passada por argumento `--dbname`, nunca em log; na mensagem de erro, só as últimas 300 letras do stderr. Timeout 5 min (tabela) e 60 min (completo). Rotas em `server/routes/settings.ts`, só `role = 'owner'`, reusando `maskToken`. Em `routes/claude.ts`, nos dois `startTurn`: `backupSql` presente quando a sessão tem `project_id` e o setting existe, chamando `backupAntes` com o `slug` do projeto.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/dbBackup.test.ts && npm run typecheck`
Expected: PASS, typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add server/dbBackup.ts server/settings.ts server/routes/settings.ts server/routes/claude.ts web/src tests/dbBackup.test.ts
git commit -m "feat(banco): db_url por projeto e pg_dump antes de SQL destrutivo"
```

### Task 4: Backup noturno, pg_dump na c3 e teste de restore

**Files:**
- Create: `scripts/db-backup-nightly.ts` (compila para `dist/scripts/db-backup-nightly.js`, como o `seed`)
- Create: `deploy/db-backup/orion-db-backup.service`, `deploy/db-backup/orion-db-backup.timer`, `deploy/db-backup/instalar.sh`

**Interfaces:**
- Consumes: `dumpCompleto`, `limparAntigos`, `dbUrlKey` (Task 3); `DATABASE_URL` de `/etc/orion/central.env`.

- [ ] **Step 1: Implement o script**

Para cada projeto com `db_url:<id>` no settings: `dumpCompleto`, depois `limparAntigos(<dir>/<slug>, 7)`. Imprime uma linha por projeto (`ok fisioexpert 812 MB` ou `falhou fisioexpert: ...`); sai com código 1 se algum falhou.

- [ ] **Step 2: Units e instalador**

`.service`: `Type=oneshot`, `User=danilo`, `EnvironmentFile=/etc/orion/central.env`, `ExecStart=/usr/bin/node /srv/orion-live/dist/scripts/db-backup-nightly.js`. `.timer`: `OnCalendar=*-*-* 03:00:00`, `Persistent=true`. `instalar.sh` (rodar como root pelo `mcp__orion-root__exec`): instala `postgresql-client-17` pelo repositório PGDG (versão maior ou igual à do Supabase), cria `/srv/backups/db` com dono `danilo` e modo 700, copia as units e dá `systemctl enable --now orion-db-backup.timer`.

- [ ] **Step 3: Verificar**

Run: `pg_dump --version && systemctl list-timers orion-db-backup.timer`
Expected: `pg_dump (PostgreSQL) 17.x` e o timer com próxima execução às 03:00.

- [ ] **Step 4: Teste de restore (uma vez)**

Com o `db_url` do FisioExpert cadastrado: `systemctl start orion-db-backup.service`, depois `pg_restore --list <arquivo> | head` e restaurar uma tabela pequena num database descartável no `orion-postgres` (`createdb restore_teste`, `pg_restore -d ... -t <tabela>`, `select count(*)`), e `dropdb restore_teste`. Registrar o resultado (arquivo, tamanho, contagem) na descrição da tarefa.

- [ ] **Step 5: Commit, integrar e publicar**

```bash
git add scripts/db-backup-nightly.ts deploy/db-backup
git commit -m "feat(banco): backup noturno com retenção de 7 dias"
```

Publicar pela fila e conferir: `cat /srv/builds/status.json` mostra sucesso; numa sessão de teste, `mcp__supabase__execute_sql` com `select 1` roda sem cartão e `drop table tabela_que_nao_existe` mostra o cartão vermelho no modo auto.
