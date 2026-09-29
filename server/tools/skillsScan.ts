/**
 * Catálogo do que o Claude Code carrega (ou carregaria) como skill, command, subagente e hook.
 *
 * Fontes (raízes):
 * - c3: a casa viva do Claude na c3 (~danilo/.claude), o que toda sessão do painel enxerga.
 * - code-server: snapshot dos assets do Claude do code-server da c1 (/srv/migracao/code-server/claude),
 *   trazido por rsync sem sessões nem settings.json (só enabledPlugins/hooks, saneados).
 * - projeto: a pasta .claude de cada projeto registrado (skills/commands/agents de projeto).
 *
 * Como a ativação funciona (é o que a UI explica): o Claude Code lê SÓ o frontmatter (name +
 * description) de cada SKILL.md/command e coloca isso na lista da tool Skill no prompt de sistema.
 * O modelo decide invocar pela description ("Use when..."); só então o corpo do .md é carregado.
 * `disable-model-invocation: true` tira a skill dessa lista (só /nome funciona); `user-invocable:
 * false` esconde do menu / (só o modelo chama). Hooks não são chamados: são injetados por evento.
 *
 * Funções puras (frontmatter, ativação, sinais, dedupe) ficam no topo e têm teste em
 * tests/skillsScan.test.ts; a varredura de disco fica embaixo.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type Kind = 'skill' | 'command' | 'agent' | 'hook';
export type Ativacao = 'auto' | 'manual' | 'modelo' | 'sempre';
export type Origem = 'c3' | 'code-server' | 'projeto';
export type Frontmatter = Record<string, string>;

export type SkillItem = {
  id: string;
  kind: Kind;
  /** Nome como o Claude Code invoca: `nome`, `plugin:nome` ou `pasta:comando`. */
  invocacao: string;
  name: string;
  description: string;
  origem: Origem;
  /** Rótulo humano da fonte: "usuário", "plugin: superpowers", "claude.ai (sincronizado)", "projeto: brandspace". */
  fonte: string;
  plugin: string | null;
  ativacao: Ativacao;
  /** Plugin desligado no settings = false. Skills/commands soltos e sincronizados = true. */
  habilitada: boolean;
  path: string;
  bytes: number;
  /** Cita caminhos do code-server (/config/...): vai quebrar se ativada na c3 sem revisão. */
  refs_code_server: boolean;
  /** Parece conter senha/token: corpo só para o owner. */
  credencial: boolean;
  argument_hint: string | null;
  allowed_tools: string | null;
  model: string | null;
  /** id do item equivalente já ativo na c3 (mesma invocação e tipo). */
  duplicada_de: string | null;
  descricao_pt: string | null;
  /** Preenchidos pela rota para quem está olhando: chave da preferência, se tem botão, padrão do admin, escolha da pessoa, estado final. */
  chave?: string;
  ligavel?: boolean;
  ligada_todos?: boolean | null;
  ligada_eu?: boolean | null;
  efetiva?: boolean;
};

export const CLAUDE_DIR = process.env.CLAUDE_DIR ?? '/home/danilo/.claude';
export const MIGRACAO_CLAUDE_DIR = process.env.MIGRACAO_CLAUDE_DIR ?? '/srv/migracao/code-server/claude';
/** Catálogo em nível de sistema (fora de qualquer home): skills, commands, agents e plugins que o Orion compõe por pessoa. */
export const CATALOGO_DIR = process.env.CATALOGO_DIR ?? '/srv/claude/catalog';

// ---------- puras ----------

