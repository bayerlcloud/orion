import type { Pool } from 'pg';
import type { Store, SessionStatus, Decision } from './runner.js';

/** Persistência do runner no Postgres. Sequência por sessão calculada no INSERT. */
export function pgStore(pool: Pool): Store {
  // O SDK manda a lista inteira de comandos (`commands_changed`, ~350 KB) e um `init` a cada turno.
  // Gravar todas as cópias chegou a 95% do banco (30/09/2026). Grava a lista só quando ela muda e o
  // `init` só o primeiro de cada sessão (a tela só usa esse).
  const lastCmds = new Map<string, string>();
  const hasInit = new Set<string>();
  return {
    async appendEvent(sessionId, type, payload) {
      const sub = type === 'system' ? (payload as { subtype?: string } | null)?.subtype : undefined;
      if (sub === 'commands_changed') {
        const key = JSON.stringify((payload as { commands?: unknown }).commands ?? null);
        if (lastCmds.get(sessionId) === key) return;
        lastCmds.set(sessionId, key);
      } else if (sub === 'init') {
        if (hasInit.has(sessionId)) return;
        hasInit.add(sessionId);
        const { rowCount } = await pool.query(`SELECT 1 FROM claude_events WHERE session_id = $1 AND type = 'system' AND payload->>'subtype' = 'init' LIMIT 1`, [sessionId]);
        if (rowCount) return;
      }
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
