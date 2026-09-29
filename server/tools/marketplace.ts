/**
 * Marketplace de plugins da aba Claude — o diálogo "Manage Plugins" da extensão real (webview
 * v2.1.283: métodos listMarketplaces/addMarketplace/removeMarketplace/refreshMarketplace/
 * setPluginEnabled; classes pluginItem/pluginList/addMarketplaceForm/officialBadge) portado pra
 * infra que o Orion JÁ TEM, em vez de uma cópia paralela:
 *
 * - Plugins instalados vivem NO CATÁLOGO (/srv/claude/catalog/plugins/<nome>) e quem decide o que
 *   cada sessão carrega é a composição por pessoa (server/tools/skillPrefs.ts, main 690b817). O
 *   liga/desliga de plugin da UI real (`setPluginEnabled`) vira aqui uma preferência de plugin
 *   INTEIRO em skill_prefs (chave `plugin:<nome>`), respeitada por planoDeComposicao — por cima
 *   dela continuam valendo as preferências por skill que a aba Tools já tinha.
 * - Marketplaces são os do Claude Code real do usuário do serviço (~/.claude/plugins:
 *   known_marketplaces.json + marketplaces/<nome>/.claude-plugin/marketplace.json), porque é o
 *   `claude plugin marketplace add` que sabe clonar/validar a fonte.
 * - Instalar um plugin = `claude plugin install nome@marketplace` + cópia do cache pro catálogo +
 *   `claude plugin uninstall` (o home do serviço fica limpo; ativação por pessoa é da preferência).
 *
 * Segurança: NENHUM shell arbitrário — só `claude plugin …` com subcomandos em whitelist e
 * argumentos validados por regex (execFile com array de args, nunca string interpolada). As rotas
 * de mutação (server/routes/marketplace.ts) são só do admin.
 * Funções puras no topo (testadas em tests/marketplace.test.ts); disco e CLI embaixo.
 */
import { cp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { CATALOGO_DIR, CLAUDE_DIR } from './skillsScan.js';

const execFile = promisify(execFileCb);

/** Casa dos plugins/marketplaces do Claude Code do usuário do serviço (danilo na c3). */
export const PLUGINS_DIR = process.env.PLUGINS_DIR ?? path.join(CLAUDE_DIR, 'plugins');
export const CATALOGO_PLUGINS_DIR = path.join(CATALOGO_DIR, 'plugins');

// ---------- puras ----------

/** Nome de plugin/marketplace aceitável: sem barra/espaço, sem começar com ponto ou hífen. */
export function nomeValido(n: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n);
}

/**
 * Fonte aceitável pra `claude plugin marketplace add`: `dono/repo` do GitHub ou URL git https.
 * Caminho local é recusado DE PROPÓSITO (o placeholder real diz "GitHub repo, URL, or path…", mas
 * aqui um path viraria leitura de qualquer pasta do servidor por quem tem o painel). O charset
 * estreito também é a barreira contra injeção: nada de espaço, `;`, `$`, backtick etc.
 */
export function fonteValida(s: string): boolean {
  const t = s.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(t)) return true; // dono/repo
  return /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+(\.git)?$/.test(t); // URL git https
}

/** Badge "Official Claude Code marketplace" da UI real: fonte mantida pela Anthropic. */
export function ehOficial(source: unknown): boolean {
  const s = source as { repo?: string; url?: string } | null | undefined;
  const alvo = typeof s?.repo === 'string' ? s.repo : typeof s?.url === 'string' ? s.url : '';
  return /(^|github\.com\/)anthropics\//i.test(alvo);
}

/** URL navegável da fonte (o link "Source:" da UI real), ou null quando não dá pra montar. */
export function fonteUrl(source: unknown): string | null {
  const s = source as { repo?: string; url?: string } | null | undefined;
  if (typeof s?.url === 'string') return s.url;
  if (typeof s?.repo === 'string') return `https://github.com/${s.repo}`;
  return null;
}

/** Texto curto da fonte pra lista (dono/repo ou a URL). */
export function fonteTexto(source: unknown): string {
  const s = source as { repo?: string; url?: string; source?: string } | null | undefined;
  return (typeof s?.repo === 'string' && s.repo) || (typeof s?.url === 'string' && s.url) || (typeof s?.source === 'string' && s.source) || '';
}

export type KnownMarketplace = { nome: string; source: unknown; installLocation: string | null; lastUpdated: string | null };

