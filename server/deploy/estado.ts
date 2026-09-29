/**
 * Publicação do Orion (botão Deploy): o painel só escreve um pedido em /srv/builds/pedido.json e lê o estado
 * que deploy/build.sh grava (status.json, <nome>.json, <nome>.log). Quem constrói e reinicia é a unit
 * orion-deploy.path/.service, como root, fora do processo do painel (que roda com NoNewPrivileges).
 * Aqui ficam as funções puras (validação, leitura de estado, histórico) testadas em tests/deploy.test.ts.
 */
import { readdir, readFile, readlink, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const BUILDS_DIR = process.env.ORION_BUILDS ?? '/srv/builds';
export const LIVE_LINK = process.env.ORION_LIVE ?? '/srv/orion-live';

export type Estado = 'fila' | 'rodando' | 'ok' | 'falhou';
export type Status = {
  estado: Estado; etapa: string; sha: string; msg: string; ref: string; nome: string; por: string;
  inicio: string; fim: string | null; log: string; anterior: string;
};

/** Só "main" ou um sha hexadecimal: nada de refs arbitrárias indo para o shell. */
export function validarRef(ref: unknown): string | null {
  const r = String(ref ?? 'main').trim();
  if (r === '' || r === 'main') return 'main';
  return /^[0-9a-f]{7,40}$/i.test(r) ? r.toLowerCase() : null;
}

/** Nome de quem pediu, sem nada que quebre JSON ou shell. */
export function limparPor(nome: unknown): string {
  return String(nome ?? 'painel').replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 40) || 'painel';
}

export function parseStatus(texto: string): Status | null {
  try {
    const j = JSON.parse(texto);
    if (!j || typeof j !== 'object' || !['fila', 'rodando', 'ok', 'falhou'].includes(j.estado)) return null;
    return { etapa: '', msg: '', ref: 'main', por: '', inicio: '', fim: null, log: '', anterior: '', sha: '', nome: '', ...j };
  } catch { return null; }
}

/** Um build "rodando" cujo processo morreu deixaria o painel travado: acima de 40 min tratamos como falho. */
export function statusEfetivo(s: Status | null, agora = Date.now()): Status | null {
  if (!s) return null;
  if ((s.estado === 'fila' || s.estado === 'rodando') && s.inicio) {
    const t = Date.parse(s.inicio);
    if (Number.isFinite(t) && agora - t > 40 * 60_000) return { ...s, estado: 'falhou', etapa: `sem resposta desde ${s.inicio} (${s.etapa})` };
  }
  return s;
}

/** Histórico: os <nome>.json finais, mais novo primeiro. */
export function ordenarHistorico(itens: Status[]): Status[] {
  return [...itens].sort((a, b) => (b.fim ?? b.inicio).localeCompare(a.fim ?? a.inicio));
}

export function nomeDeBuildValido(nome: string): boolean {
  return /^[0-9a-f]{7,12}-\d{8}-\d{6}$/.test(nome);
}

// ---------- disco ----------

export async function lerStatus(dir = BUILDS_DIR): Promise<Status | null> {
  const s = parseStatus(await readFile(path.join(dir, 'status.json'), 'utf8').catch(() => ''));
  return statusEfetivo(s);
}

export async function lerHistorico(dir = BUILDS_DIR, limite = 8): Promise<Status[]> {
  const nomes = (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.json') && nomeDeBuildValido(n.slice(0, -5)));
  const itens = await Promise.all(nomes.map(async n => parseStatus(await readFile(path.join(dir, n), 'utf8').catch(() => ''))));
  return ordenarHistorico(itens.filter((s): s is Status => !!s)).slice(0, limite);
}

export async function pedidoPendente(dir = BUILDS_DIR): Promise<{ ref: string; por: string; quando: string } | null> {
  try {
    const j = JSON.parse(await readFile(path.join(dir, 'pedido.json'), 'utf8'));
    return { ref: String(j.ref ?? 'main'), por: String(j.por ?? ''), quando: String(j.quando ?? '') };
  } catch { return null; }
}

/** Escreve o pedido (atômico). A unit orion-deploy.path faz o resto. */
export async function escreverPedido(ref: string, por: string, dir = BUILDS_DIR): Promise<void> {
  const tmp = path.join(dir, `pedido.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify({ ref, por, quando: new Date().toISOString() }), { mode: 0o664 });
  await rename(tmp, path.join(dir, 'pedido.json'));
}

/** Nome do build no ar (basename do symlink) ou "repo" quando ainda aponta para o checkout de trabalho. */
export async function versaoNoAr(link = LIVE_LINK): Promise<string> {
  const alvo = await readlink(link).catch(() => '');
  if (!alvo) return '?';
  const base = path.basename(alvo);
  return nomeDeBuildValido(base) ? base : 'repo (' + base + ')';
}

export async function tailDoLog(arquivo: string, linhas = 200): Promise<string> {
  const st = await stat(arquivo).catch(() => null);
  if (!st) return '';
  const txt = await readFile(arquivo, 'utf8').catch(() => '');
  return txt.split('\n').slice(-linhas).join('\n');
}
