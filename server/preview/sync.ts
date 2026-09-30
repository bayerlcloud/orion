import { DOMINIO, type PreviewRow } from './model.js';

/**
 * Partes puras do `sync-previews` (scripts/sync-previews.ts): o bloco do Caddy de cada preview e a
 * conta de quais registros DNS faltam. Spec 2026-09-30-preview-design, Parte 1.
 */

export const IP_C3 = '217.76.55.249';

/**
 * Bloco do Caddy. Tudo dentro de `route` para valer a ordem escrita: `/__orion_auth` responde antes
 * do `forward_auth`. Matchers separados porque condições dentro de um mesmo matcher são E, não OU.
 */
export function blocoCaddy(p: PreviewRow): string {
  const pessoal = p.user_id !== null;
  const auth = pessoal ? `
		handle /__orion_auth {
			reverse_proxy 127.0.0.1:3000
		}
		forward_auth 127.0.0.1:3000 {
			uri /api/preview/check
		}` : '';
  return `${p.host} {
	@bloqueado path /@fs* */.env* */.git*
	@queryRuim expression \`{query}.contains("..") || {query}.contains("%2e") || {query}.contains("%2E")\`
	route {
		respond @bloqueado 404
		respond @queryRuim 404${auth}
		reverse_proxy 127.0.0.1:${p.port} {
			header_up Host "localhost"
			lb_try_duration 60s
			lb_try_interval 500ms
		}
	}
	handle_errors {
		respond "Preview ligando ou com erro. Recarregue em alguns segundos." 503
	}
}
`;
}

type RegistroZona = { name: string; type: string; records?: { content: string }[] };

/** Nomes relativos (sem o domínio) que precisam de registro A novo, e os que já têm A para outro IP. */
export function registrosFaltando(hosts: string[], zona: RegistroZona[]): { faltam: string[]; conflitos: string[] } {
  const faltam: string[] = [];
  const conflitos: string[] = [];
  for (const h of hosts) {
    const nome = h.slice(0, -(DOMINIO.length + 1));
    const a = zona.filter(r => r.name === nome && r.type === 'A');
    if (!a.length) faltam.push(nome);
    else if (!a.some(r => r.records?.some(x => x.content === IP_C3))) conflitos.push(nome);
  }
  return { faltam, conflitos };
}

/** Hosts que ganham bloco no Caddy: os que têm DNS em conflito (apontam para outra máquina) ficam de fora. */
export function hostsComBloco(hosts: string[], conflitos: string[]): string[] {
  const fora = new Set(conflitos.map(c => `${c}.${DOMINIO}`));
  return hosts.filter(h => !fora.has(h));
}
