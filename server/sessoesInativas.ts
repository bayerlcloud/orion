/**
 * Arquivamento automático de sessões paradas (orion-arquivar-sessoes.timer, diário). Sessão cuja
 * conversa (arquivo .jsonl do Claude Code CLI) não é tocada há dias acaba limpa pelo próprio CLI
 * (cleanupPeriodDays padrão 30); retomar depois disso falha com "No conversation found with
 * session ID" (error_during_execution). Arquivar antes disso tira a sessão morta da lista sem
 * apagar histórico (claude_events continua; só claude_sessions.archived vira true).
 */

export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export const DIAS_PADRAO = 30;

/** Arquiva (e desafixa) sessões não arquivadas, não fixadas, paradas há mais de `dias`. Devolve quantas. */
export async function arquivarSessoesPassadas(pool: PoolLike, dias = DIAS_PADRAO): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE claude_sessions SET archived = true, pinned = false
     WHERE archived IS NOT TRUE AND pinned IS NOT TRUE
       AND updated_at < now() - ($1 || ' days')::interval`,
    [dias],
  );
  return rowCount ?? 0;
}
