/**
 * Preferências de skill por pessoa e a composição de cada sessão.
 *
 * Regra de precedência: escolha da pessoa > padrão "todos" do admin > ligada.
 * Como a regra vira realidade (por sessão, via opção `plugins` do Agent SDK):
 * - itens soltos do catálogo (/srv/claude/catalog/{skills,commands,agents}) ligados para a pessoa
 *   viram links dentro de um plugin de composição só dela (/srv/claude/compose/<id>, nome "bayerl");
 * - um plugin do catálogo (/srv/claude/catalog/plugins/<nome>) carrega inteiro, com hooks, se ao
 *   menos uma skill dele estiver ligada; as desligadas ficam bloqueadas por `Skill(plugin:nome)`;
 * - o que vem sincronizado da claude.ai (~/.claude/skills/synced e plugins/synced) não passa por
 *   aqui: é da conta, sempre ligado.
 * Funções puras no topo (testadas em tests/skillPrefs.test.ts); disco e banco embaixo.
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { CATALOGO_DIR, chaveDe, scanRaiz, type SkillItem } from './skillsScan.js';

export const COMPOSE_DIR = process.env.COMPOSE_DIR ?? '/srv/claude/compose';
/** user_id da linha "vale para todos". */
export const TODOS = 0;

export type Pref = { chave: string; user_id: number; ligada: boolean };
/** Índice `${user_id}|${chave}` -> ligada. */
export type Prefs = Map<string, boolean>;
export type Estado = { todos: boolean | null; eu: boolean | null; efetiva: boolean };
export type Plano = {
  links: { kind: 'skill' | 'command' | 'agent'; name: string; from: string }[];
  pluginPaths: string[];
  disallowed: string[];
};

// ---------- puras ----------

export function indexarPrefs(prefs: Pref[]): Prefs {
  return new Map(prefs.map(p => [`${p.user_id}|${p.chave}`, p.ligada]));
}

export function estadoDe(chave: string, userId: number, prefs: Prefs): Estado {
  const todos = prefs.get(`${TODOS}|${chave}`) ?? null;
  const eu = prefs.get(`${userId}|${chave}`) ?? null;
  return { todos, eu, efetiva: eu ?? todos ?? true };
}

/** Item que entra na composição: do catálogo (não sincronizado da claude.ai), skill/command/agent. */
export function ehDoCatalogo(it: SkillItem, catalogo = CATALOGO_DIR): boolean {
  return it.origem === 'c3' && it.kind !== 'hook' && it.path.startsWith(catalogo + path.sep) && !it.fonte.startsWith('claude.ai');
}

/** Raiz do plugin no catálogo a partir do caminho de um item dele: .../plugins/<nome>. */
export function raizDoPlugin(itemPath: string, catalogo = CATALOGO_DIR): string | null {
  const rel = path.relative(catalogo, itemPath).split(path.sep);
  return rel[0] === 'plugins' && rel[1] ? path.join(catalogo, 'plugins', rel[1]) : null;
}

export function planoDeComposicao(itens: SkillItem[], prefs: Prefs, userId: number, catalogo = CATALOGO_DIR): Plano {
  const plano: Plano = { links: [], pluginPaths: [], disallowed: [] };
  const porPlugin = new Map<string, { ligadas: number; desligadas: string[] }>();
  for (const it of itens) {
    if (!ehDoCatalogo(it, catalogo)) continue;
    const ligada = estadoDe(chaveDe(it.kind, it.invocacao), userId, prefs).efetiva;
    if (!it.plugin) {
      if (ligada) plano.links.push({ kind: it.kind as Plano['links'][number]['kind'], name: it.name, from: it.kind === 'skill' ? path.dirname(it.path) : it.path });
      continue;
    }
    const raiz = raizDoPlugin(it.path, catalogo);
    if (!raiz) continue;
    const g = porPlugin.get(raiz) ?? { ligadas: 0, desligadas: [] };
    if (ligada) g.ligadas++;
    else if (it.kind !== 'agent') g.desligadas.push(`Skill(${it.invocacao})`);
    porPlugin.set(raiz, g);
  }
  for (const [raiz, g] of porPlugin) {
    if (!g.ligadas) continue; // nenhuma skill ligada: o plugin nem carrega (hooks inclusive)
    plano.pluginPaths.push(raiz);
    plano.disallowed.push(...g.desligadas);
  }
  plano.pluginPaths.sort();
  return plano;
}

