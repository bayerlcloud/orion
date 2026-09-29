/**
 * Output styles (estilos de saída) da aba Claude — o menu "Output styles" + o assistente "Build a
 * custom style" da extensão real (webview v2.1.283: get_output_style/create_output_style, strings
 * "Select an output style", "Switch to this style now", "Shows in the Output styles menu and
 * becomes the file name") portados pro Orion.
 *
 * Como o Claude Code representa isso (investigado em 29/09/2026, ver PARIDADE-marketplace.md):
 * - Estilo custom = arquivo .md com frontmatter `name`/`description`/`keep-coding-instructions`
 *   (chave REAL do CLI 2.x, achada no binário: "If true, the default coding instructions stay in
 *   the system prompt alongside the …") em ~/.claude/output-styles/ (usuário) ou
 *   .claude/output-styles/ (projeto); o identificador do estilo é o NOME DO ARQUIVO sem .md.
 * - Embutidos do CLI 2.x (nomes reais no binário, `outputStyle:<Nome>`): Explanatory, Learning,
 *   Concise, Proactive — mais "default" (sem estilo).
 * - Canal DIRETO no Agent SDK, sem gambiarra de systemAppend: `Options.settings` (camada de flag,
 *   equivalente ao `--settings` do CLI) aceita `outputStyle`, e ao vivo o control method
 *   `Query.applyFlagSettings({ outputStyle })` troca na hora (mesmo caminho que o esforço já usa
 *   em Runner.setEffortLive).
 *
 * No Orion o estilo custom é COMPARTILHADO: salvo em /srv/claude/catalog/output-styles/<slug>.md
 * (catálogo, com `criado-por:` no frontmatter) + um symlink em ~/.claude/output-styles/<slug>.md
 * pro CLI resolver o nome em qualquer sessão (settingSources inclui 'user' no runner).
 * Funções puras no topo (testadas em tests/outputStyles.test.ts); disco embaixo.
 */
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DIR } from './skillsScan.js';
import { parseFrontmatter } from './skillsScan.js';

export const ESTILOS_DIR = process.env.OUTPUT_STYLES_DIR ?? '/srv/claude/catalog/output-styles';
export const ESTILOS_USER_DIR = path.join(CLAUDE_DIR, 'output-styles');

/** Embutidos do Claude Code 2.x + "default" (sem estilo). Rótulos em inglês de propósito: são os
 *  nomes REAIS que o CLI conhece; só a descrição explica em pt-BR. */
export const ESTILOS_EMBUTIDOS = [
  { nome: 'default', label: 'Padrão', descricao: 'Respostas normais do Claude Code, focadas em completar a tarefa' },
  { nome: 'Explanatory', label: 'Explanatory', descricao: 'Explica o raciocínio e as decisões enquanto trabalha' },
  { nome: 'Learning', label: 'Learning', descricao: 'Modo aprendizado: explica e pede sua participação no código' },
  { nome: 'Concise', label: 'Concise', descricao: 'Respostas mais curtas e diretas' },
  { nome: 'Proactive', label: 'Proactive', descricao: 'Mais iniciativa: antecipa próximos passos e riscos' },
] as const;

export type Estilo = { nome: string; label: string; descricao: string; builtin: boolean; criado_por: string | null };
export type EstiloDraft = { nome: string; descricao: string; instrucoes: string; manterInstrucoesCodigo: boolean };

// ---------- puras ----------

const RE_PROIBIDOS = /[/\\:*?"<>|]/;

/** Nome do arquivo (= identificador do estilo pro Claude Code) a partir do nome digitado. */
export function slugDeNome(nome: string): string {
  return nome.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
}

/** Mesmas regras do assistente real ("Enter a name", "A name can't contain / \ : * ? " < > | or ---",
 *  "X is already a style name"). `existentes` = slugs já ocupados (embutidos + catálogo). */
export function validarNome(nome: string, existentes: string[]): string | null {
  const n = nome.trim();
  if (!n) return 'Digite um nome';
  if (RE_PROIBIDOS.test(n) || n.includes('---')) return 'O nome não pode conter / \\ : * ? " < > | nem ---';
  const slug = slugDeNome(n);
  if (!slug) return 'Digite um nome com letras ou números';
  const baixo = new Set(existentes.map(e => e.toLowerCase()));
  if (baixo.has(slug) || baixo.has(n.toLowerCase())) return `${n} já é o nome de um estilo. Escolha outro.`;
  return null;
}

/** "A description can't contain ---" (o --- fecharia o frontmatter no meio). */
export function validarDescricao(d: string): string | null {
  return d.includes('---') ? 'A descrição não pode conter ---' : null;
}

export function validarInstrucoes(i: string): string | null {
  return i.trim() ? null : 'Digite as instruções';
}

/** Monta o .md do estilo. `name`/`description`/`keep-coding-instructions` são as chaves que o CLI
 *  lê; `criado-por` é nosso (o CLI ignora chaves desconhecidas) — o "criador registrado" do catálogo. */
export function montarMd(d: EstiloDraft, criador: string): string {
  const desc = d.descricao.trim();
  return [
    '---',
    `name: ${d.nome.trim()}`,
    ...(desc ? [`description: ${desc}`] : []),
    `keep-coding-instructions: ${d.manterInstrucoesCodigo}`,
    `criado-por: ${criador}`,
    '---',
    '',
    d.instrucoes.trim(),
    '',
  ].join('\n');
}

// ---------- disco ----------

/** Estilos disponíveis: embutidos + os .md do catálogo. Nunca lança (catálogo ausente = só embutidos). */
export async function lerEstilos(dir = ESTILOS_DIR): Promise<Estilo[]> {
  const out: Estilo[] = ESTILOS_EMBUTIDOS.map(e => ({ ...e, builtin: true, criado_por: null }));
  let arquivos: string[] = [];
  try { arquivos = (await readdir(dir)).filter(f => f.endsWith('.md')).sort(); } catch { return out; }
  for (const f of arquivos) {
    let md = '';
    try { md = await readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const { fm } = parseFrontmatter(md);
    const nome = f.replace(/\.md$/, '');
    out.push({ nome, label: (fm.name ?? '').trim() || nome, descricao: (fm.description ?? '').trim(), builtin: false, criado_por: (fm['criado-por'] ?? '').trim() || null });
  }
  return out;
}

/** O estilo existe (embutido ou custom)? Usado pra validar o valor antes de persistir por sessão. */
export async function estiloConhecido(nome: string, dir = ESTILOS_DIR): Promise<boolean> {
  return (await lerEstilos(dir)).some(e => e.nome === nome);
}

/**
 * Grava o estilo no catálogo e garante o symlink em ~/.claude/output-styles/<slug>.md (é por ele
 * que o CLI resolve o nome). Um symlink antigo é refeito; um ARQUIVO de verdade no caminho do
 * usuário nunca é sobrescrito (pode ser um estilo pessoal criado fora do Orion).
 */
export async function gravarEstilo(slug: string, conteudo: string, deps?: { dir?: string; userDir?: string }): Promise<void> {
  const dir = deps?.dir ?? ESTILOS_DIR;
  const userDir = deps?.userDir ?? ESTILOS_USER_DIR;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), conteudo, 'utf8');
  await mkdir(userDir, { recursive: true });
  const alvo = path.join(userDir, `${slug}.md`);
  const st = await lstat(alvo).catch(() => null);
  if (st && !st.isSymbolicLink()) return; // arquivo real do usuário: não pisa
  if (st) await rm(alvo);
  await symlink(path.join(dir, `${slug}.md`), alvo);
}
