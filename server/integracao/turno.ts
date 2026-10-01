import path from 'node:path';
import { commitTurno, commitsAFrente, integrate, raizLimpa, sincronizarComBase } from '../tasks/git.js';
import type { FilaIntegracao } from './fila.js';
import type { TurnParams } from '../claude/runner.js';

/**
 * Integração automática a cada turno (spec 2026-09-30-preview-design, Parte 2). Só para sessões numa
 * worktree do projeto: no início do turno traz a base; no fim, commita e manda a branch para a raiz
 * pela fila do projeto. Conflito volta para a própria sessão resolver (até 3 vezes seguidas).
 */

const MAX_CONFLITOS = 3;
const ESPERAS_RAIZ_SUJA = 10;
const ESPERA_MS = 60_000;

// Conflitos seguidos por sessão; zera quando uma integração da sessão dá certo.
const tentativas = new Map<string, number>();
// Sessões já avisadas de uma falha que não é conflito; zera no próximo sucesso (não repete o aviso a cada turno).
const falhaAvisada = new Set<string>();
export function _zerarTentativas(): void { tentativas.clear(); falhaAvisada.clear(); }

type Projeto = { id: number; path: string; default_branch: string };
type Opcoes = {
  sessaoId: string; cwd: string; projeto: Projeto | null; prompt: string;
  avisar: (texto: string) => void; fila: FilaIntegracao; esperar?: (ms: number) => Promise<void>;
  /** Nota na sessão sem abrir turno (sucesso). */
  registrar?: (texto: string) => void;
  integrar?: typeof integrate;
};

const esperarPadrao = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function arquivosEmConflito(log: string): string {
  const nomes = [...log.matchAll(/Merge conflict in (.+)/g)].map(m => m[1].trim());
  return [...new Set(nomes)].join(', ') || 'arquivos do projeto';
}

export function ganchosDaSessao(o: Opcoes): TurnParams['ganchos'] | undefined {
  const { projeto } = o;
  if (!projeto || path.resolve(o.cwd) === path.resolve(projeto.path)) return undefined;
  const base = projeto.default_branch || 'main';
  const esperar = o.esperar ?? esperarPadrao;

  async function integrarNaRaiz(branch: string): Promise<void> {
    for (let i = 0; !(await raizLimpa(projeto!.path)); i++) {
      if (i >= ESPERAS_RAIZ_SUJA) {
        o.avisar('A pasta raiz do projeto tem edição direta não enviada, e sua mudança não pôde entrar. Avise a pessoa, em uma linha, que alguém precisa enviar ou descartar o que está na raiz.');
        return;
      }
      await esperar(ESPERA_MS);
    }
    const r = await (o.integrar ?? integrate)(projeto!.path, branch, base);
    if (r.ok) {
      tentativas.delete(o.sessaoId); falhaAvisada.delete(o.sessaoId);
      o.registrar?.(`Mudança enviada para a raiz (branch ${branch}).`);
      return;
    }
    if (!r.conflict) {
      if (falhaAvisada.has(o.sessaoId)) return;
      falhaAvisada.add(o.sessaoId);
      o.avisar(`Não consegui juntar sua mudança na raiz, e não foi conflito. Últimas linhas do git: ${r.log.slice(-400)}. Explique para a pessoa em poucas linhas; eu tento de novo no fim do próximo turno.`);
      return;
    }
    const n = (tentativas.get(o.sessaoId) ?? 0) + 1;
    tentativas.set(o.sessaoId, n);
    const arquivos = arquivosEmConflito(r.log);
    if (n < MAX_CONFLITOS) {
      o.avisar(`Conflito ao juntar sua mudança na raiz (${arquivos}). Rode git merge ${base} nesta pasta, junte as duas mudanças mantendo a intenção de cada uma, e termine o turno. Não descarte a mudança de ninguém.`);
    } else if (n === MAX_CONFLITOS) {
      o.avisar(`Não consegui juntar sua mudança na raiz depois de 3 tentativas (${arquivos}). Pare de tentar e explique o conflito para a pessoa, em poucas linhas.`);
    }
  }

  /** Antes de publicar de dentro da worktree: commita e junta na raiz já, pela fila. null = ok; senão o motivo. */
  async function juntarAgora(): Promise<string | null> {
    const c = await commitTurno(o.cwd, o.prompt);
    if (!c.branch || c.branch === 'HEAD' || c.branch === base) return `a worktree não está numa branch própria (${c.branch ?? 'sem branch'})`;
    if ((await commitsAFrente(o.cwd, base)) === 0) return null;
    return o.fila.enfileirar(projeto!.id, async () => {
      if (!(await raizLimpa(projeto!.path))) return 'a pasta raiz do projeto tem edição direta não enviada; alguém precisa enviar ou descartar antes';
      const r = await (o.integrar ?? integrate)(projeto!.path, c.branch!, base);
      if (r.ok) { o.registrar?.(`Mudança enviada para a raiz antes de publicar (branch ${c.branch}).`); return null; }
      return r.conflict
        ? `conflito ao juntar na raiz (${arquivosEmConflito(r.log)}); rode git merge ${base} nesta pasta, resolva mantendo as duas mudanças e tente publicar de novo`
        : `o git falhou ao juntar na raiz: ${r.log.slice(-300)}`;
    });
  }

  return {
    publicar: { raiz: projeto.path, juntar: juntarAgora },
    antes: async () => { await sincronizarComBase(o.cwd, base); },
    depois: async () => {
      const c = await commitTurno(o.cwd, o.prompt);
      if (!c.branch || c.branch === 'HEAD' || c.branch === base) return;
      if (!c.commitou && (await commitsAFrente(o.cwd, base)) === 0) return;
      void o.fila.enfileirar(projeto.id, () => integrarNaRaiz(c.branch!)).catch(() => {});
    },
  };
}
