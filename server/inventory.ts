// Coletor de inventário da VPS: descobre o que está instalado sem lista fixa do que mostrar.
// Cada sonda é independente e tolerante a falha (ferramenta ausente → seção vazia + aviso, nunca lança).
// Só usa execFile com argumentos fixos (nunca shell com entrada do usuário) e timeouts curtos.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { diffInventory, emptyDiff, type InventoryDiff } from './inventoryDiff.js';

const execFile = promisify(execFileCb);

// ---------- tipos do snapshot ----------

export type Binario = { nome: string; versao: string; caminho: string };
export type PacoteGlobal = { gerenciador: 'npm' | 'bun'; nome: string; versao: string };
export type Unidade = {
  unidade: string; tipo: 'service' | 'timer'; load: string; estado: string; sub: string; descricao: string;
  proximo?: string; ultimo?: string;
};
export type Container = { nome: string; imagem: string; estado: string; status: string; portas: string };
export type Porta = { porta: number; endereco: string; processo: string; pid: number | null };
export type EventoApt = { quando: string; acao: 'install' | 'upgrade'; pacote: string; versao: string; anterior: string };
export type Servidor = { apelido: string; ip: string; provedor: string; specs: string; papel: string; servicos: string };

export type Inventory = {
  coletado_em: string;
  coletor: { usuario: string; origem: string; host: string };
  maquina: Record<string, string>;
  binarios: Binario[];
  pacotes: PacoteGlobal[];
  servicos: Unidade[];
  containers: Container[];
  portas: Porta[];
  apt: EventoApt[];
  servidores: Servidor[];
  avisos: string[];
};

export const BINARIOS_CANDIDATOS = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python3', 'pip3', 'docker', 'docker-compose', 'caddy', 'nginx',
  'git', 'gh', 'claude', 'kanna', 'psql', 'redis-server', 'pm2', 'go', 'rustc', 'cargo', 'java', 'ffmpeg', 'jq', 'curl',
  'rsync', 'ufw', 'fail2ban-client', 'ss',
];

// Unidades systemd que interessam (o resto é ruído do Ubuntu). Unidades em "failed" entram sempre.
export const UNIDADES_RELEVANTES = /orion|kanna|caddy|docker|containerd|postgres|fail2ban|ufw|ssh|cron|nginx|node|claude|redis|n8n|evolution|coolify/i;

const HOME_DANILO = '/home/danilo';
const DIAS_APT = 7;
const MAX_APT = 60;

// ---------- execução segura ----------

type Saida = { ok: boolean; stdout: string; stderr: string };
type RunOpts = { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv };

async function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<Saida> {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      timeout: opts.timeout ?? 5000, cwd: opts.cwd, env: opts.env, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (e: any) {
    return { ok: false, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? '') };
  }
}

function linhas(texto: string): string[] {
  return texto.split('\n').map(l => l.trim()).filter(Boolean);
}

// ---------- PATH e binários ----------

export function diretoriosDeBusca(): string[] {
  const homes = new Set<string>([HOME_DANILO]);
  try { homes.add(os.homedir()); } catch { /* sem home */ }
  const extras: string[] = [];
  for (const h of homes) {
    extras.push(path.join(h, '.bun', 'bin'), path.join(h, '.local', 'bin'), path.join(h, '.npm-global', 'bin'),
      path.join(h, '.cargo', 'bin'), path.join(h, 'go', 'bin'), path.join(h, '.deno', 'bin'));
  }
  const doAmbiente = (process.env.PATH ?? '').split(':').filter(Boolean);
  const padrao = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin', '/usr/local/go/bin'];
  return [...new Set([...doAmbiente, ...extras, ...padrao])];
}

async function localizar(nome: string, dirs: string[]): Promise<string | null> {
  for (const d of dirs) {
    const p = path.join(d, nome);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue;
      await access(p, fsConstants.X_OK);
      return p;
    } catch { /* não está aqui */ }
  }
  return null;
}

const TENTATIVAS_VERSAO: string[][] = [['--version'], ['version'], ['-v'], ['-version']];

export function primeiraLinhaDeVersao(texto: string): string {
  const ls = linhas(texto);
  if (!ls.length) return '';
  return (ls.find(l => /\d+\.\d+/.test(l)) ?? ls[0]).slice(0, 120);
}

async function versaoDe(caminho: string, env: NodeJS.ProcessEnv): Promise<string> {
  for (const args of TENTATIVAS_VERSAO) {
    const r = await run(caminho, args, { timeout: 6000, env });
    if (!r.ok) continue;
    const linha = primeiraLinhaDeVersao(r.stdout.trim() || r.stderr.trim());
    if (linha) return linha;
  }
  return 'versão desconhecida';
}