/** Frontmatter YAML simples: `chave: valor`, aspas opcionais, blocos `|`/`>` (linhas indentadas). */
export function parseFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm: Frontmatter = {};
  const linhas = m[1].split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    const kv = l.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const chave = kv[1];
    let valor = kv[2].trim();
    if (valor === '|' || valor === '>' || valor === '|-' || valor === '>-') {
      const bloco: string[] = [];
      while (i + 1 < linhas.length && (/^\s+/.test(linhas[i + 1]) || linhas[i + 1] === '')) bloco.push(linhas[++i].trim());
      valor = bloco.join(valor.startsWith('|') ? '\n' : ' ').trim();
    } else if (valor === '' && i + 1 < linhas.length && /^\s+\S/.test(linhas[i + 1])) {
      // objeto aninhado (ex.: metadata:); guarda só que existe
      while (i + 1 < linhas.length && /^\s+/.test(linhas[i + 1])) i++;
      valor = '';
    } else if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    }
    fm[chave] = valor;
  }
  return { fm, body: md.slice(m[0].length) };
}

function verdadeiro(v: string | undefined): boolean {
  return /^(true|yes|1)$/i.test((v ?? '').trim());
}
function falso(v: string | undefined): boolean {
  return /^(false|no|0)$/i.test((v ?? '').trim());
}

/** Regra do Claude Code: modelo pode chamar, salvo `disable-model-invocation`; `user-invocable: false` esconde do menu /. */
export function classificarAtivacao(kind: Kind, fm: Frontmatter): Ativacao {
  if (kind === 'hook') return 'sempre';
  if (kind === 'agent') return 'modelo';
  if (verdadeiro(fm['disable-model-invocation'])) return 'manual';
  if (falso(fm['user-invocable'])) return 'modelo';
  return 'auto';
}

export const ATIVACAO_LABEL: Record<Ativacao, string> = {
  auto: 'automática (o modelo chama pela description)',
  manual: 'só chamando /nome (disable-model-invocation)',
  modelo: 'só o modelo chama (fora do menu /)',
  sempre: 'sempre (hook injetado por evento)',
};

const RE_REFS_C1 = /\/config\/(workspace|\.claude|\.local|\.secrets|\.ssh)\b/;
// ponytail: heurística de credencial ampla (prefere sobrar); só decide quem vê o corpo, o owner vê tudo.
const RE_CREDENCIAL = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[a-z0-9-]{8,}|sbp_[a-f0-9]{20,}|\b(senha|password|passwd|basic_auth|api[_-]?key|secret)\b)/i;

export function sinais(md: string): { refs_code_server: boolean; credencial: boolean } {
  return { refs_code_server: RE_REFS_C1.test(md), credencial: RE_CREDENCIAL.test(md) };
}

/** Chave compartilhada entre cópias da mesma skill (c1 e c3, ou plugins repetidos): tipo + invocação. */
export function chaveDe(kind: Kind, invocacao: string): string {
  return `${kind}:${invocacao}`;
}

/** Marca cópias do code-server/projeto que já existem ativas na c3. Não remove nada; a UI esconde por padrão. */
export function marcarDuplicadas(itens: SkillItem[]): SkillItem[] {
  const naC3 = new Map<string, string>();
  for (const it of itens) if (it.origem === 'c3' && it.habilitada && !naC3.has(chaveDe(it.kind, it.invocacao))) naC3.set(chaveDe(it.kind, it.invocacao), it.id);
  return itens.map(it => {
    const dup = it.origem === 'c3' ? null : naC3.get(chaveDe(it.kind, it.invocacao)) ?? null;
    return { ...it, duplicada_de: dup === it.id ? null : dup };
  });
}

/** Onde o arquivo está dentro da raiz: plugin (cache/local/synced), sincronizado da claude.ai, ou solto. */
export function fonteDe(rel: string): { plugin: string | null; fonte: string; marketplace: string | null } {
  const p = rel.split('/');
  const i = p.indexOf('plugins');
  if (i >= 0) {
    const tipo = p[i + 1];
    if (tipo === 'cache' && p[i + 3]) return { plugin: p[i + 3], fonte: `plugin: ${p[i + 3]}`, marketplace: p[i + 2] };
    if (tipo === 'local' && p[i + 2]) return { plugin: p[i + 2], fonte: `plugin local: ${p[i + 2]}`, marketplace: 'local' };
    if (tipo === 'synced' && p[i + 3]) return { plugin: p[i + 3].replace(/~g\d+$/, ''), fonte: 'claude.ai (sincronizado)', marketplace: null };
    if (tipo && p[i + 2]) return { plugin: tipo, fonte: `plugin: ${tipo}`, marketplace: 'catalogo' }; // catálogo: plugins/<nome>/...
  }
  if (p[0] === 'skills' && p[1] === 'synced') return { plugin: null, fonte: 'claude.ai (sincronizado)', marketplace: null };
  return { plugin: null, fonte: 'usuário', marketplace: null };
}

