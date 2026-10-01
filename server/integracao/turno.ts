import { execFile } from 'node:child_process';
import { access, symlink } from 'node:fs/promises';
import path from 'node:path';
import { commitTurno, commitsAFrente, integrate, raizLimpa, runTests, sincronizarComBase } from '../tasks/git.js';
import { escreverPedido } from '../deploy/estado.js';
import type { FilaIntegracao } from './fila.js';

/**
 * Worktree por pessoa, publicação por comando (Danilo, 01/10/2026; substitui a junção automática a
 * cada turno da spec 2026-09-30-preview-design, Parte 2). Só para sessões numa worktree do projeto:
 * - início do turno: traz a raiz para a worktree (trabalha sempre sobre o que já foi publicado);
 * - fim do turno: só commita na worktree (nada sobe sozinho);
 * - "publica": commit, traz a raiz, testes, junta na raiz (o preview <projeto>.bayerl.cloud mostra);
 * - "deploy": publica, manda a raiz para o GitHub e roda o deploy.sh da raiz (Orion: pedido.json).
 */

/** O próprio Orion publica pela fila do systemd (pedido.json), não por deploy.sh. */
export const ORION_RAIZ = '/srv/orion';
const DEPLOY_TIMEOUT = 15 * 60_000;

export type Resultado = { ok: boolean; texto: string };
export type Publicador = { raiz: string; publicar: () => Promise<Resultado>; deploy: () => Promise<Resultado> };
export type Ganchos = { antes: () => Promise<void>; depois: () => Promise<void>; publicador: Publicador };

type Projeto = { id: number; path: string; default_branch: string };
type Rodar = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; out: string }>;
type Opcoes = {
  cwd: string; projeto: Projeto | null; prompt: string; fila: FilaIntegracao;
  /** Quem pediu (vai no pedido de publicação do Orion). */
  pessoa?: string;
  /** Nota na sessão sem abrir turno. */
  registrar?: (texto: string) => void;
  integrar?: typeof integrate;
  rodar?: Rodar;
  pedirOrion?: (por: string) => Promise<void>;
};