async function sondarBinarios(dirs: string[], env: NodeJS.ProcessEnv): Promise<Binario[]> {
  const achados = await Promise.all(BINARIOS_CANDIDATOS.map(async (nome) => {
    const caminho = await localizar(nome, dirs);
    if (!caminho) return null;
    return { nome, caminho, versao: await versaoDe(caminho, env) } as Binario;
  }));
  return achados.filter((b): b is Binario => b !== null);
}

// ---------- pacotes globais ----------

export function parseNpmLs(json: string): PacoteGlobal[] {
  try {
    const j = JSON.parse(json);
    const deps = (j && typeof j === 'object' && j.dependencies) || {};
    return Object.entries(deps as Record<string, any>)
      .map(([nome, v]) => ({ gerenciador: 'npm' as const, nome, versao: String(v?.version ?? '?') }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  } catch { return []; }
}

export function parseBunLs(texto: string): PacoteGlobal[] {
  const out: PacoteGlobal[] = [];
  for (const l of linhas(texto)) {
    const m = l.match(/^[├└│\s─]*(.+)$/);
    const item = (m?.[1] ?? '').trim();
    if (!item || !item.includes('@') || item.includes('node_modules')) continue;
    const i = item.lastIndexOf('@');
    if (i <= 0) continue;
    out.push({ gerenciador: 'bun', nome: item.slice(0, i), versao: item.slice(i + 1) });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome));
}

// ---------- systemd ----------

export function parseListUnits(texto: string, tipo: 'service' | 'timer'): Unidade[] {
  const out: Unidade[] = [];
  for (const l of linhas(texto)) {
    const t = l.split(/\s+/);
    if (t.length < 4 || !t[0].endsWith(`.${tipo}`)) continue;
    out.push({ unidade: t[0], tipo, load: t[1], estado: t[2], sub: t[3], descricao: t.slice(4).join(' ') });
  }
  return out;
}

function lerData(t: string[], i: number): [string, number] {
  if (i >= t.length) return ['-', i];
  if (t[i] === '-' || t[i] === 'n/a') return ['-', i + 1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(t[i + 1] ?? '') && /^\d{2}:\d{2}:\d{2}$/.test(t[i + 2] ?? '')) {
    let fim = i + 3;
    if (/^[A-Z][A-Za-z]{1,4}$|^[+-]\d{2,4}$/.test(t[fim] ?? '')) fim++; // fuso (UTC, BRT, -03)
    return [t.slice(i, fim).join(' '), fim];
  }
  return [t[i], i + 1];
}

function lerRelativo(t: string[], i: number): [string, number] {
  if (i >= t.length) return ['-', i];
  if (t[i] === '-' || t[i] === 'n/a') return ['-', i + 1];
  const partes: string[] = [];
  let j = i;
  while (j < t.length && !t[j].endsWith('.timer')) {
    partes.push(t[j]);
    j++;
    if (partes[partes.length - 1] === 'left' || partes[partes.length - 1] === 'ago') break;
  }
  return [partes.join(' '), j];
}

// `systemctl list-timers --all --plain --no-legend`: NEXT LEFT LAST PASSED UNIT ACTIVATES
export function parseListTimers(texto: string): { unidade: string; ativa: string; proximo: string; ultimo: string }[] {
  const out: { unidade: string; ativa: string; proximo: string; ultimo: string }[] = [];
  for (const l of linhas(texto)) {
    const t = l.split(/\s+/);
    const iUnit = t.findIndex(x => x.endsWith('.timer'));
    if (iUnit < 0) continue;
    let i = 0;
    let proximo: string; let ultimo: string;
    [proximo, i] = lerData(t, i);
    [, i] = lerRelativo(t, i);
    [ultimo, i] = lerData(t, i);
    out.push({ unidade: t[iUnit], ativa: t[iUnit + 1] ?? '', proximo, ultimo });
  }
  return out;
}

export function unidadeRelevante(u: { unidade: string; estado: string }): boolean {
  return UNIDADES_RELEVANTES.test(u.unidade) || u.estado === 'failed';
}

async function sondarSystemd(env: NodeJS.ProcessEnv, avisos: string[]): Promise<Unidade[]> {
  const base = ['--all', '--no-pager', '--plain', '--no-legend'];
  const [svc, tim, timers] = await Promise.all([
    run('systemctl', ['list-units', '--type=service', ...base], { timeout: 8000, env }),
    run('systemctl', ['list-units', '--type=timer', ...base], { timeout: 8000, env }),
    run('systemctl', ['list-timers', ...base], { timeout: 8000, env }),
  ]);
  if (!svc.ok && !svc.stdout) { avisos.push('systemctl indisponível: serviços não listados'); return []; }
  const servicos = parseListUnits(svc.stdout, 'service').filter(unidadeRelevante);
  const unidadesTimer = parseListUnits(tim.stdout, 'timer');
  const detalhes = new Map(parseListTimers(timers.stdout).map(t => [t.unidade, t]));
  const timersVistos = new Set<string>();
  const timersOut: Unidade[] = [];
  for (const u of unidadesTimer) {
    if (!unidadeRelevante(u)) continue;
    const d = detalhes.get(u.unidade);
    timersVistos.add(u.unidade);
    timersOut.push({ ...u, proximo: d?.proximo ?? '-', ultimo: d?.ultimo ?? '-' });
  }
  // timers que só apareceram no list-timers (sem estado conhecido)
  for (const d of detalhes.values()) {
    if (timersVistos.has(d.unidade) || !UNIDADES_RELEVANTES.test(d.unidade)) continue;
    timersOut.push({ unidade: d.unidade, tipo: 'timer', load: 'loaded', estado: '?', sub: '?', descricao: `ativa ${d.ativa}`, proximo: d.proximo, ultimo: d.ultimo });
  }
  const ordem = (a: Unidade, b: Unidade) => a.unidade.localeCompare(b.unidade);
  return [...servicos.sort(ordem), ...timersOut.sort(ordem)];
}

// ---------- docker ----------

export function parseDockerPs(texto: string): Container[] {
  const out: Container[] = [];
  for (const l of linhas(texto)) {
    try {
      const j = JSON.parse(l);
      out.push({
        nome: String(j.Names ?? j.Name ?? j.ID ?? '?'), imagem: String(j.Image ?? '?'),
        estado: String(j.State ?? '?'), status: String(j.Status ?? ''), portas: String(j.Ports ?? ''),
      });
    } catch { /* linha que não é JSON */ }
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome));
}

