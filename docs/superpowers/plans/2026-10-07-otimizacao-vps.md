# Otimização das VPS (multi-host no Dash + projeto otimizacao-vps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o Dash do Orion enxergar disco/RAM/swap/containers das 4 VPS (c1, c2, c3, hostinger), não só c3, e abrir um projeto de kanban (`otimizacao-vps`) para as tarefas de limpeza/otimização que isso revelar.

**Architecture:** Reaproveita o sampler/tabela/página `/dash` que já existem para c3. Adiciona coluna `host` em `dash_samples` (hoje só `ts` + `data`), um coletor remoto separado (SSH com a chave da frota, cadência de 15 min, bem mais espaçada que o sampler local de 10s) que grava na mesma tabela, parâmetro `?host=` nas rotas existentes, e um seletor de host na página. Projeto de tarefas é scaffold simples, fora do código do Orion.

**Tech Stack:** Node/TypeScript (Fastify, pg), Vitest, React/Vite, systemd timers, SSH (chave `~danilo/.ssh/fleet_ed25519`, já em uso em `server/projetos/coletar.ts`).

**Spec:** `docs/superpowers/specs/2026-10-07-otimizacao-vps-design.md`

## Global Constraints

- Nunca mais de 1 chamada SSH por host a cada 15 min (custo de rede/latência; não é tempo real como o sampler local de 10s).
- Threshold de alerta: disco > 85% ou swap > 50% (valor exato do spec).
- Cadência do coletor remoto: 15 min (`OnUnitActiveSec=15min`).
- Slug do projeto novo: `otimizacao-vps`.
- Nenhuma ação destrutiva automática; achados viram tarefa manual.
- Alertas via WhatsApp usam o conector local `http://127.0.0.1:3000/conector/whatsapp/message/sendText/alertas` (POST, body `{"number": "<jid do grupo>", "text": "..."}`), sem token (o Orion injeta).
- `docs/infra.json` não é lido em runtime de produção (não vai no build de `orion-live`, ver comentário em `server/projetos/coletar.ts:24`); a lista de hosts remotos é uma constante no código, igual ao padrão já usado ali.

## Review Focus

- Host remoto fora do ar ou SSH falhando (timeout, chave recusada): o coletor não pode lançar nem derrubar o timer; grava amostra com `errors` preenchido e segue pro próximo host. Coberto na Task 3 (ssh com `code !== 0`) e Task 4 (loop por host com try/catch individual).
- Saída de `docker ps` vazia ou com container parado (ex.: host sem nenhum container rodando): `parseDockerPs` já devolve `[]` nesse caso (função reaproveitada, já testada); confirmar na Task 3 que isso não vira erro.
- Alerta disparando a cada ciclo de 15 min enquanto a condição persiste (ex.: disco cheio por dias): cooldown por host tem que evitar repetição antes de 1h. Coberto na Task 4.
- `?host=` com valor desconhecido (não é c1/c2/c3/hostinger) nas rotas `/api/dash/now` e `/api/dash/history`: não pode gerar erro 500 nem misturar dados de outro host; cai para lista vazia/c3. Coberto na Task 5.
- Página `/dash` aberta num host remoto sem nenhuma amostra ainda (serviço acabou de subir, primeiro ciclo de 15 min não rodou): a aba tem que mostrar "sem dado" em vez de tela quebrada ou `NaN`/`undefined` visível. Coberto na Task 6.

---

### Task 1: Tabela `dash_samples` multi-host

**Files:**
- Create: `server/dash/schema.ts`
- Modify: `server/dash/sampler.ts:118-126` (método `ensureTable`), `server/dash/sampler.ts:293-306` (método `persist`)
- Test: `tests/dashSchema.test.ts`

