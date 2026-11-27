// Alertas da própria c3 (RSS do painel, swap, sessões gigantes, compactações, turnos cortados, quedas).
// Chamado pelo scripts/vpsRemoteSampler.ts no ciclo de 15 min. Limiares e cooldown são funções puras
// (testáveis); a coleta lê /proc, journalctl e o Postgres. O envio é injetado (enviar).
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { parseMeminfo, parsePidStatus } from "./parse.js";
import { getSetting, setSetting } from "../settings.js";

const sh = promisify(execFile);

// Limiares: ajuste aqui.
export const LIMITE_RSS_GB = 2.5;
export const LIMITE_SWAP_PCT = 60;
export const LIMITE_SESSAO_MB = 50;
export const LIMITE_COMPACTACOES = 10;
export const LIMITE_TURNOS_CORTADOS = 5;
export const LIMITE_QUEDAS = 0;
export const COOLDOWN_MS = 6 * 3600_000;

export type Sinais = {
  rssGb: number | null;
  swapPct: number | null;
  sessaoMb: { id: string; v: number } | null;
  compactacoes: { id: string; v: number } | null;
  turnosCortados: number | null;
  quedas: number | null;
};
export type Alerta = { chave: string; texto: string };

/** Transforma os sinais coletados nos alertas que passaram do limiar (null = não coletado, ignora). */
export function avaliarSinais(s: Sinais): Alerta[] {
  const a: Alerta[] = [];
  if (s.rssGb !== null && s.rssGb > LIMITE_RSS_GB)
    a.push({ chave: "rss", texto: `Painel do Orion usando ${s.rssGb.toFixed(1)} GB de RAM (limite ${LIMITE_RSS_GB} GB). Reiniciar o orion-central antes que caia.` });
  if (s.swapPct !== null && s.swapPct > LIMITE_SWAP_PCT)
    a.push({ chave: "swap", texto: `Swap da c3 em ${s.swapPct.toFixed(0)}% (limite ${LIMITE_SWAP_PCT}%). Ver quem está usando memória e reiniciar o que estiver inchado.` });
  if (s.sessaoMb && s.sessaoMb.v > LIMITE_SESSAO_MB)
    a.push({ chave: "sessao_grande", texto: `Sessão ${s.sessaoMb.id.slice(0, 8)} gravou ${s.sessaoMb.v} MB em 24 h (limite ${LIMITE_SESSAO_MB} MB). Abrir uma sessão nova para ela.` });
  if (s.compactacoes && s.compactacoes.v > LIMITE_COMPACTACOES)
    a.push({ chave: "compactacoes", texto: `Sessão ${s.compactacoes.id.slice(0, 8)} compactou ${s.compactacoes.v} vezes em 24 h (limite ${LIMITE_COMPACTACOES}). Encerrar e recomeçar a conversa.` });
  if (s.turnosCortados !== null && s.turnosCortados > LIMITE_TURNOS_CORTADOS)
    a.push({ chave: "turnos_cortados", texto: `${s.turnosCortados} turnos cortados por restart em 24 h (limite ${LIMITE_TURNOS_CORTADOS}). Evitar restarts e deploys em horário de uso.` });
  if (s.quedas !== null && s.quedas > LIMITE_QUEDAS)
    a.push({ chave: "quedas", texto: `orion-central caiu ${s.quedas} vez(es) em 24 h por heap/dump (limite ${LIMITE_QUEDAS}). Ver journalctl -u orion-central e o RSS do painel.` });
  return a;
}

/** Cooldown por chave: `ultimo` é o epoch ms do último envio (ou null/NaN). */
export function passouCooldown(ultimo: number | null, agora: number, cooldownMs = COOLDOWN_MS): boolean {
  return ultimo === null || agora - ultimo >= cooldownMs;
}

async function lerSinais(pool: Pool): Promise<Sinais> {
  const tenta = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
  const rssGb = await tenta(async () => {
    const { stdout } = await sh("systemctl", ["show", "-p", "MainPID", "--value", "orion-central"]);
    const rss = parsePidStatus(await readFile(`/proc/${stdout.trim()}/status`, "utf8"))?.vm_rss;
    return rss == null ? null : rss / 1024 ** 3;
  });
  const swapPct = await tenta(async () => {
    return parseMeminfo(await readFile("/proc/meminfo", "utf8"))?.swap_pct ?? null;
  });
  const sessaoMb = await tenta(async () => {
    const { rows } = await pool.query(
      `SELECT session_id AS id, (sum(pg_column_size(payload)) / 1048576)::int AS v FROM claude_events
       WHERE ts > now() - interval '24 hours' GROUP BY session_id ORDER BY sum(pg_column_size(payload)) DESC LIMIT 1`);
    return rows[0] ? { id: String(rows[0].id), v: Number(rows[0].v) } : null;
  });
  const compactacoes = await tenta(async () => {
    const { rows } = await pool.query(
      `SELECT session_id AS id, count(*)::int AS v FROM claude_events
       WHERE ts > now() - interval '24 hours' AND type = 'system' AND payload->>'subtype' = 'compact_boundary'
       GROUP BY session_id ORDER BY count(*) DESC LIMIT 1`);
    return rows[0] ? { id: String(rows[0].id), v: Number(rows[0].v) } : null;
  });
  const turnosCortados = await tenta(async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS v FROM claude_events
       WHERE ts > now() - interval '24 hours' AND type = 'user_prompt' AND payload->>'prompt' LIKE '[Orion] O servidor do Orion reiniciou%'`);
    return Number(rows[0].v);
  });
  const quedas = await tenta(async () => {
    // ponytail: -g filtra no journalctl (sem estourar buffer); só "Reached heap limit", 1 linha por queda e visível ao danilo.
    const { stdout } = await sh("journalctl", ["-u", "orion-central", "--since", "-24h", "-q", "--no-pager", "-g", "Reached heap limit"]);
    return stdout.split("\n").filter((l) => /Reached heap limit/.test(l)).length;
  });
  return { rssGb, swapPct, sessaoMb, compactacoes, turnosCortados, quedas };
}

/** Roda um ciclo: coleta, filtra por cooldown, envia e grava o horário só se o envio deu certo. Nunca lança. */
export async function alertarC3(pool: Pool, enviar: (texto: string) => Promise<boolean>, agora = Date.now()): Promise<void> {
  try {
    for (const a of avaliarSinais(await lerSinais(pool))) {
      const key = `c3_alerta_${a.chave}`;
      if (!passouCooldown(Number(await getSetting(pool, key)) || null, agora)) continue;
      if (await enviar(`⚠️ c3: ${a.texto}`)) await setSetting(pool, key, String(agora), null);
    }
  } catch (e: any) {
    console.log("c3: falha nos alertas:", e?.message ?? e);
  }
}
