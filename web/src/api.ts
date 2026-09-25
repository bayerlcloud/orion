export type User = { id: number; name: string; email: string; role: 'owner' | 'member' };

/** Chamada à API. Só manda Content-Type JSON quando há corpo; POST vazio sem cabeçalho, senão o Fastify devolve 400. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && init.body !== null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? (data as any).message ?? `erro ${res.status}`);
  return data as T;
}
