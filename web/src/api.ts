export type User = { id: number; name: string; email: string; role: 'owner' | 'member' };

/**
 * Chamada à API. Só manda Content-Type JSON quando há corpo; POST vazio sem cabeçalho, senão o
 * Fastify devolve 400. `timeoutMs`: sem timeout aqui, uma rede travada deixava o `await` pendurado
 * pra sempre — no compositor do chat (Composer.tsx) isso prendia `sending` em `true` e o botão
 * Enviar ficava inativo até dar F5 (achado do Danilo, 06/11/2026).
 */
export async function api<T>(path: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && init.body !== null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, headers, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Tempo esgotado, tente de novo');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  // Celular que volta de muito tempo em segundo plano às vezes entrega um 200 com corpo cortado
  // (conexão morta pelo SO enquanto a aba estava congelada): sem isso, `.catch(() => ({}))` fabricava
  // um objeto vazio como se fosse sucesso de verdade, e o código seguinte quebrava tentando ler um
  // campo que nunca veio (ex.: `r.session.status`) — "algo travou na interface" só no mobile,
  // achado pelo Danilo em 10-11/11/2026 (ver /api/claude/client-error, log que apontou a causa).
  let data: unknown;
  try { data = await res.json(); }
  catch (e) {
    if (res.ok) throw new Error('Resposta incompleta do servidor, tente de novo');
    data = {}; // erro sem corpo JSON válido (ex.: 405 em texto puro) — vira `erro ${status}` abaixo.
  }
  if (!res.ok) throw new Error((data as any).error ?? (data as any).message ?? `erro ${res.status}`);
  return data as T;
}
