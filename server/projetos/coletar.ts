import { execFile } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { Pool } from 'pg';
import { lerStatus } from '../deploy/estado.js';
import { listarContasCloudflare } from '../tools/cloudflareAccounts.js';

// Ficha de cada projeto para a seção Projetos do Dash. Tudo é lido na hora (git, arquivos do repo,
// Cloudflare, SSH na c2) e cacheado pela rota; nada é gravado, a não ser o `meta` manual do projeto.
// Nunca devolve valor de segredo: das variáveis de ambiente só saem os NOMES.

type Ran = { code: number; out: string };
function run(cmd: string, args: string[], cwd: string, timeout = 10_000): Promise<Ran> {
  return new Promise(resolve => execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' } },
    (err, out) => resolve({ code: err ? 1 : 0, out: String(out ?? '').trim() })));
}
const git = (cwd: string, args: string[]) => run('git', ['-c', 'safe.directory=*', '-c', 'core.quotePath=false', ...args], cwd);
const mtime = (f: string) => stat(f).then(s => s.mtime.toISOString()).catch(() => null);
const ler = (f: string) => readFile(f, 'utf8').catch(() => null);

// Servidores conhecidos (docs/infra.json, repetido aqui porque o live não leva docs/).
const SERVIDORES: Record<string, string> = { '86.48.28.10': 'c1', '212.47.70.170': 'c2', '217.76.55.249': 'c3', '72.61.135.82': 'hostinger' };
const ehCloudflare = (ip: string) => /^(104\.(1[6-9]|2[0-7])|172\.(6[4-9]|7[01])|188\.114\.|162\.159\.)/.test(ip);
export function servidorDoIp(ip: string | null): string | null {
  if (!ip) return null;
  return SERVIDORES[ip] ?? (ehCloudflare(ip) ? 'Cloudflare' : ip);
}

/** Remove usuário/senha embutidos na URL do remote (token de push não pode ir para a tela). */
export function semCredencial(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//');
}

export type Banco = { tipo: string; onde: string; ref: string; url: string; principal: boolean; mencoes: number };

/** Classifica as URLs de banco achadas no repo. `refConfig` = project_id do supabase/config.toml (o banco principal). */
export function classificarBancos(urls: string[], refConfig: string | null): Omit<Banco, 'onde'>[] {
  const cont = new Map<string, number>();
  for (const u of urls) cont.set(u, (cont.get(u) ?? 0) + 1);
  const out: Omit<Banco, 'onde'>[] = [];
  for (const [url, n] of cont) {
    if (/\/\/xxx\./.test(url)) continue; // placeholder de exemplo
    const nuvem = url.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co$/);
    if (nuvem) { out.push({ tipo: 'Supabase nuvem', ref: nuvem[1], url, principal: nuvem[1] === refConfig, mencoes: n }); continue; }
    const host = url.replace(/^https?:\/\//, '');
    out.push({ tipo: 'Supabase self-hosted', ref: host.split('.')[0], url, principal: false, mencoes: n });
  }
  if (!out.some(b => b.principal) && out.length) out.sort((a, b) => b.mencoes - a.mencoes)[0].principal = true;
  return out.sort((a, b) => Number(b.principal) - Number(a.principal) || b.mencoes - a.mencoes);
}

const ENV_EMBUTIDAS = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'PORT', 'HOME', 'PATH', 'TZ', 'CI']);
/** Nomes de variável de um .env (só as chaves). */
export function chavesEnv(texto: string): string[] {
  return texto.split('\n').map(l => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter((x): x is string => !!x);
}
/** Nomes de variável que o código lê (import.meta.env.X, process.env.X, Deno.env.get('X')). */
export function envUsadas(linhas: string): { app: string[]; edge: string[] } {
  const app = new Set<string>(), edge = new Set<string>();
  for (const m of linhas.matchAll(/(?:import\.meta\.env|process\.env)\.([A-Z_][A-Z0-9_]*)/g)) if (!ENV_EMBUTIDAS.has(m[1])) app.add(m[1]);
  for (const m of linhas.matchAll(/Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)/g)) edge.add(m[1]);
  return { app: [...app].sort(), edge: [...edge].sort() };
}