// ---------- portas ----------

export function parseSs(texto: string): Porta[] {
  const porPorta = new Map<number, { enderecos: Set<string>; processo: string; pid: number | null }>();
  for (const l of linhas(texto)) {
    const t = l.split(/\s+/);
    if (t.length < 4) continue;
    const local = t[0] === 'LISTEN' ? t[3] : t[2];
    const i = local.lastIndexOf(':');
    if (i < 0) continue;
    const porta = Number(local.slice(i + 1));
    if (!Number.isFinite(porta)) continue;
    let endereco = local.slice(0, i);
    if (endereco === '*' || endereco === '0.0.0.0' || endereco === '[::]') endereco = 'todas';
    const m = l.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const atual = porPorta.get(porta) ?? { enderecos: new Set<string>(), processo: '', pid: null };
    atual.enderecos.add(endereco);
    if (m && !atual.processo) { atual.processo = m[1]; atual.pid = Number(m[2]); }
    porPorta.set(porta, atual);
  }
  return [...porPorta.entries()]
    .map(([porta, v]) => ({ porta, endereco: [...v.enderecos].join(', '), processo: v.processo || '—', pid: v.pid }))
    .sort((a, b) => a.porta - b.porta);
}

// ---------- apt ----------

export function parseDpkgLog(texto: string, agora: Date = new Date(), dias = DIAS_APT, max = MAX_APT): EventoApt[] {
  const limite = agora.getTime() - dias * 86_400_000;
  const out: EventoApt[] = [];
  for (const l of linhas(texto)) {
    const t = l.split(/\s+/);
    if (t.length < 5) continue;
    const [data, hora, acao, pacoteArq] = t;
    if (acao !== 'install' && acao !== 'upgrade') continue;
    const ts = Date.parse(`${data}T${hora}`);
    if (!Number.isFinite(ts) || ts < limite) continue;
    const pacote = pacoteArq.replace(/:[a-z0-9]+$/, '');
    const anterior = t[4] ?? '<none>';
    const versao = t[5] ?? anterior;
    out.push({ quando: `${data} ${hora}`, acao, pacote, versao, anterior: anterior === '<none>' ? '' : anterior });
  }
  out.sort((a, b) => a.quando.localeCompare(b.quando));
  return out.slice(-max);
}

