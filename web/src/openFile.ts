/**
 * Arquivo aberto na aba Arquivos, compartilhado com o OrionPanel (copilot): a aba Arquivos escreve
 * aqui ao abrir/trocar/fechar aba; o OrionPanel lê pra saber qual arquivo mandar como contexto pro
 * chat. Pub-sub simples (useSyncExternalStore) em vez de Context: os dois componentes já estão em
 * pontos bem distantes da árvore (App.tsx monta os dois como irmãos), um Context exigiria subir o
 * provider pra cima dos dois sem motivo real.
 */
export type OpenFileRef = { rootId: number; rel: string; name: string };

let current: OpenFileRef | null = null;
const listeners = new Set<() => void>();

export function setOpenFile(f: OpenFileRef | null) {
  current = f;
  for (const l of listeners) l();
}

export function getOpenFile(): OpenFileRef | null {
  return current;
}

export function subscribeOpenFile(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