/** Primeiros parágrafos de texto corrido de um CLAUDE.md/README (sem títulos, listas de código nem badges). */
export function resumoDoc(md: string, max = 600): string {
  const sem = md.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const pars = sem.split(/\n\s*\n/).map(p => p.trim()).filter(p => p && !p.startsWith('#') && !p.startsWith('![') && !p.startsWith('|') && !p.startsWith('<') && !/^(---|\*\*\*|[-*+] |\d+\. |TODO)/.test(p));
  let out = '';
  for (const p of pars) {
    if (out.length >= max) break;
    out += (out ? '\n\n' : '') + p;
  }
  return out.length > max ? out.slice(0, max).replace(/\s+\S*$/, '') + '…' : out;
}

const STACK: [RegExp, string][] = [
  [/^react$/, 'React'], [/^vite$/, 'Vite'], [/^next$/, 'Next.js'], [/^vue$/, 'Vue'], [/^svelte$/, 'Svelte'], [/^astro$/, 'Astro'],
  [/^fastify$/, 'Fastify'], [/^express$/, 'Express'], [/^hono$/, 'Hono'], [/^@supabase\/supabase-js$/, 'Supabase'], [/^pg$/, 'Postgres (pg)'],
  [/^prisma$|^@prisma\/client$/, 'Prisma'], [/^drizzle-orm$/, 'Drizzle'], [/^tailwindcss$/, 'Tailwind'], [/^typescript$/, 'TypeScript'],
  [/^@capacitor\/core$/, 'Capacitor'], [/^@anthropic-ai\//, 'Claude SDK'], [/^@tanstack\/react-query$/, 'React Query'], [/^@radix-ui\//, 'shadcn/Radix'],
];

export type Alerta = { nivel: 'ruim' | 'atencao'; texto: string };

export type Ficha = {
  id: number; slug: string; name: string; path: string; existe: boolean;
  meta: { prod_url?: string; banco?: string; notas?: string };
  git: null | {
    branch: string; remote: string | null; github: string | null; ultimo: { sha: string; quando: string; autor: string; msg: string } | null;
    upstream: string | null; ahead: number | null; behind: number | null; ultimo_push: string | null; sujos: number; commits_7d: number;
    worktrees: { path: string; branch: string }[];
  };
  bancos: Banco[]; banco_fonte: string | null;
  arquitetura: { stack: string[]; resumo: string; fonte: string | null; atualizado: string | null; pastas: string[]; edge_functions: number };
  sessoes: { id: string; title: string; status: string; quem: string; quando: string; tokens: number }[];
  sessoes_total: number;
  tokens: { quem: string; t7: number; t30: number }[];
  tarefas: { id: number; title: string; status: string; integracao: string | null; quem: string | null; quando: string }[];
  ultimo_mexeu: { quem: string; quando: string; onde: string } | null;
  backup: { itens: { oque: string; quando: string | null; detalhe: string }[] };
  deploy: null | { onde: string; quando: string | null; estado: string; detalhe: string; dominios: string[] };
  preview_url: string | null;
  prod: null | { url: string; status: number | null; ms: number | null; ip: string | null; servidor: string | null; ssl_expira: string | null; erro: string | null };
  env: { usadas: string[]; faltando: string[]; edge: string[]; definidas: number; fonte: string[] };
  conectores: string[];
  alertas: Alerta[];
  coletado: string;
};

type Proj = { id: number; slug: string; name: string; path: string; meta: Ficha['meta'] | null };

// ---------- fontes externas (uma vez por coleta, não por projeto) ----------

type Pages = { name: string; dominios: string[]; repo: string; quando: string | null; estado: string; commit: string; conta: string };
async function paginasCloudflare(pool: Pool): Promise<Pages[]> {
  const contas = await listarContasCloudflare(pool).catch(() => []);
  const out: Pages[] = [];
  await Promise.all(contas.map(async c => {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.account_id}/pages/projects`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(8000) });
      const j = (await r.json()) as { result?: any[] };
      for (const p of j.result ?? []) {
        const d = p.latest_deployment ?? {};
        out.push({ name: p.name, dominios: p.domains ?? [], repo: p.source?.config?.repo_name ?? '', quando: d.created_on ?? null,
          estado: d.latest_stage?.status ?? '', commit: String(d.deployment_trigger?.metadata?.commit_hash ?? '').slice(0, 7), conta: c.label });
      }
    } catch { /* conta fora do ar: segue sem */ }
  }));
  return out;
}

/** Backups da c2 (Supabase self-hosted): último "backup c2 OK" do restic para o Drive e o último pg_dumpall local. */
async function backupsC2(): Promise<{ drive: string | null; dump: string | null }> {
  const key = path.join(os.homedir(), '.ssh/fleet_ed25519');
  const cmd = `grep "backup c2 OK" /root/backups/backup-drive.log | tail -1; ls -t --time-style=+%FT%T%z -l /opt/supabase/backups/*.sql.gz 2>/dev/null | head -1 | awk '{print $6}'`;
  const r = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-i', key, 'root@212.47.70.170', cmd], '/', 15_000);
  const [l1 = '', l2 = ''] = r.out.split('\n');
  const m = l1.match(/\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/);
  return { drive: m ? new Date(m[1].replace(' ', 'T') + '+02:00').toISOString() : null, dump: l2 ? new Date(l2.replace(/(\d\d)(\d\d)$/, '$1:$2')).toISOString() : null };
}

async function checarProd(url: string): Promise<NonNullable<Ficha['prod']>> {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const res: NonNullable<Ficha['prod']> = { url, status: null, ms: null, ip: null, servidor: null, ssl_expira: null, erro: null };
  const t0 = Date.now();
  await Promise.all([
    fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) }).then(r => { res.status = r.status; res.ms = Date.now() - t0; }).catch(e => { res.erro = String((e as Error).cause ?? (e as Error).message); }),
    host ? dns.resolve4(host).then(ips => { res.ip = ips[0] ?? null; res.servidor = servidorDoIp(res.ip); }).catch(() => {}) : null,
    host && url.startsWith('https') ? new Promise<void>(ok => {
      const s = tls.connect({ host, port: 443, servername: host, timeout: 6000 }, () => {
        const v = s.getPeerCertificate()?.valid_to; if (v) res.ssl_expira = new Date(v).toISOString(); s.end(); ok();
      });
      s.on('error', () => ok()); s.on('timeout', () => { s.destroy(); ok(); });
    }) : null,
  ]);
  return res;
}

// ---------- por projeto ----------

async function coletarGit(dir: string): Promise<Ficha['git']> {
  if ((await git(dir, ['rev-parse', '--git-dir'])).code !== 0) return null;
  const [br, rem, last, up, sujo, c7, wt] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), git(dir, ['remote', 'get-url', 'origin']), git(dir, ['log', '-1', '--format=%h%x1f%cI%x1f%an%x1f%s']),
    git(dir, ['rev-parse', '--abbrev-ref', '@{u}']), git(dir, ['status', '--porcelain']), git(dir, ['rev-list', '--count', '--since=7.days', 'HEAD']),
    git(dir, ['worktree', 'list', '--porcelain']),
  ]);
  const branch = br.out || '?';
  const remote = rem.code === 0 && rem.out ? semCredencial(rem.out) : null;
  let upstream = up.code === 0 ? up.out : null;
  if (!upstream && remote && (await git(dir, ['rev-parse', '--verify', '-q', `origin/${branch}`])).code === 0) upstream = `origin/${branch}`;
  let ahead: number | null = null, behind: number | null = null, ultimo_push: string | null = null;
  if (upstream) {
    const [lr, lp] = await Promise.all([git(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]), git(dir, ['log', '-1', '--format=%cI', upstream])]);
    const [b, a] = lr.out.split(/\s+/).map(Number);
    if (Number.isFinite(a)) { ahead = a; behind = b; }
    ultimo_push = lp.out || null;
  }
  const [sha = '', quando = '', autor = '', msg = ''] = last.out.split('\x1f');
  const worktrees: { path: string; branch: string }[] = [];
  let cur: { path: string; branch: string } | null = null;
  for (const l of wt.out.split('\n')) {
    if (l.startsWith('worktree ')) { cur = { path: l.slice(9), branch: '' }; worktrees.push(cur); }
    else if (l.startsWith('branch ') && cur) cur.branch = l.slice(7).replace('refs/heads/', '');
  }
  const gh = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1] ?? null;
  return {
    branch, remote, github: gh, ultimo: sha ? { sha, quando, autor, msg } : null, upstream, ahead, behind, ultimo_push,
    sujos: sujo.out ? sujo.out.split('\n').length : 0, commits_7d: Number(c7.out) || 0, worktrees: worktrees.slice(1),
  };
}

async function coletarRepo(dir: string, ehOrion: boolean) {
  const RE_DB = String.raw`https://[a-z0-9]{20}\.supabase\.co|https://[a-z0-9-]*supabase[a-z0-9-]*\.bayerl\.cloud`;
  const RE_ENV = String.raw`(import\.meta\.env|process\.env)\.[A-Z_][A-Z0-9_]*|Deno\.env\.get\([[:space:]]*['"][A-Z_0-9]+`;
  const envArqs = ['.env', '.env.local', '.env.development', '.env.production', '.env.development.local', '.env.production.local'];
  const [dbGrep, envGrep, cfg, pkg, claude, readme, funcs, top, envs, exemplo] = await Promise.all([
    git(dir, ['grep', '-I', '-h', '-o', '-E', RE_DB, '--', '.', ':!*.md', ':!**/node_modules/**']),
    git(dir, ['grep', '-I', '-h', '-o', '-E', RE_ENV, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', ':!**/node_modules/**', ':!tests/**', ':!**/*.test.*']),
    ler(path.join(dir, 'supabase/config.toml')), ler(path.join(dir, 'package.json')),
    ler(path.join(dir, 'CLAUDE.md')), ler(path.join(dir, 'README.md')),
    readdir(path.join(dir, 'supabase/functions'), { withFileTypes: true }).catch(() => []),
    readdir(dir, { withFileTypes: true }).catch(() => []),
    Promise.all(envArqs.map(async f => ({ f, t: await ler(path.join(dir, f)) }))),
    ler(path.join(dir, '.env.example')),
  ]);
  // URLs de banco também moram em .env (fora do git): varre só os nomes de host, nunca guarda valor de chave.
  const dbEnv = envs.flatMap(e => e.t?.match(new RegExp(RE_DB, 'g')) ?? []);
  const refConfig = cfg?.match(/project_id\s*=\s*"([a-z0-9]+)"/)?.[1] ?? null;
  const bancos = classificarBancos([...(dbGrep.out ? dbGrep.out.split('\n') : []), ...dbEnv], refConfig);

  let deps: string[] = [];
  try { const p = JSON.parse(pkg ?? '{}'); deps = Object.keys({ ...p.dependencies, ...p.devDependencies }); } catch { /* sem package.json */ }
  const stack = [...new Set(STACK.filter(([re]) => deps.some(d => re.test(d))).map(([, n]) => n))];
  const edge_functions = funcs.filter(d => d.isDirectory() && !d.name.startsWith('_')).length;
  if (edge_functions) stack.push(`${edge_functions} edge functions`);
  const usaClaude = !!claude && !!resumoDoc(claude);
  const doc = usaClaude ? claude : readme ?? claude;
  const fonte = usaClaude ? 'CLAUDE.md' : readme ? 'README.md' : claude ? 'CLAUDE.md' : null;

  const usadas = envUsadas(envGrep.out);
  const exemploChaves = exemplo ? chavesEnv(exemplo) : [];
  const app = [...new Set([...usadas.app, ...exemploChaves])].sort();
  const definidas = new Set(ehOrion ? Object.keys(process.env) : envs.flatMap(e => (e.t ? chavesEnv(e.t) : [])));
  return {
    bancos, banco_fonte: refConfig ? 'supabase/config.toml' : bancos.length ? 'código e .env' : null,
    arquitetura: {
      stack, resumo: doc ? resumoDoc(doc) : '', fonte, atualizado: fonte ? await mtime(path.join(dir, fonte)) : null, edge_functions,
      pastas: top.filter(d => d.isDirectory() && !d.name.startsWith('.') && !['node_modules', 'dist', 'build', 'coverage'].includes(d.name)).map(d => d.name).sort(),
    },
    env: { usadas: app, faltando: app.filter(k => !definidas.has(k)), edge: usadas.edge, definidas: definidas.size, fonte: ehOrion ? ['/etc/orion/central.env'] : envs.filter(e => e.t !== null).map(e => e.f) },
  };
}

async function backupsLocais(slug: string): Promise<{ nome: string; quando: string }[]> {
  const dir = path.join(os.homedir(), 'backups');
  const nomes = await readdir(dir).catch(() => [] as string[]);
  const meus = nomes.filter(n => n.toLowerCase().includes(slug.toLowerCase()));
  const com = await Promise.all(meus.map(async n => ({ nome: n, quando: (await mtime(path.join(dir, n))) ?? '' })));
  return com.sort((a, b) => b.quando.localeCompare(a.quando));
}

const horas = (iso: string | null | undefined) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity);