async function sondarApt(avisos: string[]): Promise<EventoApt[]> {
  const partes: string[] = [];
  for (const f of ['/var/log/dpkg.log.1', '/var/log/dpkg.log']) {
    try { partes.push(await readFile(f, 'utf8')); } catch { /* sem arquivo */ }
  }
  if (!partes.length) { avisos.push('dpkg.log ilegível: pacotes apt recentes não listados'); return []; }
  return parseDpkgLog(partes.join('\n'));
}

// ---------- máquina ----------

export function formatarUptime(segundos: number): string {
  const d = Math.floor(segundos / 86400);
  const h = Math.floor((segundos % 86400) / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const p: string[] = [];
  if (d) p.push(`${d} dia${d > 1 ? 's' : ''}`);
  if (h) p.push(`${h} h`);
  p.push(`${m} min`);
  return p.join(', ');
}

export function parseMeminfo(texto: string): string {
  const pega = (k: string) => Number((texto.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? NaN);
  const total = pega('MemTotal'); const disp = pega('MemAvailable');
  if (!Number.isFinite(total)) return 'indisponível';
  const mb = (kb: number) => Math.round(kb / 1024);
  const usado = Number.isFinite(disp) ? total - disp : NaN;
  return Number.isFinite(usado) ? `${mb(usado)} MB usados de ${mb(total)} MB` : `${mb(total)} MB`;
}

export function parseDf(texto: string): string {
  const l = linhas(texto)[1];
  if (!l) return 'indisponível';
  const t = l.split(/\s+/);
  const gb = (kb: string) => `${(Number(kb) / 1024 / 1024).toFixed(1).replace('.', ',')} GB`;
  if (t.length < 5) return 'indisponível';
  return `${gb(t[2])} usados de ${gb(t[1])} (${t[4]})`;
}

async function sondarMaquina(pool: Pool | null, repoDir: string, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const [osRelease, meminfo, df, commit] = await Promise.all([
    readFile('/etc/os-release', 'utf8').catch(() => ''),
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
    run('df', ['-kP', '/'], { env }),
    run('git', ['-c', 'safe.directory=*', 'log', '-1', '--format=%h %ad %s', '--date=short'], { cwd: repoDir, env }),
  ]);
  let postgres = 'indisponível';
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT version() AS v');
      postgres = String(rows[0]?.v ?? '').split(' on ')[0] || postgres;
    } catch { /* fica indisponível */ }
  }
  const sistema = (osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m) ?? [])[1] ?? 'Linux';
  return {
    sistema,
    kernel: os.release(),
    uptime: formatarUptime(os.uptime()),
    vcpus: String(os.cpus().length || 'indisponível'),
    memoria: meminfo ? parseMeminfo(meminfo) : 'indisponível',
    disco: df.ok ? parseDf(df.stdout) : 'indisponível',
    ultimo_commit: commit.ok ? (linhas(commit.stdout)[0] ?? 'indisponível') : 'indisponível',
    postgres,
  };
}

// ---------- coleta ----------

