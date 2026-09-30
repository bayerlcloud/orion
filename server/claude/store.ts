import type { Pool } from 'pg';
import type { Store, SessionStatus, Decision } from './runner.js';

/** Persistência do runner no Postgres. Sequência por sessão calculada no INSERT. */
export function pgStore(pool: Pool): Store {
  return {
    async appendEvent(sessionId, type, payload) {
      await pool.query(
        `INSERT INTO claude_events (session_id, seq, type, payload)
         VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM claude_events WHERE session_id = $1), $2, $3)`,
        [sessionId, type, JSON.stringify(payload)]);
    },
    async updateSession(sessionId, patch) {
      const sets: string[] = ['updated_at = now()']; const vals: unknown[] = [sessionId]; let i = 2;
      const add = (col: string, v: unknown) => { sets.push(`${col} = $${i++}`); vals.push(v); };
      if (patch.status !== undefined) add('status', patch.status satisfies SessionStatus);
      if (patch.turns !== undefined) add('turns', patch.turns);
      // Tokens somam (cada turno é um query() novo com resume; o result traz só o uso daquele turno).
      if (patch.tokens) { sets.push(`input_tokens = input_tokens + $${i++}`, `output_tokens = output_tokens + $${i++}`); vals.push(patch.tokens.input, patch.tokens.output); }
      if (patch.lastError !== undefined) add('last_error', patch.lastError);
      if (patch.model !== undefined) add('model', patch.model);
      await pool.query(`UPDATE claude_sessions SET ${sets.join(', ')} WHERE id = $1`, vals);
    },
    async createApproval(a) {
      await pool.query('INSERT INTO claude_approvals (id, session_id, tool_name, input) VALUES ($1, $2, $3, $4)',
        [a.id, a.sessionId, a.toolName, JSON.stringify(a.input ?? {})]);
    },
    async decideApproval(id, decision: Decision, decidedBy) {
      await pool.query('UPDATE claude_approvals SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1', [id, decision, decidedBy]);
    },
  };
}