export function alertasDe(f: Omit<Ficha, 'alertas'>): Alerta[] {
  const a: Alerta[] = [];
  if (!f.existe) a.push({ nivel: 'ruim', texto: 'pasta do projeto não existe' });
  if (f.prod && (f.prod.erro || (f.prod.status ?? 0) >= 500)) a.push({ nivel: 'ruim', texto: `produção fora do ar (${f.prod.erro ?? f.prod.status})` });
  else if (f.prod && (f.prod.status ?? 0) >= 400) a.push({ nivel: 'atencao', texto: `produção respondeu ${f.prod.status}` });
  if (f.prod?.ssl_expira && horas(f.prod.ssl_expira) > -14 * 24) a.push({ nivel: 'ruim', texto: 'certificado SSL vence em menos de 14 dias' });
  const bkBanco = f.backup.itens.filter(i => i.oque.startsWith('banco'));
  const conhecidos = bkBanco.filter(i => i.quando);
  if (conhecidos.length && conhecidos.every(i => horas(i.quando) > 36)) a.push({ nivel: 'ruim', texto: 'banco sem backup nas últimas 36 h' });
  else if (bkBanco.length && !conhecidos.length) a.push({ nivel: 'atencao', texto: 'backup do banco não verificável daqui' });
  if (f.git && f.git.ahead === null && f.git.remote === null) a.push({ nivel: 'atencao', texto: 'sem espelho no GitHub' });
  if (f.git?.ahead) a.push({ nivel: 'atencao', texto: f.git.ahead > 1 ? `${f.git.ahead} commits ainda não foram pro GitHub` : '1 commit ainda não foi pro GitHub' });
  if (f.git && f.git.sujos > 0) a.push({ nivel: 'atencao', texto: `${f.git.sujos} arquivo${f.git.sujos > 1 ? 's' : ''} alterado${f.git.sujos > 1 ? 's' : ''} sem commit na pasta principal` });
  // Só as VITE_ entram no alerta: as de servidor/edge costumam morar no Pages/Supabase, não na pasta da c3.
  const vite = f.env.faltando.filter(k => k.startsWith('VITE_')).length;
  if (vite) a.push({ nivel: 'atencao', texto: vite > 1 ? `${vite} variáveis VITE_ sem valor na pasta da c3` : '1 variável VITE_ sem valor na pasta da c3' });
  const paradas = f.tarefas.filter(t => horas(t.quando) > 7 * 24).length;
  if (paradas) a.push({ nivel: 'atencao', texto: `${paradas} tarefa${paradas > 1 ? 's' : ''} aberta${paradas > 1 ? 's' : ''} parada${paradas > 1 ? 's' : ''} há mais de 7 dias` });
  return a;
}

