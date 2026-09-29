/**
 * Rotas do marketplace de plugins + servidores MCP da aba Claude (ver server/tools/marketplace.ts
 * pra decisão de arquitetura completa e web/src/claude/Marketplace.tsx pra UI). Autenticadas;
 * TUDO que muda o catálogo ou o Claude Code do servidor (adicionar/remover/atualizar marketplace,
 * instalar plugin) é só do admin. O liga/desliga por pessoa (chave plugin:<nome> em skill_prefs)
 * qualquer usuário faz pra si; o padrão "todos" é só do admin — mesma regra da aba Tools.
 */
import type { FastifyInstance } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CATALOGO_DIR, scanRaiz, type SkillItem } from '../tools/skillsScan.js';
import { TODOS, chavePlugin, ensureSkillPrefsTable, estadoDe, gravarPref, invalidarCatalogo, lerPrefs, raizDoPlugin } from '../tools/skillPrefs.js';
import {
  CATALOGO_PLUGINS_DIR, fonteValida, instalarNoCatalogo, lerMarketplaces, lerPluginJson,
  nomeValido, runClaudePlugin,
} from '../tools/marketplace.js';
import { KEYS, getSetting, hostingerMcpServers } from '../settings.js';
import { listarContasGithub, nomeMcpGithub } from '../tools/githubAccounts.js';
import { listarContasCloudflare, nomeMcpCloudflare } from '../tools/cloudflareAccounts.js';

