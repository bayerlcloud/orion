import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * "Aba Claude" — painel de skills (ver PARIDADE.md, seção 13, item 11).
 *
 * Habilitar/desabilitar aqui é bem mais seguro que editar hooks (ver `hooks.ts`): não passa nenhum
 * texto livre pro CLI, não escreve `settings.json` nenhum, e o "desligamento" em si nunca é mais que
 * um filtro de contexto — a opção real e documentada do Agent SDK `Options.skills: string[] | 'all'`
 * ("Skills to enable for the main session... unlisted skills are hidden from the model's listing and
 * rejected by the Skill tool, but their files remain on disk", `sdk.d.ts`). Por isso aqui vai além de
 * só leitura, diferente de `hooks.ts`.
 *
 * Descoberta: a extensão real busca a lista via um control-request pro CLI já rodando
 * (`get_skills_dialog`/`set_skill_state`, achados no webview decompilado v2.1.283 mas NÃO
 * documentados no `sdk.d.ts` público — são internos, só usados pela própria extensão) — o Orion não
 * tem esse canal fora de um turno ativo (mesmo motivo documentado em `hooks.ts`). Em vez disso, lemos
 * o disco direto: `.claude/skills/<nome>/SKILL.md` do projeto e `~/.claude/skills/<nome>/SKILL.md` do
 * usuário do processo Orion (`danilo`, compartilhado entre projetos) — mesmo layout de arquivo que o
 * próprio Claude Code usa pra descobrir skills (confirmado com exemplos reais no servidor:
 * `~/.claude/skills/migrar/SKILL.md`). Uma pasta `synced/<bucket>/<nome>/SKILL.md` sob o diretório de
 * usuário (achada de verdade neste servidor — skills sincronizadas de outro lugar, ex. claude.ai; o
 * campo `source` do SDK real até documenta `'syncedSkills'` como uma origem conhecida, `sdk.d.ts`
 * linha ~3823) é reconhecida como uma fonte própria (`synced`), varrendo um nível a mais.
 *
 * Fora de escopo (documentado, não esquecido): skills de PLUGIN — o Orion não tem marketplace de
 * plugins ainda (ver PARIDADE.md seção 13, item 3); o modelo real de 4 estados
 * (on/name-only/user-invocable-only/off, achado em `dx`/`wU0` no webview) — implementamos só
 * habilitada/desabilitada, que é exatamente o que o pedido original descreveu ("habilitada/
 * desabilitada") e cobre o caso de uso real (tirar uma skill do contexto do modelo).
 */

export type SkillSourceKind = 'project' | 'user' | 'synced';

export const SKILL_SOURCE_LABEL: Record<SkillSourceKind, string> = {
  project: 'Projeto',
  user: 'Usuário',
  synced: 'Sincronizada',
};

export type SkillFrontmatter = { name?: string; description?: string; argumentHint?: string };

/**
 * Parser de linha do frontmatter YAML de um `SKILL.md` real — só as 3 chaves que o Orion usa
 * (`name`, `description`, `argument-hint`); qualquer outra chave (`allowed-tools`, etc.) é ignorada.
 * Não é um parser YAML completo — desnecessário: todo `SKILL.md` real visto neste servidor usa
 * `chave: valor` de uma linha só, sem aninhamento. Nunca lança; sem frontmatter (`---`...`---` no
 * início), devolve `null`.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return null; // fence de abertura sem fechamento: não é frontmatter de verdade
  const out: SkillFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'argument-hint') out.argumentHint = value;
  }
  return out;
}

export type DiscoveredSkill = { name: string; description: string; source: SkillSourceKind; dir: string };

/** Lê um `SKILL.md` — `name` do frontmatter se houver, senão o nome da pasta; `description` vazia se ausente (nunca inventada). `null` se o arquivo não existir/não puder ser lido (pasta comum sem skill dentro). */
async function readSkillDir(dir: string, source: SkillSourceKind): Promise<DiscoveredSkill | null> {
  let raw: string;
  try { raw = await readFile(path.join(dir, 'SKILL.md'), 'utf-8'); } catch { return null; }
  const fm = parseSkillFrontmatter(raw);
  return { name: fm?.name?.trim() || path.basename(dir), description: fm?.description?.trim() ?? '', source, dir };
}

/**
 * Varre um diretório de skills um nível (`<base>/<nome>/SKILL.md`, layout padrão) — cada subpasta
 * com `SKILL.md` vira uma skill. Uma subpasta chamada `synced` sem `SKILL.md` própria (achada de
 * verdade em `~/.claude/skills/synced/<bucket>/<nome>/SKILL.md` neste servidor) é varrida mais um
 * nível (bucket → skill), rotulada como fonte `synced` em vez do `source` passado. Diretório
 * ausente/sem permissão: lista vazia, nunca lança.
 */
export async function scanSkillsDir(baseDir: string, source: SkillSourceKind): Promise<DiscoveredSkill[]> {
  let entries;
  try { entries = await readdir(baseDir, { withFileTypes: true }); } catch { return []; }
  const out: DiscoveredSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(baseDir, e.name);
    const direct = await readSkillDir(dir, source);
    if (direct) { out.push(direct); continue; }
    if (e.name !== 'synced') continue;
    let buckets;
    try { buckets = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const b of buckets) {
      if (!b.isDirectory()) continue;
      const bucketDir = path.join(dir, b.name);
      let subs;
      try { subs = await readdir(bucketDir, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const skill = await readSkillDir(path.join(bucketDir, s.name), 'synced');
        if (skill) out.push(skill);
      }
    }
  }
  return out;
}

/**
 * Todas as skills descobertas pra um projeto: `.claude/skills/` do projeto + `~/.claude/skills/` do
 * usuário do processo Orion. Sem deduplicação por nome entre as duas fontes — mesmo nome em projeto E
 * usuário aparece 2x, cada um com seu `source`: são arquivos `SKILL.md` diferentes de verdade, não um
 * bug (o próprio Claude Code os trata como entradas separadas, com precedência entre si que o Orion
 * não precisa replicar aqui — isto é só a LISTAGEM, não a resolução de qual roda).
 */
export async function discoverSkills(projectPath: string, homeDir: string = homedir()): Promise<DiscoveredSkill[]> {
  const [project, user] = await Promise.all([
    scanSkillsDir(path.join(projectPath, '.claude', 'skills'), 'project'),
    scanSkillsDir(path.join(homeDir, '.claude', 'skills'), 'user'),
  ]);
  return [...project, ...user];
}

export type SkillEntry = DiscoveredSkill & { enabled: boolean };

/**
 * Funde a descoberta em disco com os overrides salvos no Postgres (`claude_skill_settings`) — pura,
 * dado o Map já carregado; nunca toca o banco. Skill sem override é `enabled: true` (nada
 * desabilitado até alguém mexer explicitamente — mesmo espírito de "omitido = comportamento de
 * sempre" que `Options.skills` documenta). Um override de skill que não existe mais no disco (pasta
 * apagada/renomeada) é simplesmente ignorado, nunca inventa uma linha fantasma.
 */
export function applySkillOverrides(discovered: DiscoveredSkill[], overrides: ReadonlyMap<string, boolean>): SkillEntry[] {
  return discovered.map(s => ({ ...s, enabled: overrides.get(s.name) ?? true }));
}

/**
 * O que passar em `Options.skills` (SDK) pra um turno — pura. `undefined` quando nada foi
 * desabilitado: omitir a opção é o comportamento de sempre ("não é skills off", `sdk.d.ts`) — não
 * vira `'all'` nem lista explícita à toa, pra nunca mudar o comportamento de uma sessão que nunca
 * usou este painel. Com algo desabilitado, devolve a lista explícita dos nomes AINDA habilitados
 * (mesmo se ficar vazia — todas desabilitadas é uma escolha válida, diferente de "nenhuma opinião").
 */
export function resolveSkillsOption(allNames: string[], disabled: ReadonlySet<string>): string[] | undefined {
  if (disabled.size === 0) return undefined;
  return allNames.filter(n => !disabled.has(n));
}

export async function getSkillOverrides(pool: Pool, projectId: number): Promise<Map<string, boolean>> {
  const { rows } = await pool.query('SELECT skill_name, enabled FROM claude_skill_settings WHERE project_id = $1', [projectId]);
  return new Map(rows.map((r: { skill_name: string; enabled: boolean }) => [r.skill_name, r.enabled]));
}

export async function setSkillOverride(pool: Pool, projectId: number, skillName: string, enabled: boolean, userId: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO claude_skill_settings (project_id, skill_name, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (project_id, skill_name) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [projectId, skillName, enabled, userId]);
}

/** Skills do projeto pra tela — descoberta em disco + estado salvo aplicado. Usado pela rota GET. */
export async function listProjectSkills(pool: Pool, projectId: number, projectPath: string, homeDir?: string): Promise<SkillEntry[]> {
  const [discovered, overrides] = await Promise.all([discoverSkills(projectPath, homeDir), getSkillOverrides(pool, projectId)]);
  return applySkillOverrides(discovered, overrides);
}

/**
 * `Options.skills` pro próximo turno de um projeto — combina overrides salvos + descoberta em disco.
 * `projectId` nulo (sessão sem projeto): `undefined`, sem tentar resolver nada. Sem nenhum override
 * `enabled:false` salvo: `undefined` direto, sem nem varrer o disco (turno mais comum, sem custo
 * extra de I/O).
 */
export async function turnSkillsOption(pool: Pool, projectId: number | null, projectPath: string, homeDir?: string): Promise<string[] | undefined> {
  if (projectId == null) return undefined;
  const overrides = await getSkillOverrides(pool, projectId);
  const disabled = new Set([...overrides.entries()].filter(([, enabled]) => !enabled).map(([name]) => name));
  if (disabled.size === 0) return undefined;
  const discovered = await discoverSkills(projectPath, homeDir);
  return resolveSkillsOption(discovered.map(s => s.name), disabled);
}