/** Último a mexer = pessoa (login do painel) da sessão do Claude mais recente. O git não entra: o autor dele
 *  é a identidade compartilhada da c3 ("Bayerl", "Danilo Bayerl"...), não diz quem foi. */
export function quemMexeu(sessao: { quem: string; quando: string; title: string } | null): Ficha['ultimo_mexeu'] {
  return sessao ? { quem: sessao.quem, quando: sessao.quando, onde: `sessão "${sessao.title}"` } : null;
}

export async function coletarProjetos(pool: Pool, repoDir: string): Promise<Ficha[]> {
  const { rows: projs } = await pool.query<Proj>('SELECT id, slug, name, path, meta FROM projects ORDER BY id');
  const [pages, c2, deployOrion, orionDumps] = await Promise.all([
    paginasCloudflare(pool), backupsC2(), lerStatus().catch(() => null),
    readdir(path.join(os.homedir(), 'backups')).then(ns => Promise.all(ns.filter(n => /^orion.*\.dump$/.test(n)).map(n => mtime(path.join(os.homedir(), 'backups', n))))).catch(() => []),
  ]);
  const { rows: sess } = await pool.query(
    `SELECT s.id, s.project_id, s.title, s.status, s.updated_at, trim(u.name || ' ' || coalesce(u.surname, '')) AS quem, (s.input_tokens + s.output_tokens)::float AS tokens
       FROM claude_sessions s JOIN users u ON u.id = s.user_id WHERE s.project_id IS NOT NULL ORDER BY s.updated_at DESC`);
  // ponytail: tokens acumulados da sessão caem na janela da última atualização; tokens por turno só se precisar de precisão.
  const { rows: tok } = await pool.query(
    `SELECT s.project_id, trim(u.name || ' ' || coalesce(u.surname, '')) AS quem,
            sum(s.input_tokens + s.output_tokens) FILTER (WHERE s.updated_at > now() - interval '7 days')::float AS t7,
            sum(s.input_tokens + s.output_tokens) FILTER (WHERE s.updated_at > now() - interval '30 days')::float AS t30
       FROM claude_sessions s JOIN users u ON u.id = s.user_id WHERE s.project_id IS NOT NULL GROUP BY 1, 2`);
  const { rows: tar } = await pool.query(
    `SELECT t.id, t.project_id, t.title, t.status, t.integration_status AS integracao, trim(u.name || ' ' || coalesce(u.surname, '')) AS quem, t.updated_at AS quando
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.status NOT IN ('feito','arquivada') OR t.integration_status IN ('pendente','conflito','testes_falharam')
      ORDER BY t.updated_at`).catch(() => ({ rows: [] as any[] }));
  const { rows: gh } = await pool.query('SELECT label, login FROM github_accounts').catch(() => ({ rows: [] as any[] }));
  // Preview raiz (público) do projeto: a linha de previews sem pessoa; só projeto com package.json tem.
  const { rows: prev } = await pool.query('SELECT project_id, host FROM previews WHERE user_id IS NULL').catch(() => ({ rows: [] as any[] }));

  return Promise.all(projs.map(async (p): Promise<Ficha> => {
    const existe = await stat(p.path).then(s => s.isDirectory()).catch(() => false);
    const ehOrion = p.slug === 'orion' || path.resolve(p.path) === path.resolve(repoDir);
    const meta = p.meta ?? {};
    const vazio = { bancos: [], banco_fonte: null, arquitetura: { stack: [], resumo: '', fonte: null, atualizado: null, pastas: [], edge_functions: 0 }, env: { usadas: [], faltando: [], edge: [], definidas: 0, fonte: [] } };
    const [g, repo, locais] = await Promise.all([existe ? coletarGit(p.path) : null, existe ? coletarRepo(p.path, ehOrion) : vazio, backupsLocais(p.slug)]);

    let bancos: Banco[] = [];
    await Promise.all(repo.bancos.map(async b => {
      let onde = b.tipo === 'Supabase nuvem' ? 'nuvem Supabase (AWS)' : '';
      if (!onde) { const ip = await dns.resolve4(b.url.replace(/^https?:\/\//, '')).then(x => x[0]).catch(() => null); onde = servidorDoIp(ip) ?? '?'; }
      bancos.push({ ...b, onde });
    }));
    bancos = bancos.sort((a, b) => Number(b.principal) - Number(a.principal) || b.mencoes - a.mencoes);
    if (ehOrion) bancos = [{ tipo: 'Postgres 16 (container)', onde: 'c3', ref: 'orion-postgres', url: 'docker: orion-postgres, volume /srv/postgres', principal: true, mencoes: 0 }];

    const sessoesP = sess.filter(s => s.project_id === p.id);
    const tarefas = tar.filter(t => t.project_id === p.id).map(t => ({ id: t.id, title: t.title, status: t.status, integracao: t.integracao, quem: t.quem, quando: new Date(t.quando).toISOString() }));

    const ultimo_mexeu = quemMexeu(sessoesP[0] ? { quem: sessoesP[0].quem, quando: new Date(sessoesP[0].updated_at).toISOString(), title: sessoesP[0].title } : null);

    // Deploy: Cloudflare Pages com o mesmo nome/repo, ou a fila do próprio Orion.
    // Mesmo nome pode existir em mais de uma conta (ex.: cópia velha do ralab na conta brandspace): vale o deploy mais recente.
    const pg = pages.filter(x => x.name === p.slug || (x.repo && x.repo === g?.github?.split('/')[1]))
      .sort((a, b) => (b.quando ?? '').localeCompare(a.quando ?? ''))[0];
    let deploy: Ficha['deploy'] = null;
    if (pg) deploy = { onde: `Cloudflare Pages (${pg.conta})`, quando: pg.quando, estado: pg.estado || '?', detalhe: pg.commit ? `commit ${pg.commit}` : '', dominios: pg.dominios };
    else if (ehOrion && deployOrion) deploy = { onde: 'fila de deploy da c3 (/srv/orion-live)', quando: deployOrion.fim ?? deployOrion.inicio ?? null, estado: deployOrion.estado, detalhe: `${deployOrion.sha ?? ''} por ${deployOrion.por ?? '?'}`, dominios: ['v2.bayerl.cloud'] };
    const prodUrl = meta.prod_url || (ehOrion ? 'https://v2.bayerl.cloud' : pg ? `https://${pg.dominios.find(d => !d.endsWith('.pages.dev')) ?? pg.dominios[0]}` : '');
    const prod = prodUrl ? await checarProd(prodUrl) : null;

    // Backups: banco (conforme onde ele mora) + código (espelho GitHub e arquivos em ~/backups).
    const itens: Ficha['backup']['itens'] = [];
    const principal = bancos.find(b => b.principal);
    if (ehOrion) {
      const ult = (orionDumps.filter(Boolean) as string[]).sort().pop() ?? null;
      itens.push({ oque: 'banco (orion-postgres)', quando: ult, detalhe: ult ? 'pg_dump manual em ~/backups; não há rotina diária na c3' : 'nenhum dump; não há rotina diária na c3' });
    } else if (principal?.onde === 'c2') {
      itens.push({ oque: `banco (${principal.ref})`, quando: c2.drive, detalhe: 'restic diário 05:00 da c2 para o Google Drive (pg_dump do container)' });
    } else if (principal?.tipo === 'Supabase nuvem') {
      itens.push({ oque: `banco (${principal.ref})`, quando: null, detalhe: 'backup do plano Supabase na nuvem; não dá para verificar daqui' });
    }
    if (g?.ultimo_push) itens.push({ oque: 'código (espelho GitHub)', quando: g.ultimo_push, detalhe: g.github ?? g.remote ?? '' });
    for (const l of locais.slice(0, 3)) itens.push({ oque: 'arquivo em ~/backups', quando: l.quando, detalhe: l.nome });

    const conectores = [
      ...(g?.github ? gh.filter(a => a.login === g.github!.split('/')[0]).map(a => `GitHub ${a.label || a.login}`) : []),
      ...(pg ? [`Cloudflare ${pg.conta}`] : []),
    ];

    const base: Omit<Ficha, 'alertas'> = {
      id: p.id, slug: p.slug, name: p.name, path: p.path, existe, meta, git: g, ...repo, bancos,
      sessoes: sessoesP.slice(0, 6).map(s => ({ id: s.id, title: s.title, status: s.status, quem: s.quem, quando: new Date(s.updated_at).toISOString(), tokens: Number(s.tokens) || 0 })),
      sessoes_total: sessoesP.length,
      tokens: tok.filter(t => t.project_id === p.id && (t.t30 ?? 0) > 0).map(t => ({ quem: t.quem, t7: Number(t.t7) || 0, t30: Number(t.t30) || 0 })).sort((a, b) => b.t30 - a.t30),
      tarefas, ultimo_mexeu, backup: { itens }, deploy, prod,
      preview_url: (h => (h ? `https://${h}` : null))(prev.find(x => x.project_id === p.id)?.host), conectores, coletado: new Date().toISOString(),
    };
    if (meta.banco) base.banco_fonte = `manual: ${meta.banco}`;
    return { ...base, alertas: alertasDe(base) };
  }));
}