export async function marketplaceRoutes(app: FastifyInstance) {
  await ensureSkillPrefsTable(app.pool);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'não autenticado' });
  });
  const soAdmin = (req: { user: { role: string } | null }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    req.user!.role !== 'owner' ? reply.code(403).send({ error: 'só o admin muda o catálogo' }) : null;

  /** Plugins do catálogo com o estado POR PESSOA (chave plugin:<nome> em skill_prefs). */
  app.get('/api/claude/marketplace/plugins', async (req) => {
    const prefs = await lerPrefs(app.pool);
    let nomes: string[] = [];
    try { nomes = (await readdir(CATALOGO_PLUGINS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { /* catálogo vazio */ }
    // Contagem de skills/commands/agents por plugin, da MESMA varredura que a composição usa.
    const itens = await scanRaiz({ origem: 'c3', dir: CATALOGO_DIR, rotulo: 'catalogo' });
    const porPlugin = new Map<string, SkillItem[]>();
    for (const it of itens) {
      const raiz = raizDoPlugin(it.path);
      if (raiz) porPlugin.set(path.basename(raiz), [...(porPlugin.get(path.basename(raiz)) ?? []), it]);
    }
    const plugins = await Promise.all(nomes.map(async nome => {
      const pj = await lerPluginJson(nome);
      const meus = porPlugin.get(nome) ?? [];
      const e = estadoDe(chavePlugin(nome), req.user!.id, prefs);
      return {
        nome,
        descricao: (pj?.description ?? '').trim(),
        versao: pj?.version ?? null,
        autor: typeof pj?.author === 'string' ? pj.author : pj?.author?.name ?? null,
        hooks: !!pj?.hooks,
        skills: meus.filter(i => i.kind === 'skill').length,
        commands: meus.filter(i => i.kind === 'command').length,
        agents: meus.filter(i => i.kind === 'agent').length,
        ligada_todos: e.todos, ligada_eu: e.eu, efetiva: e.efetiva,
      };
    }));
    return { plugins, catalogo_dir: CATALOGO_PLUGINS_DIR };
  });

  /** Liga/desliga um plugin INTEIRO: escopo "eu" (qualquer usuário) ou "todos" (só admin).
   *  ligada=null apaga a escolha (volta ao padrão). Persiste na composição da pessoa via
   *  skill_prefs — planoDeComposicao pula o plugin quando a chave efetiva é false. */
  app.put<{ Params: { nome: string }; Body: { escopo?: string; ligada?: boolean | null } }>('/api/claude/marketplace/plugins/:nome', async (req, reply) => {
    const nome = req.params.nome;
    if (!nomeValido(nome)) return reply.code(400).send({ error: 'nome inválido' });
    if (!(await stat(path.join(CATALOGO_PLUGINS_DIR, nome)).catch(() => null))) return reply.code(404).send({ error: 'esse plugin não está no catálogo' });
    const escopo = req.body?.escopo === 'todos' ? 'todos' : 'eu';
    if (escopo === 'todos' && req.user!.role !== 'owner') return reply.code(403).send({ error: 'só o admin muda o padrão de todos' });
    const ligada = req.body?.ligada === null || req.body?.ligada === undefined ? null : Boolean(req.body.ligada);
    await gravarPref(app.pool, chavePlugin(nome), escopo === 'todos' ? TODOS : req.user!.id, ligada);
    return { ok: true, ...estadoDe(chavePlugin(nome), req.user!.id, await lerPrefs(app.pool)) };
  });

  /** Marketplaces configurados + o que cada um oferece (com "instalado" quando já está no catálogo). */
  app.get('/api/claude/marketplace/marketplaces', async () => {
    const marketplaces = await lerMarketplaces();
    let noCatalogo = new Set<string>();
    try { noCatalogo = new Set((await readdir(CATALOGO_PLUGINS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)); } catch { /* vazio */ }
    return {
      marketplaces: marketplaces.map(m => ({ ...m, plugins: m.plugins.map(p => ({ ...p, instalado: noCatalogo.has(p.name) })) })),
    };
  });

  /** Adiciona um marketplace por dono/repo ou URL git https (`claude plugin marketplace add`). Só admin. */
  app.post<{ Body: { source?: string } }>('/api/claude/marketplace/marketplaces', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const source = (req.body?.source ?? '').trim();
    if (!fonteValida(source)) return reply.code(400).send({ error: 'fonte inválida: use dono/repo do GitHub ou uma URL git https (caminho local não é aceito aqui)' });
    const r = await runClaudePlugin(['marketplace', 'add', source]);
    if (!r.ok) return reply.code(502).send({ error: `o Claude Code recusou: ${r.saida.slice(0, 1500)}` });
    app.log.info(`marketplace adicionado por ${req.user!.email}: ${source}`);
    return { ok: true, saida: r.saida.slice(0, 500) };
  });

  /** Remove um marketplace (`claude plugin marketplace remove`). Só admin; plugins já copiados pro catálogo ficam. */
  app.delete<{ Params: { nome: string } }>('/api/claude/marketplace/marketplaces/:nome', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    if (!nomeValido(req.params.nome)) return reply.code(400).send({ error: 'nome inválido' });
    const r = await runClaudePlugin(['marketplace', 'remove', req.params.nome]);
    if (!r.ok) return reply.code(502).send({ error: `o Claude Code recusou: ${r.saida.slice(0, 1500)}` });
    app.log.info(`marketplace removido por ${req.user!.email}: ${req.params.nome}`);
    return { ok: true };
  });

  /** Atualiza um marketplace da fonte (`claude plugin marketplace update`) — o "Refresh marketplace" real. Só admin. */
  app.post<{ Params: { nome: string } }>('/api/claude/marketplace/marketplaces/:nome/refresh', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    if (!nomeValido(req.params.nome)) return reply.code(400).send({ error: 'nome inválido' });
    const r = await runClaudePlugin(['marketplace', 'update', req.params.nome]);
    if (!r.ok) return reply.code(502).send({ error: `o Claude Code recusou: ${r.saida.slice(0, 1500)}` });
    return { ok: true, saida: r.saida.slice(0, 500) };
  });

  /** Instala um plugin de um marketplace já configurado NO CATÁLOGO (ver instalarNoCatalogo). Só admin. */
  app.post<{ Body: { plugin?: string; marketplace?: string } }>('/api/claude/marketplace/install', async (req, reply) => {
    if (soAdmin(req, reply)) return;
    const plugin = (req.body?.plugin ?? '').trim();
    const marketplace = (req.body?.marketplace ?? '').trim();
    if (!nomeValido(plugin) || !nomeValido(marketplace)) return reply.code(400).send({ error: 'nome de plugin/marketplace inválido' });
    const r = await instalarNoCatalogo(plugin, marketplace);
    if (!r.ok) return reply.code(502).send({ error: r.erro });
    invalidarCatalogo();
    app.log.info(`plugin instalado no catálogo por ${req.user!.email}: ${plugin}@${marketplace} -> ${r.destino}`);
    return { ok: true, destino: r.destino };
  });

  /**
   * Servidores MCP configurados nas sessões do Orion — a lista `mcpServerList` da extensão real,
   * montada do que o runner realmente injeta em toda sessão (server/routes/claude.ts:
   * turnMcpServers): hostinger (com token em Configurações), um GitHub e um Cloudflare por conta da
   * aba Tools, e o orion-memory (sempre, em processo). Nunca expõe token/URL com credencial.
   * Status é "configurado" — o estado vivo (connected/failed) só existe dentro de uma sessão real,
   * simplificação documentada em PARIDADE-marketplace.md.
   */
  app.get('/api/claude/marketplace/mcp', async () => {
    const servers: { nome: string; tipo: string; detalhe: string; origem: string; escopo: string }[] = [];
    const host = hostingerMcpServers(await getSetting(app.pool, KEYS.hostingerToken));
    if (host) {
      for (const [nome, cfg] of Object.entries(host)) {
        servers.push({ nome, tipo: 'stdio', detalhe: `${cfg.command} ${cfg.args.join(' ')}`, origem: 'Token da Hostinger em Configurações', escopo: 'todas as sessões' });
      }
    }
    for (const c of await listarContasGithub(app.pool)) {
      servers.push({ nome: nomeMcpGithub(c.label), tipo: 'http', detalhe: 'https://api.githubcopilot.com/mcp/ (token da conta, nunca exposto)', origem: `Conta GitHub "${c.label}" (${c.login}) na aba Tools`, escopo: 'todas as sessões' });
    }
    for (const c of await listarContasCloudflare(app.pool)) {
      servers.push({ nome: nomeMcpCloudflare(c.label), tipo: 'http', detalhe: 'MCP oficial da Cloudflare (token da conta, nunca exposto)', origem: `Conta Cloudflare "${c.label}" na aba Tools`, escopo: 'todas as sessões' });
    }
    servers.push({ nome: 'orion-memory', tipo: 'sdk', detalhe: 'servidor em processo do próprio Orion (server/claude/memoryTool.ts)', origem: 'memória do painel, sempre presente', escopo: 'todas as sessões' });
    return { servers };
  });
}