export async function collectInventory(pool: Pool | null, repoDir: string, origem = 'web'): Promise<Inventory> {
  const dirs = diretoriosDeBusca();
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: dirs.join(':'), LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' };
  const avisos: string[] = [];

  const sondaNpm = async (binarios: Binario[]): Promise<PacoteGlobal[]> => {
    const npm = binarios.find(b => b.nome === 'npm')?.caminho;
    if (!npm) return [];
    const r = await run(npm, ['ls', '-g', '--depth=0', '--json'], { timeout: 20000, env });
    const p = parseNpmLs(r.stdout.trim());
    if (!p.length && !r.ok) avisos.push('npm ls -g falhou: pacotes npm globais não listados');
    return p;
  };
  const sondaBun = async (binarios: Binario[]): Promise<PacoteGlobal[]> => {
    const bun = binarios.find(b => b.nome === 'bun')?.caminho;
    if (!bun) return [];
    const r = await run(bun, ['pm', 'ls', '-g'], { timeout: 15000, env });
    return parseBunLs(r.stdout + '\n' + r.stderr);
  };
  const sondaDocker = async (binarios: Binario[]): Promise<Container[]> => {
    const docker = binarios.find(b => b.nome === 'docker')?.caminho;
    if (!docker) return [];
    const r = await run(docker, ['ps', '-a', '--format', '{{json .}}'], { timeout: 10000, env });
    if (!r.ok) { avisos.push('docker ps falhou (sem permissão ou daemon parado): containers não listados'); return []; }
    return parseDockerPs(r.stdout);
  };
  const sondaPortas = async (): Promise<Porta[]> => {
    const r = await run('ss', ['-tlnpH'], { timeout: 5000, env });
    if (!r.ok && !r.stdout) { avisos.push('ss indisponível: portas não listadas'); return []; }
    return parseSs(r.stdout);
  };
  const sondaInfra = async (): Promise<Servidor[]> => {
    try {
      const j = JSON.parse(await readFile(path.join(repoDir, 'docs', 'infra.json'), 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch { return []; }
  };

  const binarios = await sondarBinarios(dirs, env).catch(() => [] as Binario[]);
  const [npm, bun, servicos, containers, portas, apt, maquina, servidores] = await Promise.all([
    sondaNpm(binarios).catch(() => [] as PacoteGlobal[]),
    sondaBun(binarios).catch(() => [] as PacoteGlobal[]),
    sondarSystemd(env, avisos).catch(() => [] as Unidade[]),
    sondaDocker(binarios).catch(() => [] as Container[]),
    sondaPortas().catch(() => [] as Porta[]),
    sondarApt(avisos).catch(() => [] as EventoApt[]),
    sondarMaquina(pool, repoDir, env).catch(() => ({} as Record<string, string>)),
    sondaInfra(),
  ]);

  let usuario = 'desconhecido';
  try { usuario = os.userInfo().username; } catch { /* sem passwd */ }

  return {
    coletado_em: new Date().toISOString(),
    coletor: { usuario, origem, host: os.hostname() },
    maquina,
    binarios,
    pacotes: [...npm, ...bun],
    servicos,
    containers,
    portas,
    apt,
    servidores,
    avisos,
  };
}

// ---------- snapshots ----------

export const SNAPSHOTS_GUARDADOS = 200;
const HISTORICO = 24;

export type SnapshotRow = { id: number; ts: string; data: Inventory };

export async function saveSnapshot(pool: Pool, data: Inventory, keep = SNAPSHOTS_GUARDADOS): Promise<{ id: number; ts: string }> {
  const { rows } = await pool.query('INSERT INTO inventory_snapshots (data) VALUES ($1::jsonb) RETURNING id, ts', [JSON.stringify(data)]);
  await pool.query(
    'DELETE FROM inventory_snapshots WHERE id NOT IN (SELECT id FROM inventory_snapshots ORDER BY ts DESC, id DESC LIMIT $1)', [keep]);
  return { id: rows[0].id, ts: new Date(rows[0].ts).toISOString() };
}

export async function latestSnapshots(pool: Pool, n = HISTORICO): Promise<SnapshotRow[]> {
  const { rows } = await pool.query('SELECT id, ts, data FROM inventory_snapshots ORDER BY ts DESC, id DESC LIMIT $1', [n]);
  return rows.map((r: any) => ({ id: r.id, ts: new Date(r.ts).toISOString(), data: r.data as Inventory }));
}

export type InventoryResponse = {
  snapshot: Inventory;
  snapshot_ts: string;
  previous_ts: string | null;
  changes: InventoryDiff;
  history: string[];
};

// Tenta coletar pelo serviço systemd (roda como o usuário certo e vê o PATH dele); se não puder, coleta no processo.
async function coletarEGuardar(pool: Pool, repoDir: string, origem: string): Promise<void> {
  const antes = (await latestSnapshots(pool, 1))[0]?.id ?? 0;
  const viaSystemd = await run('systemctl', ['start', 'orion-inventory.service'], { timeout: 90_000 });
  if (viaSystemd.ok) {
    const depois = (await latestSnapshots(pool, 1))[0]?.id ?? 0;
    if (depois > antes) return;
  }
  const data = await collectInventory(pool, repoDir, origem);
  await saveSnapshot(pool, data);
}

export async function inventoryResponse(pool: Pool, repoDir: string, opts: { refresh?: boolean } = {}): Promise<InventoryResponse> {
  if (opts.refresh) await coletarEGuardar(pool, repoDir, 'web');
  let rows = await latestSnapshots(pool);
  if (!rows.length) {
    await saveSnapshot(pool, await collectInventory(pool, repoDir, 'web'));
    rows = await latestSnapshots(pool);
  }
  const [latest, previous] = rows;
  return {
    snapshot: latest.data,
    snapshot_ts: latest.ts,
    previous_ts: previous?.ts ?? null,
    changes: previous ? diffInventory(previous.data, latest.data) : emptyDiff(),
    history: rows.map(r => r.ts),
  };
}