const rodarPadrao: Rodar = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: DEPLOY_TIMEOUT, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` }));
});

const fim = (t: string, n = 1500) => t.trim().slice(-n);

function arquivosEmConflito(log: string): string {
  const nomes = [...log.matchAll(/(?:Merge conflict in|CONFLICT \([^)]*\): .* in) (.+)/g)].map(m => m[1].trim());
  return [...new Set(nomes)].join(', ') || 'arquivos do projeto';
}

const existe = (p: string) => access(p).then(() => true, () => false);

export function ganchosDaSessao(o: Opcoes): Ganchos | undefined {
  const { projeto } = o;
  if (!projeto || path.resolve(o.cwd) === path.resolve(projeto.path)) return undefined;
  const raiz = projeto.path;
  const base = projeto.default_branch || 'main';
  const integrar = o.integrar ?? integrate;
  const rodar = o.rodar ?? rodarPadrao;

  async function publicar(): Promise<Resultado> {
    const c = await commitTurno(o.cwd, o.prompt);
    if (!c.branch || c.branch === 'HEAD' || c.branch === base) return { ok: false, texto: `a worktree não está numa branch própria (${c.branch ?? 'sem branch'}); nada subiu.` };
    // Commit que falhou com a worktree suja era engolido e virava "nada novo para subir" (01/10/2026): agora é erro.
    if (c.sujo && !c.commitou) return { ok: false, texto: `o commit na worktree falhou; nada subiu. git: ${fim(c.log, 500)}` };
    const s = await sincronizarComBase(o.cwd, base);
    if (!s.ok) return { ok: false, texto: s.conflito
      ? `conflito com a raiz (${arquivosEmConflito(s.log)}); nada subiu. Rode git merge ${base} nesta pasta, junte mantendo as duas mudanças, faça o commit e publique de novo.`
      : `não consegui trazer a raiz para a worktree; nada subiu. git: ${fim(s.log, 400)}` };
    if ((await commitsAFrente(o.cwd, base)) === 0) return { ok: true, texto: 'nada novo para subir: a raiz já tem tudo desta worktree.' };
    // Worktree nasce sem node_modules; os testes usam o da raiz (commitTurno nunca commita o symlink).
    if (!(await existe(path.join(o.cwd, 'node_modules'))) && (await existe(path.join(raiz, 'node_modules'))))
      await symlink(path.join(raiz, 'node_modules'), path.join(o.cwd, 'node_modules')).catch(() => {});
    const t = await runTests(o.cwd);
    if (!t.ok) return { ok: false, texto: `os testes falharam; nada subiu.\n${fim(t.tail)}` };
    return o.fila.enfileirar(projeto!.id, async (): Promise<Resultado> => {
      if (!(await raizLimpa(raiz))) return { ok: false, texto: 'a pasta raiz tem edição direta não enviada; nada subiu. Alguém precisa enviar ou descartar o que está na raiz.' };
      const r = await integrar(raiz, c.branch!, base);
      if (r.ok) { o.registrar?.(`Publicado na raiz (branch ${c.branch}).`); return { ok: true, texto: `subiu para a raiz (${base}).` }; }
      return { ok: false, texto: r.conflict
        ? `alguém publicou na raiz agora e deu conflito (${arquivosEmConflito(r.log)}); nada subiu. Rode git merge ${base} nesta pasta, resolva e publique de novo.`
        : `o git falhou ao juntar na raiz; nada subiu. ${fim(r.log, 400)}` };
    });
  }

  async function deploy(): Promise<Resultado> {
    const p = await publicar();
    if (!p.ok) return { ok: false, texto: `Deploy cancelado: ${p.texto}` };
    if (path.resolve(raiz) === ORION_RAIZ) {
      await (o.pedirOrion ?? ((por) => escreverPedido('main', por)))(`${o.pessoa ?? 'alguém'} (via Claude)`);
      return { ok: true, texto: `${p.texto} Pedido de publicação do Orion na fila: acompanhe /srv/builds/status.json (o Orion reinicia no fim e a sessão é retomada com o resultado).` };
    }
    // ponytail: deploy dentro da fila do projeto segura as publicações do projeto até acabar (1 a 2 min); fila separada se incomodar.
    return o.fila.enfileirar(projeto!.id, async (): Promise<Resultado> => {
      if (!(await raizLimpa(raiz))) return { ok: false, texto: `${p.texto} Deploy cancelado: a raiz tem edição direta não enviada.` };
      if (!(await existe(path.join(raiz, 'deploy.sh')))) return { ok: false, texto: `${p.texto} Deploy cancelado: o projeto não tem deploy.sh na raiz.` };
      const remoto = await rodar('git', ['remote'], raiz);
      let git = 'sem GitHub configurado (sem remote origin).';
      if (/^origin$/m.test(remoto.out)) {
        const push = await rodar('git', ['push', 'origin', base], raiz);
        if (push.code !== 0) return { ok: false, texto: `${p.texto} Deploy cancelado: o push para o GitHub falhou.\n${fim(push.out, 600)}` };
        git = `GitHub atualizado (origin ${base}).`;
      }
      const d = await rodar('bash', ['./deploy.sh'], raiz);
      if (d.code !== 0) return { ok: false, texto: `${p.texto} ${git} O deploy.sh FALHOU (exit ${d.code}); produção segue com a versão anterior.\n${fim(d.out)}` };
      o.registrar?.('Deploy feito a partir da raiz.');
      return { ok: true, texto: `${p.texto} ${git} Deploy feito.\n${fim(d.out, 800)}` };
    });
  }

  return {
    antes: async () => { await sincronizarComBase(o.cwd, base); },
    depois: async () => { await commitTurno(o.cwd, o.prompt); },
    publicador: { raiz, publicar, deploy },
  };
}