/** Nome de invocação: command aninhado vira `pasta:nome`; item de plugin vira `plugin:nome`. */
export function invocacaoDe(kind: Kind, name: string, plugin: string | null): string {
  return plugin ? `${plugin}:${name}` : name;
}

function nomeCommand(relDentroDeCommands: string): string {
  return relDentroDeCommands.replace(/\.md$/, '').split('/').join(':');
}

// ---------- disco ----------

// Pastas que nunca contêm skill/command/agent (ou são cópia de outra fonte, caso de marketplaces).
const PULAR = new Set([
  'node_modules', '.git', '.trash', '.staging', 'dist', 'build', 'assets', 'references', 'examples', 'scripts',
  'ui', 'worktrees', 'memory-bank', 'projects', 'sessions', 'file-history', 'shell-snapshots', 'state', 'telemetry',
  'backups', 'plans', 'ide', 'session-env', 'marketplaces', 'repos', 'data', 'themes', 'templates', 'modes', 'test', 'tests',
]);
const PROFUNDIDADE_MAX = 9;

async function arquivosMd(root: string): Promise<string[]> {
  const out: string[] = [];
  async function desce(dir: string, prof: number) {
    if (prof > PROFUNDIDADE_MAX) return;
    let itens: import('node:fs').Dirent[];
    try { itens = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of itens) {
      if (d.name.startsWith('.') && d.name !== '.claude') continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { if (!PULAR.has(d.name)) await desce(abs, prof + 1); }
      else if (d.isFile() && d.name.endsWith('.md')) out.push(abs);
    }
  }
  await desce(root, 0);
  return out;
}

type Settings = { enabledPlugins?: Record<string, boolean>; hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]> };

async function lerSettings(root: string): Promise<Settings> {
  for (const nome of ['settings.sanitized.json', 'settings.json']) {
    try {
      const s = JSON.parse(await readFile(path.join(root, nome), 'utf8')) as Settings;
      return { enabledPlugins: s.enabledPlugins ?? {}, hooks: s.hooks ?? {} };
    } catch { /* tenta o próximo */ }
  }
  return { enabledPlugins: {}, hooks: {} };
}

export type Raiz = { origem: Origem; dir: string; rotulo: string };

function idDe(origem: string, abs: string): string {
  return createHash('sha1').update(`${origem}:${abs}`).digest('hex').slice(0, 12);
}

