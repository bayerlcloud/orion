import path from 'node:path';
import { access } from 'node:fs/promises';
import { addWorktreeExistente, branchAtual, branchExiste, createWorktree as gitCreateWorktree, semPendencias } from '../tasks/git.js';
import { isSafeBranch } from '../tasks/util.js';

// "Aba Claude" — criar/gerenciar git worktree direto pela UI do chat (ver PARIDADE.md seção 14).
// Reusa a camada de git do Kanban de Tarefas (`server/tasks/git.ts`, sempre execFile — nunca shell)
// em vez de duplicar a chamada a `git worktree add`; só o cálculo de nome/branch/path é próprio
// daqui, porque o Kanban amarra isso a um `taskId` numérico e este fluxo nasce de um nome digitado
// livremente pelo usuário no compositor (mais perto do `createWorktree($)` da extensão real).

const NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Valida o nome digitado pra um novo worktree — MESMA regra da extensão real (função `fF0` no
 * webview decompilado v2.1.283, `/srv/orion-reference-2.1.283/webview/index.js`; ver PARIDADE.md
 * seção 14): só letras/números/ponto/hífen/sublinhado, até 64 caracteres, nunca "." nem ".." nem
 * contendo "..", nunca termina em "." nem ".lock", nunca é ".git" (mesmo com pontos finais ou
 * maiúsculas — a extensão real compara em minúsculas e sem pontos finais). Mensagens traduzidas pro
 * padrão PT-BR do resto do Orion. Duplicada (de propósito, nunca importada) em
 * `web/src/claude/mapper.ts` pro lado cliente validar ao vivo enquanto o usuário digita — esta função
 * aqui é sempre a autoridade final: o servidor nunca confia no que o cliente já validou.
 */
export function validateWorktreeName(name: string): string | null {
  if (!name) return 'nome é obrigatório';
  if (name.length > 64) return 'nome deve ter até 64 caracteres';
  if (!NAME_RE.test(name)) return 'use só letras, números, pontos, hífens e sublinhados';
  if (name === '.' || name === '..' || name.includes('..')) return 'nome não pode ser "." nem ".." nem conter ".."';
  if (name.endsWith('.') || name.endsWith('.lock')) return 'nome não pode terminar em "." nem ".lock"';
  if (name.toLowerCase().replace(/\.+$/, '') === '.git') return 'nome não pode ser ".git"';
  return null;
}

/**
 * Diretório-base dos worktrees de um projeto: pasta IRMÃ `<repo>-worktrees` — mesma convenção que
 * humanos e outros agentes já usam manualmente neste servidor pra este mesmo repo Orion (ex.
 * `/srv/orion-worktrees/<nome>`, a partir de `/srv/orion` — 4 dos 7 worktrees vivos em c3 no momento
 * desta implementação seguem exatamente esse padrão; os outros 3 vêm do Kanban de Tarefas, que usa
 * `$WORKTREES_DIR`/`/srv/worktrees/<slug>/<id>`, uma convenção numérica própria daquele fluxo — ver
 * PARIDADE.md seção 14 pra decisão de escopo completa). Generalizada aqui pra qualquer projeto
 * multi-repo do Orion (`/srv/projects/<slug>` → `/srv/projects/<slug>-worktrees/<nome>`), não só o
 * próprio Orion.
 */
export function worktreesBaseDir(projectPath: string): string {
  return projectPath.replace(/[/\\]+$/, '') + '-worktrees';
}

export type WorktreeCreateResult = { ok: true; path: string; branch: string } | { ok: false; error: string };

/**
 * Cria um worktree git novo pra `name` dentro do projeto em `projectPath`, numa branch nova
 * `feature/<name>` a partir de `baseBranch` — mesma convenção de branch pedida (equivalente ao que
 * humanos/agentes já usam em `/srv/orion-worktrees`, ex. `feature/agent-map`). Reusa `createWorktree`
 * de `server/tasks/git.ts` (execFile, nunca shell, timeout curto) só passando o path calculado por
 * `worktreesBaseDir` — nunca refaz a chamada ao git por conta própria. Nome inválido nunca chega a
 * tocar disco/git (curto-circuita em `validateWorktreeName`).
 */
export async function createWorktreeForProject(
  projectPath: string,
  name: string,
  baseBranch: string,
): Promise<WorktreeCreateResult> {
  const nameError = validateWorktreeName(name);
  if (nameError) return { ok: false, error: nameError };
  const branch = `feature/${name}`;
  if (!isSafeBranch(branch)) return { ok: false, error: 'nome de branch inválido' };
  const target = path.join(worktreesBaseDir(projectPath), name);
  const r = await gitCreateWorktree(projectPath, branch, baseBranch, target);
  if (!r.ok || !r.path) return { ok: false, error: r.log || 'falha ao criar o worktree' };
  return { ok: true, path: r.path, branch };
}

export type WorktreeUsuario = { ok: true; path: string; branch: string } | { ok: false; motivo: string };

/**
 * Worktree fixa da pessoa no projeto (decisão 01/10/2026): `<projeto>-worktrees/<pessoa>`, branch
 * `usuario/<pessoa>` saída da branch atual da raiz. Toda sessão da pessoa no projeto roda nela, o
 * preview do usuário mostra ela, e cada turno sobe para a raiz pela integração automática.
 * Só cria com a raiz limpa e numa branch: raiz com edição sem commit esconderia esse trabalho
 * da worktree, então aí a sessão fica na raiz (como antes) e o motivo volta para avisar.
 */
export async function worktreeDoUsuario(projectPath: string, pessoa: string): Promise<WorktreeUsuario> {
  const target = path.join(worktreesBaseDir(projectPath), pessoa);
  const branch = `usuario/${pessoa}`;
  if (await access(path.join(target, '.git')).then(() => true, () => false)) return { ok: true, path: target, branch };
  const base = await branchAtual(projectPath);
  if (!base) return { ok: false, motivo: 'a pasta do projeto não é um repositório git numa branch' };
  if (!(await semPendencias(projectPath))) return { ok: false, motivo: `a raiz do projeto tem mudanças ou arquivos novos sem commit na branch ${base}` };
  const r = (await branchExiste(projectPath, branch))
    ? await addWorktreeExistente(projectPath, branch, target)
    : await gitCreateWorktree(projectPath, branch, base, target);
  return r.ok && r.path ? { ok: true, path: r.path, branch } : { ok: false, motivo: r.log || 'falha ao criar a worktree' };
}