**Interfaces:**
- Consumes: nada de outra task.
- Produces (usado pela Task 4 e pelo próprio sampler local):
  - `export async function ensureDashSamplesTable(pool: Pool): Promise<boolean>` — true se a tabela está utilizável.
  - `export async function insertDashSample(pool: Pool, host: string, data: unknown): Promise<void>` — grava `(host, now(), data)`, ignora conflito de `(host, ts)`, poda linhas com mais de 7 dias. Nunca lança (loga e retorna, como o `persist()` atual).

- [ ] **Step 1: Escrever o teste de `ensureDashSamplesTable` e `insertDashSample` com pool fake**

```ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { ensureDashSamplesTable, insertDashSample } from '../server/dash/schema.js';

describe('dash/schema', () => {
  it('ensureDashSamplesTable cria a tabela com host na chave primária', async () => {
    const sql: string[] = [];
    const pool = { query: async (q: string) => { sql.push(q); return {}; } } as unknown as Pool;
    expect(await ensureDashSamplesTable(pool)).toBe(true);
    expect(sql.some(s => /PRIMARY KEY \(host, ts\)/.test(s))).toBe(true);
  });

  it('ensureDashSamplesTable devolve false e não lança se a query falhar', async () => {
    const pool = { query: async () => { throw new Error('sem conexão'); } } as unknown as Pool;
    expect(await ensureDashSamplesTable(pool)).toBe(false);
  });

  it('insertDashSample grava com o host certo e poda 7 dias', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const pool = { query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return {}; } } as unknown as Pool;
    await insertDashSample(pool, 'c1', { ok: true });
    expect(calls[0].sql).toMatch(/INSERT INTO dash_samples/);
    expect(calls[0].params).toEqual(['c1', JSON.stringify({ ok: true })]);
    expect(calls.some(c => /DELETE FROM dash_samples/.test(c.sql))).toBe(true);
  });

  it('insertDashSample não lança se a query falhar', async () => {
    const pool = { query: async () => { throw new Error('sem conexão'); } } as unknown as Pool;
    await expect(insertDashSample(pool, 'c1', {})).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha (módulo não existe)**

Run: `npx vitest run tests/dashSchema.test.ts`
Expected: FAIL com "Cannot find module '../server/dash/schema.js'"

- [ ] **Step 3: Implementar `server/dash/schema.ts`**

DDL exato (idempotente mesmo em cima da tabela antiga, que hoje só tem `ts timestamptz primary key, data jsonb`):

```sql
CREATE TABLE IF NOT EXISTS dash_samples (host text NOT NULL DEFAULT 'c3', ts timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL, PRIMARY KEY (host, ts));
ALTER TABLE dash_samples ADD COLUMN IF NOT EXISTS host text NOT NULL DEFAULT 'c3';
ALTER TABLE dash_samples DROP CONSTRAINT IF EXISTS dash_samples_pkey;
ALTER TABLE dash_samples ADD CONSTRAINT dash_samples_pkey PRIMARY KEY (host, ts);
```

`insertDashSample`: `INSERT INTO dash_samples (host, ts, data) VALUES ($1, now(), $2::jsonb) ON CONFLICT (host, ts) DO NOTHING` com params `[host, JSON.stringify(data)]`, seguido de `DELETE FROM dash_samples WHERE ts < now() - interval '7 days'`. Mesmo padrão de try/catch + log de aviso que existe hoje em `sampler.ts persist()`.

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run tests/dashSchema.test.ts`
Expected: PASS

- [ ] **Step 5: Trocar `sampler.ts` para usar o helper**

Em `ensureTable()` (linha 118-126): substitui o `CREATE TABLE` direto por `this.tableOk = await ensureDashSamplesTable(this.pool)`.
Em `persist()` (linha 293-306): substitui os dois `pool.query` (INSERT e DELETE) por `await insertDashSample(this.pool, this.opts.label ?? HOST_LABEL, agg)`, mantendo o `ensureTable()` chamado antes e o try/catch de log existente ao redor.