/** Varre uma raiz. Nunca lança: raiz inexistente vira lista vazia. */
export async function scanRaiz(raiz: Raiz): Promise<SkillItem[]> {
  const itens: SkillItem[] = [];
  try { if (!(await stat(raiz.dir)).isDirectory()) return itens; } catch { return itens; }
  const settings = await lerSettings(raiz.dir);
  const habilitadaPlugin = (plugin: string | null, marketplace: string | null): boolean => {
    if (!plugin || marketplace === null || marketplace === 'catalogo') return true; // solto, sincronizado ou do catálogo (quem decide é a preferência)
    const en = settings.enabledPlugins ?? {};
    return en[`${plugin}@${marketplace}`] === true || en[plugin] === true;
  };

  for (const abs of await arquivosMd(raiz.dir)) {
    const rel = path.relative(raiz.dir, abs).split(path.sep).join('/');
    const partes = rel.split('/');
    const nomeArq = partes[partes.length - 1];
    let kind: Kind | null = null;
    let name = '';
    const iCmd = partes.lastIndexOf('commands');
    const iAg = partes.lastIndexOf('agents');
    if (nomeArq === 'SKILL.md') { kind = 'skill'; name = partes[partes.length - 2] ?? ''; }
    else if (iCmd >= 0 && iCmd < partes.length - 1) { kind = 'command'; name = nomeCommand(partes.slice(iCmd + 1).join('/')); }
    else if (iAg >= 0 && iAg === partes.length - 2) { kind = 'agent'; name = nomeArq.replace(/\.md$/, ''); }
    if (!kind) continue;

    let md = '';
    try { md = await readFile(abs, 'utf8'); } catch { continue; }
    const { fm } = parseFrontmatter(md);
    const { plugin, fonte, marketplace } = fonteDe(rel);
    if (kind === 'skill' && fm.name) name = fm.name;
    const fonteFinal = raiz.origem === 'projeto' ? `projeto: ${raiz.rotulo}` : fonte;
    const s = sinais(md);
    itens.push({
      id: idDe(raiz.origem + raiz.rotulo, abs),
      kind, name,
      invocacao: invocacaoDe(kind, name, plugin),
      description: (fm.description ?? '').trim(),
      origem: raiz.origem, fonte: fonteFinal, plugin,
      ativacao: classificarAtivacao(kind, fm),
      habilitada: habilitadaPlugin(plugin, marketplace),
      path: abs, bytes: Buffer.byteLength(md),
      refs_code_server: s.refs_code_server, credencial: s.credencial,
      argument_hint: fm['argument-hint'] ?? null,
      allowed_tools: fm['allowed-tools'] ?? fm.tools ?? null,
      model: fm.model ?? null,
      duplicada_de: null, descricao_pt: null,
    });
  }

  // Hooks do settings (c3: settings.json, se existir; code-server: settings.sanitized.json).
  for (const [evento, lista] of Object.entries(settings.hooks ?? {})) {
    for (const h of lista ?? []) for (const x of h.hooks ?? []) {
      const cmd = (x.command ?? x.type ?? '').trim();
      if (!cmd) continue;
      const name = `${evento}${h.matcher && h.matcher !== '*' ? ` (${h.matcher})` : ''}`;
      itens.push({
        id: idDe(raiz.origem + raiz.rotulo, `hook:${evento}:${h.matcher ?? ''}:${cmd}`),
        kind: 'hook', name, invocacao: name, description: cmd,
        origem: raiz.origem, fonte: raiz.origem === 'projeto' ? `projeto: ${raiz.rotulo}` : 'settings.json', plugin: null,
        ativacao: 'sempre', habilitada: true, path: path.join(raiz.dir, 'settings.json'), bytes: 0,
        refs_code_server: RE_REFS_C1.test(cmd), credencial: false,
        argument_hint: null, allowed_tools: null, model: null, duplicada_de: null, descricao_pt: null,
      });
    }
  }
  return itens;
}

export async function scanTudo(raizes: Raiz[]): Promise<SkillItem[]> {
  const listas = await Promise.all(raizes.map(scanRaiz));
  const ordem: Record<Origem, number> = { c3: 0, 'code-server': 1, projeto: 2 };
  const itens = listas.flat().sort((a, b) => ordem[a.origem] - ordem[b.origem] || a.kind.localeCompare(b.kind) || a.invocacao.localeCompare(b.invocacao));
  return marcarDuplicadas(itens);
}

export function raizesPadrao(projetos: { slug: string; path: string }[]): Raiz[] {
  return [
    { origem: 'c3', dir: CATALOGO_DIR, rotulo: 'catalogo' },
    { origem: 'c3', dir: CLAUDE_DIR, rotulo: 'c3' },
    { origem: 'code-server', dir: MIGRACAO_CLAUDE_DIR, rotulo: 'code-server' },
    ...projetos.map(p => ({ origem: 'projeto' as const, dir: path.join(p.path, '.claude'), rotulo: p.slug })),
  ];
}