// ---------- disco ----------

/** Materializa o plano em /srv/claude/compose/<id> e devolve as opções para o SDK. Refeito a cada sessão (é barato: só links). */
export async function materializar(plano: Plano, userId: number, composeDir = COMPOSE_DIR): Promise<{ plugins: SdkPluginConfig[]; disallowedTools: string[] }> {
  const dir = path.join(composeDir, String(userId));
  await rm(dir, { recursive: true, force: true });
  const plugins: SdkPluginConfig[] = [];
  if (plano.links.length) {
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'bayerl', description: 'Skills, commands e agents do catálogo do Orion ligados para esta pessoa', version: '1.0.0' }, null, 2));
    for (const l of plano.links) {
      const pasta = l.kind === 'skill' ? 'skills' : l.kind === 'command' ? 'commands' : 'agents';
      const alvo = l.kind === 'skill'
        ? path.join(dir, pasta, l.name)
        : path.join(dir, pasta, ...l.name.split(':')) + '.md';
      await mkdir(path.dirname(alvo), { recursive: true });
      await symlink(l.from, alvo);
    }
    plugins.push({ type: 'local', path: dir });
  }
  for (const p of plano.pluginPaths) plugins.push({ type: 'local', path: p });
  return { plugins, disallowedTools: plano.disallowed };
}

// ---------- banco ----------

export async function ensureSkillPrefsTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS skill_prefs (
    chave TEXT NOT NULL, user_id INT NOT NULL DEFAULT 0, ligada BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (chave, user_id))`);
}

export async function lerPrefs(pool: Pool): Promise<Prefs> {
  const { rows } = await pool.query('SELECT chave, user_id, ligada FROM skill_prefs');
  return indexarPrefs(rows as Pref[]);
}

export async function gravarPref(pool: Pool, chave: string, userId: number, ligada: boolean | null): Promise<void> {
  if (ligada === null) { await pool.query('DELETE FROM skill_prefs WHERE chave = $1 AND user_id = $2', [chave, userId]); return; }
  await pool.query(
    'INSERT INTO skill_prefs (chave, user_id, ligada) VALUES ($1, $2, $3) ON CONFLICT (chave, user_id) DO UPDATE SET ligada = EXCLUDED.ligada, updated_at = now()',
    [chave, userId, ligada]);
}

// ponytail: cache de 30 s da varredura do catálogo; a composição roda a cada turno de cada sessão.
let cacheCatalogo: { ts: number; itens: SkillItem[] } | null = null;
export function invalidarCatalogo(): void { cacheCatalogo = null; }

/** Opções `plugins` + `disallowedTools` para a sessão de uma pessoa. Nunca lança: falha vira composição vazia (a sessão abre igual). */
export async function composicaoPara(pool: Pool, userId: number): Promise<{ plugins?: SdkPluginConfig[]; disallowedTools?: string[] }> {
  try {
    if (!cacheCatalogo || Date.now() - cacheCatalogo.ts > 30_000) {
      cacheCatalogo = { ts: Date.now(), itens: await scanRaiz({ origem: 'c3', dir: CATALOGO_DIR, rotulo: 'catalogo' }) };
    }
    const plano = planoDeComposicao(cacheCatalogo.itens, await lerPrefs(pool), userId);
    const r = await materializar(plano, userId);
    return { ...(r.plugins.length ? { plugins: r.plugins } : {}), ...(r.disallowedTools.length ? { disallowedTools: r.disallowedTools } : {}) };
  } catch {
    return {};
  }
}
