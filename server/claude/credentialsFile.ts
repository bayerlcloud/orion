import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Onde o `claude` CLI guarda a sessão de login interativo (`claude auth login`), diferente do
 * token estático de `claude setup-token` (esse fica só no Postgres, via server/settings.ts). */
export function credentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export type ClaudeCredentials = { accessToken: string; refreshToken?: string; expiresAt?: number };

/** Lê e valida a estrutura `claudeAiOauth` do arquivo de credenciais do CLI. null se ausente/inválido —
 * nunca lança, quem chama decide o que fazer na ausência (ex.: cair para o token manual). */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf8');
    const d = JSON.parse(raw);
    const oauth = d?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt };
  } catch {
    return null;
  }
}
