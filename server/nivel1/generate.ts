// Gerador do nível 1: regenera os 3 arquivos de contexto injetados em toda sessão do Claude
// (~danilo/.claude/nivel1/*.md, importados via @import pelo CLAUDE.md) e espelha o conteúdo
// na tabela memories (codes nivel1-*). Roda dentro do ciclo do orion-inventory (scripts/inventory.ts).
//
// Arquitetura: TEMPLATE + DADOS, 100% determinístico (zero LLM).
// - Partes DINÂMICAS, interpoladas a cada execução: usuários e projetos (Postgres), versão do
//   claude (aproveitada do snapshot de inventário) e listagem de skills/commands/plugins do disco.
// - Partes CURADAS, fatos que não existem em banco nenhum (IPs e papéis dos outros servidores,
//   regra de DNS, chave da frota, convenção de worktree, seção de memória): vivem como
//   constantes de template AQUI, versionadas no git. Mudou um fato curado = edita este arquivo.
//
// Regras: escrita atômica (tmp + rename, nunca arquivo pela metade), falha de uma fonte nunca
// aborta a regeneração inteira (mantém o arquivo anterior ou marca a linha como indisponível),
// NUNCA tocar no CLAUDE.md (nível 0, só o Danilo edita) e NUNCA usar travessão em texto gerado.
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Binario } from '../inventory.js';

export const NIVEL1_DIR = '/home/danilo/.claude/nivel1';
const CLAUDE_DIR = '/home/danilo/.claude';

export type UsuarioPainel = { name: string; email: string; role: string };
export type ProjetoPainel = { slug: string; name: string; path: string };
export type Customizacoes = { skills: string[]; commands: string[]; plugins: string[] };
export type ResultadoNivel1 = { escritos: string[]; avisos: string[] };

// ---------- saneamento ----------