- [ ] **Step 6: Rodar a suíte completa do dash para confirmar que nada quebrou**

Run: `npx vitest run tests/dash.test.ts tests/dashSchema.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/dash/schema.ts server/dash/sampler.ts tests/dashSchema.test.ts
git commit -m "feat: dash_samples ganha coluna host, extrai schema compartilhado do sampler"
```

---

### Task 2: SSH compartilhado para a frota

**Files:**
- Create: `server/ssh.ts`
- Modify: `server/projetos/coletar.ts:169-176` (função `backupsC2`)
- Test: `tests/ssh.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces (usado pela Task 3):
  - `export function sshArgs(ip: string, cmd: string, key?: string): string[]` — pura, monta o argv do `ssh` (sem executar nada).
  - `export async function runSsh(ip: string, cmd: string, timeoutMs?: number): Promise<{ code: number; out: string }>` — executa via `execFile('ssh', sshArgs(ip, cmd), ...)`, nunca lança (`code: 1` em qualquer erro, como o `run()` de `coletar.ts`).

- [ ] **Step 1: Escrever o teste de `sshArgs`**

```ts
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { sshArgs } from '../server/ssh.js';

describe('sshArgs', () => {
  it('monta o argv com a chave da frota e BatchMode', () => {
    const key = path.join(os.homedir(), '.ssh/fleet_ed25519');
    expect(sshArgs('212.47.70.170', 'echo oi')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-i', key, 'root@212.47.70.170', 'echo oi',
    ]);
  });
  it('aceita chave custom (para teste)', () => {
    expect(sshArgs('1.2.3.4', 'ls', '/tmp/key')).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-i', '/tmp/key', 'root@1.2.3.4', 'ls',
    ]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/ssh.test.ts`
Expected: FAIL com "Cannot find module '../server/ssh.js'"

- [ ] **Step 3: Implementar `server/ssh.ts`**

`sshArgs` monta exatamente o array acima (chave default `path.join(os.homedir(), '.ssh/fleet_ed25519')`). `runSsh` usa `execFile('ssh', sshArgs(ip, cmd), { timeout: timeoutMs ?? 15_000, maxBuffer: 8*1024*1024, encoding: 'utf8' })` dentro de um `Promise` que nunca rejeita (mesmo corpo de `run()` em `coletar.ts:16-19`, só que exportado e genérico).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/ssh.test.ts`
Expected: PASS

- [ ] **Step 5: Trocar `backupsC2` em `coletar.ts` para usar `runSsh`**

Remove a construção manual de `key`/`cmd`/`run('ssh', [...])` (linhas 170-172) e chama `runSsh('212.47.70.170', cmd, 15_000)` importado de `../ssh.js`.

- [ ] **Step 6: Rodar os testes de projetos/coletar para confirmar que não quebrou**

Run: `npx vitest run tests/` (ou o arquivo específico de coletar, se existir; senão a suíte completa)
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/ssh.ts server/projetos/coletar.ts tests/ssh.test.ts
git commit -m "refactor: extrai runSsh/sshArgs compartilhados da frota"
```

---

### Task 3: Coleta remota (mem/disco/docker por SSH)

**Files:**
- Create: `server/dash/remoteHosts.ts`
- Create: `server/dash/remoteSample.ts`
- Test: `tests/remoteSample.test.ts`

**Interfaces:**
- Consumes: `runSsh` (Task 2); `parseMeminfo`, `parseDf`, `parseDockerPs` de `server/dash/parse.ts` (já existem e já são testados).
- Produces (usado pela Task 4):
  - `export const REMOTE_HOSTS: { label: string; ip: string }[]` — `[{label:'c1', ip:'86.48.28.10'}, {label:'c2', ip:'212.47.70.170'}, {label:'hostinger', ip:'72.61.135.82'}]`.
  - `export type RemoteSample = { host: string; ts: string; mem: ReturnType<typeof import('./parse.js').parseMeminfo> | null; fs: ReturnType<typeof import('./parse.js').parseDf> | null; docker: ReturnType<typeof import('./parse.js').parseDockerPs> | null; errors: string[] }`
  - `export function parseRemoteOutput(raw: string): { mem: string; df: string; docker: string }` — pura.
  - `export async function collectRemoteSample(host: { label: string; ip: string }, ssh?: (ip: string, cmd: string, timeoutMs?: number) => Promise<{ code: number; out: string }>): Promise<RemoteSample>` — `ssh` default é `runSsh`, injetável no teste.

- [ ] **Step 1: Escrever o teste de `parseRemoteOutput` e `collectRemoteSample`**

```ts
import { describe, it, expect } from 'vitest';
import { parseRemoteOutput, collectRemoteSample, REMOTE_HOSTS } from '../server/dash/remoteSample.js';

const MEM = 'MemTotal:       12288000 kB\nMemFree:         2048000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n';
const DF = 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1   290000000 12000000 270000000       5% /\n';
const DOCKER = '{"Names":"n8n","Status":"Up 3 days","State":"running","Image":"n8nio/n8n"}\n';
const COMBINED = `${MEM}---DF---\n${DF}---DOCKER---\n${DOCKER}`;

describe('remoteSample', () => {
  it('REMOTE_HOSTS tem os 3 hosts remotos com os IPs de docs/infra.json', () => {
    expect(REMOTE_HOSTS).toEqual([
      { label: 'c1', ip: '86.48.28.10' }, { label: 'c2', ip: '212.47.70.170' }, { label: 'hostinger', ip: '72.61.135.82' },
    ]);
  });

  it('parseRemoteOutput separa as 3 seções pelos delimitadores', () => {
    const r = parseRemoteOutput(COMBINED);
    expect(r.mem).toContain('MemTotal');
    expect(r.df).toContain('/dev/sda1');
    expect(r.docker).toContain('n8n');
  });

  it('collectRemoteSample parseia mem/fs/docker quando o ssh responde bem', async () => {
    const s = await collectRemoteSample({ label: 'c1', ip: '86.48.28.10' }, async () => ({ code: 0, out: COMBINED }));
    expect(s.host).toBe('c1');
    expect(s.mem?.swap_pct).toBe(50);
    expect(s.fs?.pct).toBe(5);
    expect(s.docker).toEqual([{ name: 'n8n', status: 'Up 3 days', state: 'running', image: 'n8nio/n8n' }]);
    expect(s.errors).toEqual([]);
  });

  it('collectRemoteSample marca erros sem lançar quando o ssh falha', async () => {
    const s = await collectRemoteSample({ label: 'c2', ip: '212.47.70.170' }, async () => ({ code: 1, out: '' }));
    expect(s.mem).toBeNull();
    expect(s.fs).toBeNull();
    expect(s.docker).toBeNull();
    expect(s.errors).toEqual(['ssh', '/proc/meminfo', 'df /']);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/remoteSample.test.ts`
Expected: FAIL com "Cannot find module"

- [ ] **Step 3: Implementar `server/dash/remoteHosts.ts` e `server/dash/remoteSample.ts`**

`REMOTE_CMD` combina os 3 comandos com delimitadores únicos (`---DF---`, `---DOCKER---`): `cat /proc/meminfo; echo '---DF---'; df -kP /; echo '---DOCKER---'; docker ps --format '{{json .}}'`. `parseRemoteOutput` faz `raw.split('---DF---')` e depois `split('---DOCKER---')` na segunda parte. `collectRemoteSample` chama `ssh(host.ip, REMOTE_CMD, 12_000)`; se `code !== 0` empurra `'ssh'` em `errors` e não tenta parsear `docker` (fica `null`); sempre tenta `parseMeminfo`/`parseDf` nas seções (mesmo com `code !== 0` e `out` vazio, os parsers devolvem `null` e o `errors` ganha `/proc/meminfo` / `df /`, replicando o padrão de `errors` do `sampler.ts tick()`).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/remoteSample.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/dash/remoteHosts.ts server/dash/remoteSample.ts tests/remoteSample.test.ts
git commit -m "feat: coleta remota de mem/disco/docker por SSH (c1, c2, hostinger)"
```

---

### Task 4: Script do timer remoto + alerta por WhatsApp

**Files:**
- Create: `scripts/vpsRemoteSampler.ts`
- Create: `deploy/orion-vps-remote.service`
- Create: `deploy/orion-vps-remote.timer`
- Test: `tests/vpsAlerta.test.ts`

**Interfaces:**
- Consumes: `REMOTE_HOSTS`, `collectRemoteSample` (Task 3); `insertDashSample` (Task 1); `getSetting`, `setSetting` de `server/settings.ts` (já existem, assinatura `getSetting(pool, key): Promise<string|null>`, `setSetting(pool, key, value, userId: number|null): Promise<void>`); `createPool` de `server/db.js`, `migrate` de `server/migrations.js` (mesmo padrão de `scripts/inventory.ts`).
- Produces: nada consumido por outra task (script final, chamado só pelo timer).
  - `export function shouldAlert(pct: { disk: number | null; swap: number | null }, lastAlertIso: string | null, now: number, cooldownMs?: number): { alerta: boolean; motivo: string | null }` — pura, exportada do próprio script para o teste importar.

- [ ] **Step 1: Escrever o teste de `shouldAlert`**

```ts
import { describe, it, expect } from 'vitest';
import { shouldAlert } from '../scripts/vpsRemoteSampler.js';

describe('shouldAlert', () => {
  it('não alerta quando disco e swap estão normais', () => {
    expect(shouldAlert({ disk: 50, swap: 10 }, null, Date.now())).toEqual({ alerta: false, motivo: null });
  });
  it('alerta na primeira vez que disco > 85 ou swap > 50', () => {
    expect(shouldAlert({ disk: 90, swap: 10 }, null, Date.now())).toMatchObject({ alerta: true, motivo: expect.stringContaining('disco 90%') });
    expect(shouldAlert({ disk: 10, swap: 60 }, null, Date.now())).toMatchObject({ alerta: true, motivo: expect.stringContaining('swap 60%') });
  });
  it('não repete antes do cooldown (1h default), repete depois', () => {
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    expect(shouldAlert({ disk: 90, swap: 10 }, new Date(t0).toISOString(), t0 + 30 * 60_000)).toEqual({ alerta: false, motivo: null });
    expect(shouldAlert({ disk: 90, swap: 10 }, new Date(t0).toISOString(), t0 + 61 * 60_000).alerta).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/vpsAlerta.test.ts`
Expected: FAIL com "Cannot find module '../scripts/vpsRemoteSampler.js'"

- [ ] **Step 3: Implementar `scripts/vpsRemoteSampler.ts`**

`shouldAlert`: `disk = pct.disk !== null && pct.disk > 85`, `swap = pct.swap !== null && pct.swap > 50` (85/50 exatos do spec); sem gatilho → `{alerta:false, motivo:null}`; com gatilho, calcula `last = lastAlertIso ? Date.parse(lastAlertIso) : 0` e só alerta se `now - last >= (cooldownMs ?? 60*60_000)`; `motivo` junta `disco N%` e/ou `swap N%` (`toFixed(0)`) com `' e '`.

`main()` (não exportado, só chamado em `main().catch(...)` no fim do arquivo, mesmo padrão de `scripts/inventory.ts`):
1. `createPool()`, `migrate(pool)`.
2. Para cada host de `REMOTE_HOSTS`: `collectRemoteSample(host)` dentro de `try/catch` individual (um host fora do ar não pode derrubar os outros); monta o ponto `{ t: Date.now(), mem_used_pct: sample.mem?.pct ?? null, swap_pct: sample.mem?.swap_pct ?? null, fs_pct: sample.fs?.pct ?? null, docker: sample.docker, errors: sample.errors }`; `insertDashSample(pool, host.label, ponto)`.
3. Checa `shouldAlert({ disk: sample.fs?.pct ?? null, swap: sample.mem?.swap_pct ?? null }, await getSetting(pool, \`vps_alerta_${host.label}\`), Date.now())`; se `alerta`, `fetch('http://127.0.0.1:3000/conector/whatsapp/message/sendText/alertas', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ number: 'alertas@g.us', text: \`⚠️ ${host.label}: ${motivo}\` }) })` (tolerante a falha, só loga) e grava `await setSetting(pool, \`vps_alerta_${host.label}\`, new Date().toISOString(), null)`.
4. `console.log` com resumo (host, erros, se alertou), igual ao estilo de log de `scripts/inventory.ts`.
5. `await pool.end()`.

Nota: o `number`/JID exato do grupo "alertas" é o mesmo já usado pelo conector WhatsApp do Orion (`55...@g.us` ou o alias `alertas` que o gateway aceita); não inventar outro grupo.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/vpsAlerta.test.ts`
Expected: PASS

- [ ] **Step 5: Criar os unit files do timer (mesmo padrão de `deploy/orion-inventory.service`/`.timer`)**

`deploy/orion-vps-remote.service`:
```ini
[Unit]
Description=Orion – coleta remota de métricas das VPS (c1, c2, hostinger)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
User=danilo
WorkingDirectory=/srv/orion-live
Environment=ORION_REPO=/srv/orion
EnvironmentFile=/etc/orion/central.env
ExecStart=/usr/bin/node /srv/orion-live/dist/scripts/vpsRemoteSampler.js
TimeoutStartSec=60
Nice=10
```

`deploy/orion-vps-remote.timer`:
```ini
[Unit]
Description=Orion – métricas remotas das VPS a cada 15 min

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
Persistent=true
Unit=orion-vps-remote.service

[Install]
WantedBy=timers.target
```

(Instalar e habilitar o timer na c3 é passo de infra fora deste plano de código; fica registrado aqui para quem fizer o deploy saber que precisa copiar pra `/etc/systemd/system/` e rodar `systemctl daemon-reload && systemctl enable --now orion-vps-remote.timer` — ação que usa `orion-root`, não este plano.)

- [ ] **Step 6: Commit**

```bash
git add scripts/vpsRemoteSampler.ts deploy/orion-vps-remote.service deploy/orion-vps-remote.timer tests/vpsAlerta.test.ts
git commit -m "feat: timer de 15min coleta métricas remotas e alerta por WhatsApp"
```

---

### Task 5: `?host=` nas rotas do Dash

**Files:**
- Modify: `server/routes/dash.ts:22-25` (`/api/dash/now`), `server/routes/dash.ts:27-55` (`/api/dash/history`)
- Test: `tests/dashHostRoute.test.ts`

**Interfaces:**
- Consumes: `REMOTE_HOSTS` (Task 3), para validar o host pedido.
- Produces: nada consumido por outra task do backend; a Task 6 consome o formato de resposta (`{host, hours, rows, stats, minutes_7d}` com `rows`/`stats` vazios quando o host não tem amostra, igual ao `empty` que já existe).

- [ ] **Step 1: Escrever o teste de validação de host**

```ts
import { describe, it, expect } from 'vitest';
import { hostValido } from '../server/routes/dash.js';

describe('hostValido', () => {
  it('aceita c3 e os remotos conhecidos', () => {
    expect(hostValido('c3')).toBe('c3');
    expect(hostValido('c1')).toBe('c1');
    expect(hostValido('hostinger')).toBe('hostinger');
  });
  it('cai para c3 em host desconhecido ou ausente', () => {
    expect(hostValido('xyz')).toBe('c3');
    expect(hostValido(undefined)).toBe('c3');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run tests/dashHostRoute.test.ts`
Expected: FAIL (`hostValido` não exportado)

- [ ] **Step 3: Implementar `hostValido` e usar nas duas rotas**

`export function hostValido(h: unknown): string { const hosts = ['c3', ...REMOTE_HOSTS.map(x => x.label)]; return typeof h === 'string' && hosts.includes(h) ? h : 'c3'; }`

`/api/dash/now`: só responde com dado ao vivo (`sampler.latest()`/`sampler.series()`) quando `hostValido(req.query.host) === 'c3'` (é o único com sampler em memória); para host remoto devolve `{ host: { label, ip: REMOTE_HOSTS.find(...)?.ip ?? null }, tick_ms: null, sample: null, series: [] }` (o painel usa o histórico pra esses, ver Task 6).

`/api/dash/history`: adiciona `WHERE host = $N AND ts > ...` (hoje a query não filtra host; vira `WHERE host = $2 AND ts > now() - $1::int * interval '1 hour'`), passando `hostValido(req.query.host)` como parâmetro em todas as 3 queries (`rows`, `stats`, `minutes_7d`).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/dashHostRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Rodar a suíte do dash inteira (rotas + sampler) pra não quebrar o fluxo de c3**

Run: `npx vitest run tests/dash.test.ts tests/dashSchema.test.ts tests/dashHostRoute.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/dash.ts tests/dashHostRoute.test.ts
git commit -m "feat: rotas do dash aceitam ?host= (c1/c2/c3/hostinger)"
```

---

### Task 6: Seletor de host na página `/dash`

**Files:**
- Modify: `web/src/pages/Dash.tsx` (estado `now`/`hist`/`series`, seção "Nossa VPS" linha 238-288)

**Interfaces:**
- Consumes: `/api/dash/now?host=`, `/api/dash/history?hours=24&host=` (Task 5).
- Produces: nada (fim da cadeia visual).

Sem Task de teste dedicada: é mudança de UI consumida visualmente; a cobertura fica nos testes de `tests/dash.test.ts` (parsers/sampler) e `tests/dashHostRoute.test.ts` (rota) que já garantem os dados corretos chegando. Verificação é manual (Step 3).

- [ ] **Step 1: Adicionar estado de host e refazer `loadNow`/`loadHist` para incluir `?host=`**

Novo estado `const [host, setHost] = useState<'c3'|'c1'|'c2'|'hostinger'>('c3')`. `loadNow`/`loadHist` passam `?host=${host}` na URL e reexecutam (`useEffect` com `[host]` nas dependências, re-chamando `loadNow()`/`loadHist()` quando o host muda; a troca de host também zera `series`/`hist` antes de buscar, pra não misturar sparkline de hosts diferentes). O stream SSE (`/api/dash/stream`) continua fixo em c3 (é o único com sampler ao vivo); ao trocar para host remoto, `live` fica `false` e o polling de 15s não roda (só a cada 15 min faz sentido puxar `/now`, mas reusar o polling existente é inofensivo e mais simples que criar um segundo timer).

- [ ] **Step 2: Adicionar o seletor de abas acima da seção "Nossa VPS" (linha ~238)**

4 botões (`c1`, `c2`, `c3`, `hostinger`), classe ativa no host atual, `onClick={() => setHost(h)}`. Pros hosts remotos, os cards que dependem só de série de 10s/CPU/PSI/rede/TCP/processos (que não existem na amostra remota) mostram "sem dado" (os campos já são opcionais no tipo `Sample` do componente — `cpu?`, `psi?` etc. — então basta checar `s` vindo vazio/null pros campos não coletados remotamente e esses cards caem no `'—'` que os `Card`/`fmtPct` já produzem para `null`).

- [ ] **Step 3: Testar manualmente no navegador**

Rodar `npm run dev` (ambiente local) ou validar após publicar: abrir `/dash`, trocar pra `c1`/`hostinger`, confirmar que os cards de disco/RAM/swap/docker mudam e os que não se aplicam mostram `—` sem quebrar a tela. Registrar aqui que foi verificado antes de considerar a task concluída.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Dash.tsx
git commit -m "feat: seletor de host (c1/c2/c3/hostinger) na página Dash"
```

---

### Task 7: Projeto `otimizacao-vps`

**Files:** nenhum arquivo do repo Orion; scaffold fora do código.

**Interfaces:** nenhuma (task operacional, não consumida por código).

Sem TDD: não é lógica, é scaffold (seguindo a convenção já confirmada — hoje criar projeto é 100% manual, sem rota no painel). Verificação é o próprio resultado (pasta existe, projeto aparece no painel).

- [ ] **Step 1: Criar a pasta e o conteúdo inicial**

```bash
mkdir -p /srv/projects/otimizacao-vps
cd /srv/projects/otimizacao-vps
git init
cat > README.md <<'EOF'
# Otimização das VPS

Projeto contínuo de performance, recursos, organização e limpeza das 4 VPS
(c1, c2, c3, hostinger). Achados vêm da aba /dash multi-host do Orion
(disco, RAM, swap, containers por host) e viram tarefa aqui.

Ações destrutivas (apagar container, matar processo, redimensionar) nunca
são automáticas: sempre tarefa com aprovação manual.
EOF
git add README.md
git commit -m "chore: scaffold inicial do projeto otimizacao-vps"
```

- [ ] **Step 2: Registrar o projeto no Postgres do Orion**

```bash
docker exec orion-postgres psql -U orion orion -c \
  "INSERT INTO projects (slug, name, path, rules) VALUES ('otimizacao-vps', 'Otimização das VPS', '/srv/projects/otimizacao-vps', NULL) ON CONFLICT (slug) DO NOTHING;"
```

- [ ] **Step 3: Confirmar que o projeto aparece no painel**

Abrir o seletor de projetos do Orion (ou `GET /api/claude/projects` autenticado) e checar que `otimizacao-vps` está na lista.

---

## Self-Review

**Cobertura do spec:** schema multi-host (Task 1), coleta remota (Tasks 2-3), timer + alerta (Task 4), API (Task 5), UI (Task 6), projeto de tarefas (Task 7). As 8 decisões fechadas do spec (alvo, objetivo, formato, gatilho, reaproveitamento, slug, cadência, threshold) aparecem todas nos Global Constraints ou nas tasks correspondentes.

**Checagem de passos:** nenhum passo ficou com "TBD"/"tratar depois"; os corpos de função com algoritmo (DDL do schema, parsing dos delimitadores, `shouldAlert`, `hostValido`) vieram com a lógica exata porque o spec fixa os valores (85/50, 15 min, nomes de coluna); os demais passos são assinatura + teste, sem corpo.

**Consistência de tipos:** `insertDashSample(pool, host, data)` (Task 1) é o mesmo usado em `sampler.ts` (Task 1) e no script da Task 4; `collectRemoteSample`/`RemoteSample` (Task 3) é o único shape usado pela Task 4; `REMOTE_HOSTS` (Task 3) é a mesma lista usada nas Tasks 4 e 5 (`hostValido`).

**Review Focus:** as 5 situações (host remoto fora do ar, docker vazio, alerta repetindo, `?host=` inválido, página sem amostra ainda) têm teste ou passo de verificação na task que é dona do código: Tasks 3, 3, 4, 5, 6 respectivamente.

**Proporção:** plano ~3x o tamanho do spec (normal, por ter 7 tasks com teste); nenhum passo virou transcrição de corpo que a assinatura+teste já determinava, exceto onde o spec fixa o algoritmo (threshold, DDL, delimitadores).
