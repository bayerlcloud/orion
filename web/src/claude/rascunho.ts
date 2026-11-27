import type { Attachment } from './api';

/**
 * Rascunho do compositor (Composer.tsx) em três camadas, da mais volátil pra mais durável:
 * memória (troca de aba dentro da página), localStorage deste navegador (última linha: 401,
 * fechar/recarregar a página antes do autosave, salvamento que falhou) e servidor (fonte entre
 * aparelhos). `salvo` = o servidor já tem exatamente este conteúdo; sem isso, o local manda.
 * Decisões aqui são puras pra ter teste (tests/rascunho.test.ts).
 */
export type Rascunho = { text: string; attachments: Attachment[] };
export type RascunhoLocal = Rascunho & { salvo: boolean };
export type ArmazemRascunho = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Mesmo limite do servidor (PUT /api/claude/drafts/:id corta em 200k). */
export const RASCUNHO_TEXTO_MAX = 200_000;

// ponytail: aba nova usa o id `draft-N` do contador da página, que zera a cada F5: depois de um 401 o
// texto volta na N-ésima aba nova aberta de novo. Chave estável por aba nova exigiria id vindo do ClaudePage.
export function chaveRascunho(sessionId: string): string {
  return `orion.rascunho.${sessionId}`;
}

export function rascunhoVazio(r: Rascunho | undefined): boolean {
  return !r || (!r.text && r.attachments.length === 0);
}

/** Identidade do conteúdo pra não salvar a mesma coisa duas vezes (texto + caminhos dos anexos). */
export function chaveConteudo(r: Rascunho | undefined): string {
  return JSON.stringify([r?.text ?? '', (r?.attachments ?? []).map(a => a.path)]);
}

/**
 * Qual rascunho vale ao abrir uma sessão sem nada em memória: o local que não chegou a subir
 * (ninguém mais poderia ter algo mais novo que o que a pessoa digitou aqui e perdeu); senão o do
 * servidor, que pode ter sido editado em outro aparelho depois. Local já sincronizado e servidor
 * vazio = foi enviado ou apagado em outro lugar, não volta.
 */
export function rascunhoMaisNovo(local: RascunhoLocal | undefined, servidor: Rascunho | undefined): RascunhoLocal | undefined {
  if (local && !local.salvo && !rascunhoVazio(local)) return local;
  if (!rascunhoVazio(servidor)) return { ...servidor!, salvo: true };
  return undefined;
}

/** Lê o rascunho local de uma sessão. Qualquer problema (sem storage, JSON inválido, formato velho) vira 'não tem'. */
export function lerRascunhoLocal(armazem: ArmazemRascunho | undefined, sessionId: string): RascunhoLocal | undefined {
  try {
    const raw = armazem?.getItem(chaveRascunho(sessionId));
    if (!raw) return undefined;
    const r = JSON.parse(raw) as Partial<RascunhoLocal>;
    if (typeof r !== 'object' || r === null || typeof r.text !== 'string') return undefined;
    const attachments = (Array.isArray(r.attachments) ? r.attachments : []).filter((a): a is Attachment => !!a && typeof a.path === 'string' && typeof a.name === 'string');
    const local = { text: r.text, attachments, salvo: r.salvo === true };
    return rascunhoVazio(local) ? undefined : local;
  } catch { return undefined; }
}

/** Grava (ou apaga, se vazio) o rascunho local. Nunca lança: sem storage ou cota cheia, só não guarda. */
export function gravarRascunhoLocal(armazem: ArmazemRascunho | undefined, sessionId: string, r: RascunhoLocal): void {
  try {
    const chave = chaveRascunho(sessionId);
    if (rascunhoVazio(r)) { armazem?.removeItem(chave); return; }
    armazem?.setItem(chave, JSON.stringify({ text: r.text.slice(0, RASCUNHO_TEXTO_MAX), attachments: r.attachments, salvo: r.salvo }));
  } catch { /* localStorage indisponível ou cheio */ }
}