/** Valor dinâmico seguro para uma célula de tabela markdown: sem travessão (regra do nível 0), sem | e em uma linha. */
export function limpo(valor: string): string {
  return String(valor ?? '').replace(/[—–]/g, '-').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

// ---------- renders puros (recebem dados, devolvem a string do arquivo) ----------

// mapa.md é 100% curado; regenerar mesmo assim faz o arquivo se autocorrigir se alguém mexer nele.
export function renderMapa(): string {
  return `# Mapa: onde estou e como chego (nível 1, auto-atualizável)

## Servidores Bayerl Cloud
| Nome (como a equipe chama) | IP | Papel |
|---|---|---|
| contabo 03 = c3 (VOCÊ ESTÁ AQUI) | 217.76.55.249 | Orion v2 (v2.bayerl.cloud), 6 vCPU/12 GB, Ubuntu 24.04 |
| contabo 01 = c1 | 86.48.28.10 | code-server, SilverBullet, n8n, Evolution, Caddy (code/notas/workflow/evo/pages.bayerl.cloud) |
| contabo 02 = c2 | 212.47.70.170 | Supabase self-hosted, litellm (RAM apertada, swap alto) |
| hosting = hostinger | 72.61.135.82 | Coolify + ~66 containers (disco 73%) |

## Acesso
- SSH da c3 para as outras ("ssh contabo 01/02", "ssh hosting"): ssh -i ~danilo/.ssh/fleet_ed25519 root@<IP>. Chave da frota, root nas três, restrita ao IP da c3.
- Segredos: /etc/orion/central.env (DATABASE_URL, SESSION_SECRET); tabela settings do Postgres (token Claude, token Hostinger); /config/.secrets na c1. Nunca copiar segredo para memória ou repositório.

## DNS (bayerl.cloud)
- Gerenciado na Hostinger. Sempre registro A explícito (nada de confiar em wildcard): c1=86.48.28.10, c3=217.76.55.249, hostinger=72.61.135.82. TTL 300 novo, 14400 estável.

## Vital na c3
- orion-central (systemd, usuário danilo, porta 127.0.0.1:3000) atrás do Caddy = v2.bayerl.cloud
- orion-postgres (container, volume /srv/postgres)
- orion-inventory.timer (1h): inventário + regeneração destes arquivos de nível 1
- Projetos em /srv/projects/<slug>; worktrees de tarefa em /srv/worktrees/<proj>/<id>
`;
}

/** Rótulo curado do papel: o owner é o Danilo ("Bayerl"); os demais saem como estão no banco. */
function papel(role: string): string {
  return role === 'owner' ? 'owner (o dono; "Bayerl")' : limpo(role);
}

export function renderEquipe(users: UsuarioPainel[], projects: ProjetoPainel[]): string {
  const pessoas = users.map(u => `| ${limpo(u.name)} | ${limpo(u.email)} | ${papel(u.role)} |`).join('\n');
  const projetos = projects.map(p => `| ${limpo(p.slug)} | ${limpo(p.name)} | ${limpo(p.path)} |`).join('\n');
  return `# Equipe e projetos (nível 1, auto-atualizável)

## Pessoas (painel Orion)
| Nome | E-mail | Papel |
|---|---|---|
${pessoas}

Uma conta Claude Max compartilhada por todos; a pessoa é identificada pelo login do painel e pelo prefixo [Nome] na mensagem.

## Projetos registrados
| Slug | Nome | Pasta |
|---|---|---|
${projetos}

## Convenção de trabalho
- Repositório único por projeto na c3; GitHub é só espelho.
- Cada tarefa do kanban vira worktree em /srv/worktrees/<proj>/<id>, branch tarefa/<slug>-<id>.
- Ninguém faz git na mão; o integrador junta na principal, roda testes e espelha.
`;
}

/** Linhas da seção de skills: lista o que é custom; vazio ou falha viram uma linha honesta. */
function linhasCustom(custom: Customizacoes | null): string {
  if (!custom) return '- Skills/commands custom: listagem indisponível neste ciclo.';
  const partes: string[] = [];
  if (custom.skills.length) partes.push(`- Skills custom: ${custom.skills.map(limpo).join(', ')}.`);
  if (custom.commands.length) partes.push(`- Commands custom: ${custom.commands.map(limpo).join(', ')}.`);
  if (custom.plugins.length) partes.push(`- Plugins custom: ${custom.plugins.map(limpo).join(', ')}.`);
  if (!partes.length) return '- Skills/commands custom: nenhum instalado ainda (só os sincronizados por plugin).';
  return partes.join('\n');
}

export function renderCapacidades(versaoClaude: string | null, custom: Customizacoes | null): string {
  const versao = versaoClaude ? limpo(versaoClaude) : '(versão indisponível neste ciclo)';
  return `# Capacidades desta instalação (nível 1, auto-atualizável)

## Motor
- Claude Code ${versao}, invocado pelo painel via Agent SDK (query() in-process, sessões retomáveis, aprovação de ferramentas pela tela, timeout de permissão 30 min).
- Conta Claude Max conectada no home do danilo (login pelo navegador na aba Configurações). Sem orçamento por padrão; quando configurado (aba Configurações), é em tokens por mensagem, nunca em dinheiro.
- Modos: default / acceptEdits / plan / auto. Modelo e esforço selecionáveis por sessão.

## Publicar o Orion (deploy com fila)
- Qualquer pessoa publica: pelo botão "Publicar main" em Configurações, pelo botão "Publicar" da tarefa integrada, ou pedindo no chat (o Claude escreve /srv/builds/pedido.json com {"ref":"main","por":"<seu nome>"}). O systemd constrói num checkout limpo, roda typecheck e testes, troca /srv/orion-live e reinicia; falhou, volta sozinho. Um por vez; estado em /srv/builds/status.json.
- Publicar reinicia o Orion e derruba a sua sessão no meio; é esperado. Pode esperar o /srv/builds/status.json: se falhar antes do reinício (typecheck, testes, build), você vê o erro na hora; se chegar ao reinício, a espera é cortada e você é retomado sozinho já com o resultado (deu certo, ou falhou com o fim do log). Não publique de novo por causa do corte. Deixe a espera do status.json como a última ação do turno (tudo que precisa ser feito antes, faça antes de pedir a publicação).
- Nunca rodar npm run build na pasta /srv/orion nem reiniciar o serviço na mão.

## MCPs e integrações
- hostinger: DNS do bayerl.cloud (token na tabela settings). Sempre registro A explícito.
- Anexos no chat: imagens viram blocos base64; outros arquivos chegam como caminho em /srv/claude-uploads (ler com ferramentas).

## Referência da extensão oficial (para "fazer igual")
- /srv/orion/referencia/ (aba Arquivos, projeto Orion; atalho antigo /srv/orion-reference) guarda cópias descompactadas da extensão Claude Code do VS Code: antigravity-2.1.165/ (a que o Danilo usa no Mac) e 2.1.283/ (marketplace). README.md lá explica o layout; UI do chat em webview/index.js e index.css, lado host em extension.js, ícones em resources/.
- Pedido do tipo "copie X da extensão" ou "faça igual ao plugin": ler direto dessas pastas, sem pedir para o Danilo mandar nada.

## Skills, plugins e comandos
${linhasCustom(custom)}
- Para criar: ~danilo/.claude/skills/ e .claude/commands/ (aparecem em toda sessão nova).

## Memória (como usar)
- Painel Memória (tabela memories no Postgres): níveis 0-3, escopo universal/projeto/usuário.
- Arquivos por projeto em ~danilo/.claude/projects/<pasta>/memory/ (MEMORY.md = índice injetado; corpo lido sob demanda).
- Nível 0 e 1 chegam pelo CLAUDE.md; nível 2 pelo escopo da sessão; nível 3 só no índice.
`;
}

// ---------- fontes dinâmicas ----------

/** Extrai o número de versão do claude do snapshot de inventário (ex.: "2.1.283 (Claude Code)" vira "2.1.283"). */
export function versaoClaudeDe(binarios: Pick<Binario, 'nome' | 'versao'>[]): string | null {
  const claude = binarios.find(b => b.nome === 'claude');
  const m = claude?.versao.match(/\d+\.\d+(?:\.\d+)?/);
  return m ? m[0] : null;
}

// Pastas de infraestrutura do Claude Code que não são customização de ninguém.
// ponytail: lista fixa; se o Claude Code criar outra pasta interna, adicione aqui.
const PASTAS_INFRA = new Set(['synced', 'data', 'cache', 'repos', 'config.json', 'marketplaces']);

/** Nomes custom em uma pasta: [] se a pasta não existe, null se a leitura falhou de verdade. */
async function nomesEm(dir: string): Promise<string[] | null> {
  try {
    const itens = await readdir(dir);
    return itens
      .filter(n => !n.startsWith('.') && !PASTAS_INFRA.has(n))
      .map(n => n.replace(/\.md$/, ''))
      .sort();
  } catch (e: any) {
    return e?.code === 'ENOENT' ? [] : null;
  }
}

export async function listarCustomizacoes(claudeDir = CLAUDE_DIR): Promise<Customizacoes | null> {
  const [skills, commands, plugins] = await Promise.all([
    nomesEm(path.join(claudeDir, 'skills')),
    nomesEm(path.join(claudeDir, 'commands')),
    nomesEm(path.join(claudeDir, 'plugins')),
  ]);
  if (!skills || !commands || !plugins) return null;
  return { skills, commands, plugins };
}

// ---------- escrita e orquestração ----------

/** Escrita atômica: quem lê o arquivo (toda sessão do Claude) nunca vê conteúdo pela metade. */
export async function escreverAtomico(destino: string, conteudo: string): Promise<void> {
  const tmp = `${destino}.tmp`;
  await writeFile(tmp, conteudo, 'utf8');
  await rename(tmp, destino);
}

type Arquivo = { nome: string; code: string; conteudo: string };

/**
 * Busca as fontes, regenera os arquivos e espelha cada um na linha correspondente da tabela
 * memories (só body_md e updated_at; status/level/summary são do painel). Nunca lança: toda
 * falha vira aviso e, no pior caso, o arquivo anterior fica como está (último valor conhecido).
 */
export async function generateNivel1(
  pool: Pool,
  binarios: Pick<Binario, 'nome' | 'versao'>[],
  dir = NIVEL1_DIR,
): Promise<ResultadoNivel1> {
  const escritos: string[] = [];
  const avisos: string[] = [];

  const consulta = async <T>(sql: string, fonte: string): Promise<T[] | null> => {
    try { return (await pool.query(sql)).rows as T[]; }
    catch (e: any) { avisos.push(`consulta de ${fonte} falhou: ${e?.message ?? e}`); return null; }
  };
  const users = await consulta<UsuarioPainel>('SELECT name, email, role FROM users ORDER BY id', 'usuários');
  const projects = await consulta<ProjetoPainel>('SELECT slug, name, path FROM projects ORDER BY id', 'projetos');
  const custom = await listarCustomizacoes();
  if (!custom) avisos.push('listagem de skills/commands/plugins falhou; linha marcada como indisponível');
  const versao = versaoClaudeDe(binarios);
  if (!versao) avisos.push('versão do claude ausente no inventário; linha marcada como indisponível');

  const arquivos: Arquivo[] = [{ nome: 'mapa.md', code: 'nivel1-mapa', conteudo: renderMapa() }];
  if (users && projects) {
    arquivos.push({ nome: 'equipe-e-projetos.md', code: 'nivel1-equipe-e-projetos', conteudo: renderEquipe(users, projects) });
  } else {
    avisos.push('equipe-e-projetos.md mantido como estava (banco indisponível)');
  }
  arquivos.push({ nome: 'capacidades.md', code: 'nivel1-capacidades', conteudo: renderCapacidades(versao, custom) });

  try { await mkdir(dir, { recursive: true }); }
  catch (e: any) { avisos.push(`não deu para criar ${dir}: ${e?.message ?? e}`); return { escritos, avisos }; }

  for (const a of arquivos) {
    try { await escreverAtomico(path.join(dir, a.nome), a.conteudo); escritos.push(a.nome); }
    catch (e: any) { avisos.push(`falha ao escrever ${a.nome}: ${e?.message ?? e}`); continue; }
    try {
      const r = await pool.query('UPDATE memories SET body_md = $1, updated_at = now() WHERE code = $2', [a.conteudo, a.code]);
      if (r.rowCount !== 1) avisos.push(`espelho no painel: code ${a.code} não existe na tabela memories`);
    } catch (e: any) { avisos.push(`espelho no painel falhou para ${a.code}: ${e?.message ?? e}`); }
  }
  return { escritos, avisos };
}