/** known_marketplaces.json parseado — nunca lança, formato estranho vira lista vazia. */
export function parseKnownMarketplaces(km: unknown): KnownMarketplace[] {
  if (!km || typeof km !== 'object' || Array.isArray(km)) return [];
  return Object.entries(km as Record<string, { source?: unknown; installLocation?: unknown; lastUpdated?: unknown }>)
    .map(([nome, v]) => ({
      nome,
      source: v?.source ?? null,
      installLocation: typeof v?.installLocation === 'string' ? v.installLocation : null,
      lastUpdated: typeof v?.lastUpdated === 'string' ? v.lastUpdated : null,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

// ---------- disco ----------

export type PluginJson = { name?: string; version?: string; description?: string; author?: { name?: string } | string; hooks?: unknown };
export type MarketplacePlugin = { name: string; description: string; category: string | null };
export type MarketplaceInfo = {
  nome: string; fonte: string; fonte_url: string | null; oficial: boolean; atualizado: string | null;
  descricao: string; plugins: MarketplacePlugin[];
};

async function lerJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await readFile(p, 'utf8')) as T; } catch { return null; }
}

/** Marketplaces configurados: known_marketplaces.json + o marketplace.json clonado de cada um. */
export async function lerMarketplaces(pluginsDir = PLUGINS_DIR): Promise<MarketplaceInfo[]> {
  const km = parseKnownMarketplaces(await lerJson(path.join(pluginsDir, 'known_marketplaces.json')));
  const out: MarketplaceInfo[] = [];
  for (const m of km) {
    const local = m.installLocation ?? path.join(pluginsDir, 'marketplaces', m.nome);
    const mj = await lerJson<{ description?: string; plugins?: { name?: string; description?: string; category?: string }[] }>(
      path.join(local, '.claude-plugin', 'marketplace.json'));
    out.push({
      nome: m.nome, fonte: fonteTexto(m.source), fonte_url: fonteUrl(m.source), oficial: ehOficial(m.source),
      atualizado: m.lastUpdated, descricao: (mj?.description ?? '').trim(),
      plugins: (mj?.plugins ?? []).filter(p => typeof p?.name === 'string' && p.name)
        .map(p => ({ name: p.name!, description: (p.description ?? '').trim(), category: p.category ?? null })),
    });
  }
  return out;
}

/** plugin.json de um plugin do catálogo (ou null). */
export async function lerPluginJson(nome: string, catalogoPlugins = CATALOGO_PLUGINS_DIR): Promise<PluginJson | null> {
  return lerJson<PluginJson>(path.join(catalogoPlugins, nome, '.claude-plugin', 'plugin.json'));
}

/** Subpasta de versão mais nova dentro do cache do plugin (cache/<mp>/<plugin>/<versão>), ou o próprio dir. */
export async function dirDaVersao(dir: string): Promise<string> {
  try {
    const subs = (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory());
    if (!subs.length) return dir;
    let melhor = subs[0].name, melhorTs = 0;
    for (const s of subs) {
      const ts = (await stat(path.join(dir, s.name))).mtimeMs;
      if (ts >= melhorTs) { melhorTs = ts; melhor = s.name; }
    }
    return path.join(dir, melhor);
  } catch { return dir; }
}

// ---------- CLI (whitelist) ----------

const SUBCOMANDOS = new Set(['marketplace add', 'marketplace remove', 'marketplace update', 'install', 'uninstall']);

/** Roda `claude plugin <args>` — SÓ subcomandos da whitelist, args como array (sem shell). */
export async function runClaudePlugin(args: string[], timeoutMs = 180_000): Promise<{ ok: boolean; saida: string }> {
  const sub = args[0] === 'marketplace' ? `marketplace ${args[1]}` : args[0];
  if (!SUBCOMANDOS.has(sub)) throw new Error(`subcomando fora da whitelist: ${sub}`);
  try {
    const r = await execFile('claude', ['plugin', ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, saida: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, saida: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message ?? e) };
  }
}

/**
 * Instala um plugin de um marketplace já configurado DENTRO DO CATÁLOGO:
 * `claude plugin install` (sem -y: se o marketplace declara um comando de instalação, o CLI recusa
 * e a recusa vai crua pro admin decidir — nunca aceitamos comando declarado automaticamente),
 * depois copia o cache pro catálogo e desinstala do home (melhor esforço).
 */
export async function instalarNoCatalogo(plugin: string, marketplace: string, deps?: { pluginsDir?: string; catalogoPlugins?: string; run?: typeof runClaudePlugin }): Promise<{ ok: boolean; destino?: string; erro?: string }> {
  const pluginsDir = deps?.pluginsDir ?? PLUGINS_DIR;
  const catalogoPlugins = deps?.catalogoPlugins ?? CATALOGO_PLUGINS_DIR;
  const run = deps?.run ?? runClaudePlugin;
  const destino = path.join(catalogoPlugins, plugin);
  if (await stat(destino).catch(() => null)) return { ok: false, erro: `já existe no catálogo: ${destino}` };
  const inst = await run(['install', `${plugin}@${marketplace}`]);
  if (!inst.ok) return { ok: false, erro: inst.saida.slice(0, 2000) };
  const cacheBase = path.join(pluginsDir, 'cache', marketplace, plugin);
  if (!(await stat(cacheBase).catch(() => null))) return { ok: false, erro: `instalou, mas o cache não apareceu em ${cacheBase}` };
  const origem = await dirDaVersao(cacheBase);
  await cp(origem, destino, { recursive: true });
  await run(['uninstall', `${plugin}@${marketplace}`]).catch(() => null); // melhor esforço: o catálogo já tem a cópia
  return { ok: true, destino };
}
