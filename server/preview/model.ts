import type { Pool } from 'pg';
import { slugify } from '../tasks/util.js';

/**
 * Mapa dos previews ao vivo (spec 2026-09-30-preview-design, Parte 1): um host por projeto (raiz,
 * público) e um por pessoa e projeto (só logado), cada um com uma porta fixa que nunca muda.
 * O `sync-previews` (root) transforma estas linhas em DNS, Caddy e units do systemd.
 */

export const DOMINIO = 'bayerl.cloud';
export const PORTA_MIN = 9100;
export const PORTA_MAX = 9999;

export type PreviewRow = { id: number; project_id: number; user_id: number | null; host: string; port: number; worktree_path: string };
type Par = { project_id: number; user_id: number | null };

export function slugPessoa(nome: string): string {
  return slugify(nome, 'pessoa');
}

export function hostPreview(pessoa: string | null, slug: string): string {
  return pessoa ? `${pessoa}.${slug}.${DOMINIO}` : `${slug}.${DOMINIO}`;
}

/** Nome da instância systemd: o host sem o domínio (`lais.ralab`, `fisioexpert`). */
export function instancia(host: string): string {
  return host.endsWith(`.${DOMINIO}`) ? host.slice(0, -(DOMINIO.length + 1)) : host;
}

export function proximaPorta(usadas: number[]): number {
  const ocupadas = new Set(usadas);
  for (let p = PORTA_MIN; p <= PORTA_MAX; p++) if (!ocupadas.has(p)) return p;
  throw new Error('faixa de portas de preview esgotada');
}

/** Pares (projeto, pessoa) que ainda não têm linha; `user_id: null` é o preview raiz do projeto. */
export function paresFaltando(projetos: number[], usuarios: number[], existentes: Par[]): Par[] {
  const tem = new Set(existentes.map(e => `${e.project_id}:${e.user_id ?? ''}`));
  const faltam: Par[] = [];
  for (const project_id of projetos) {
    for (const user_id of [null, ...usuarios]) if (!tem.has(`${project_id}:${user_id ?? ''}`)) faltam.push({ project_id, user_id });
  }
  return faltam;
}

/** Cria as linhas que faltam (idempotente) e devolve todas. */
export async function garantirPreviews(pool: Pool): Promise<PreviewRow[]> {
  const { rows: projetos } = await pool.query<{ id: number; slug: string; path: string }>('SELECT id, slug, path FROM projects ORDER BY id');
  const { rows: usuarios } = await pool.query<{ id: number; name: string }>('SELECT id, name FROM users ORDER BY id');
  const { rows: atuais } = await pool.query<PreviewRow>('SELECT * FROM previews');
  const portas = atuais.map(r => r.port);
  for (const par of paresFaltando(projetos.map(p => p.id), usuarios.map(u => u.id), atuais)) {
    const proj = projetos.find(p => p.id === par.project_id)!;
    const pessoa = par.user_id === null ? null : slugPessoa(usuarios.find(u => u.id === par.user_id)!.name);
    const port = proximaPorta(portas);
    portas.push(port);
    await pool.query(
      'INSERT INTO previews (project_id, user_id, host, port, worktree_path) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [par.project_id, par.user_id, hostPreview(pessoa, proj.slug), port, proj.path]);
  }
  return (await pool.query<PreviewRow>('SELECT * FROM previews ORDER BY id')).rows;
}

/** Aponta o preview pessoal para a pasta servida agora (worktree da sessão ou a raiz). */
export async function apontar(pool: Pool, userId: number, projectId: number, dir: string): Promise<PreviewRow> {
  await garantirPreviews(pool);
  const { rows } = await pool.query<PreviewRow>(
    'UPDATE previews SET worktree_path = $3, updated_at = now() WHERE user_id = $1 AND project_id = $2 RETURNING *', [userId, projectId, dir]);
  if (!rows[0]) throw new Error('preview não encontrado');
  return rows[0];
}
