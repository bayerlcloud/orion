/**
 * Retomada automática de turnos cortados (restart do serviço) e vigia de turnos que caíram com erro.
 * Veio inteiro de routes/claude.ts (plano B1, T2): precisa do Runner de verdade, então roda onde o motor
 * está hospedado (hospedarMotor), não no painel. Em modo socket o painel não retoma nada; quem retoma é o
 * orion-runner no boot dele.
 */
import type { Pool } from 'pg';
import type { Motor } from './motor.js';
import type { Store } from './runner.js';
import { prefixPrompt } from './header.js';
import { lerStatus, tailDoLog, type Status } from '../deploy/estado.js';

export const RESUME_PROMPT = 'O servidor do Orion reiniciou no meio do seu turno (deploy ou queda) e ele foi cortado. Continue de onde parou. Se o reinício foi causado por você mesmo (ex.: systemctl restart orion-central), ele já aconteceu com sucesso: não reinicie de novo, só confira o resultado e siga.';

/** Início do aviso de publicação que deu certo. A Timeline procura este trecho (web/src/claude/mapper.ts,
 * DEPLOY_OK_MARCA) pra mostrar a ferramenta cortada como "interrompida pela publicação", não como erro. */
export const DEPLOY_OK_MARCA = 'Publicação do Orion: deu certo';

/**
 * O que a retomada conta sobre a publicação que causou o reinício. Só fala de build terminado há menos
 * de 10 min (ou ainda rodando); reinício por queda, sem deploy recente, não ganha nota nenhuma.
 */
export function notaDeploy(st: Status | null, now: Date, fimDoLog = ''): string {
  if (!st) return '';
  if (st.estado === 'fila' || st.estado === 'rodando') return `\n\nPublicação do Orion ainda em andamento (${st.etapa}). Confira /srv/builds/status.json antes de seguir.`;
  const fim = st.fim ? Date.parse(st.fim) : NaN;
  if (!Number.isFinite(fim) || now.getTime() - fim > 10 * 60_000) return '';
  if (st.estado === 'ok') return `\n\n${DEPLOY_OK_MARCA} (build ${st.nome}, commit ${st.sha} "${st.msg}"). Já está no ar: não espere nem publique de novo.`;
  return `\n\nPublicação do Orion FALHOU (${st.etapa}); a versão anterior (${st.anterior}) segue no ar. Log: ${st.log}${fimDoLog ? `\nFim do log:\n\`\`\`\n${fimDoLog}\n\`\`\`` : ''}`;
}

/** Mensagem gravada como evento 'error' (e last_error) quando o Orion desiste de retomar sozinho; a Timeline
 * casa o trecho "não retomado automaticamente" pra oferecer o botão "Continuar de onde parou". */
export const NAO_RETOMADA = `Turno cortado e não retomado automaticamente: já foram 3 retomadas seguidas sem uma mensagem de gente no meio (proteção contra loop). Clique em "Continuar de onde parou" ou mande uma mensagem.`;

/** Prompt do vigia quando o turno caiu com erro (SDK/API), sem reinício do servidor. */
export const VIGIA_PROMPT = (erro: string) => `O seu turno anterior caiu com erro: "${erro.slice(0, 300)}". Continue de onde parou. Se o erro se repetir igual, pare e explique o que está travando.`;

/** Retomada automática = prompt do Orion com "Continue de onde parou" (retomada pós-restart ou vigia). */
const ehRetomadaAuto = (prompt: string) => prompt.startsWith('[Orion] ') && prompt.includes('Continue de onde parou');

/**
 * Retoma sozinho? Sim, até 3 retomadas automáticas seguidas (nos últimos 30 min, sem mensagem de gente
 * no meio). Antes era "não retoma se a última retomada tem menos de 10 min", o que travava a sessão que
 * publica duas vezes em seguida (deploy ok não é loop). `recentes`: últimos user_prompt, mais novo primeiro.
 */
export function shouldResume(recentes: { prompt: string; ts: Date }[], now: Date): boolean {
  let seguidas = 0;
  for (const r of recentes) {
    if (!ehRetomadaAuto(r.prompt) || now.getTime() - r.ts.getTime() > 30 * 60_000) break;
    seguidas++;
  }
  return seguidas < 3;
}

// Colunas que a retomada precisa + os últimos prompts (pra contar retomadas automáticas seguidas).
export const SESSAO_RETOMAVEL = `SELECT s.id, s.cwd, s.model, s.permission_mode, s.effort, s.output_style, s.project_id, s.user_id, s.last_error,
            p.name AS project_name, p.rules, u.name AS creator,
            (SELECT coalesce(json_agg(json_build_object('prompt', x.prompt, 'ts', x.ts)), '[]') FROM
               (SELECT e.payload->>'prompt' AS prompt, e.ts FROM claude_events e WHERE e.session_id = s.id AND e.type = 'user_prompt' ORDER BY e.seq DESC LIMIT 5) x) AS recentes
       FROM claude_sessions s LEFT JOIN projects p ON p.id = s.project_id JOIN users u ON u.id = s.user_id`;

const MODOS = new Set(['default', 'acceptEdits', 'plan', 'auto']);

export type SessaoRetomavel = {
  id: string; user_id: number; permission_mode: string | null; model: string | null; effort: string | null; last_error: string | null;
  recentes?: { prompt: string | null; ts: string }[];
};

export type DepsRetomada = { pool: Pool; motor: Motor; store: Store; log: (m: string) => void };

/** Retoma a sessão com um prompt do Orion, ou desiste (evento 'error' visível + botão Continuar) depois de 3 seguidas. */
export async function retomar(d: DepsRetomada, s: SessaoRetomavel, prompt: string): Promise<void> {
  if (!shouldResume((s.recentes ?? []).map(r => ({ prompt: r.prompt ?? '', ts: new Date(r.ts) })), new Date())) {
    await d.store.appendEvent(s.id, 'error', { message: NAO_RETOMADA }).catch(() => {});
    await d.pool.query("UPDATE claude_sessions SET status = 'error', last_error = $2 WHERE id = $1", [s.id, NAO_RETOMADA]).catch(() => {});
    return;
  }
  const mode = (MODOS.has(s.permission_mode ?? '') ? s.permission_mode : 'acceptEdits') as 'default' | 'acceptEdits' | 'plan' | 'auto';
  await d.motor.iniciarTurno({ sessionId: s.id, userId: s.user_id, prompt: prefixPrompt('Orion', prompt), mode, model: s.model ?? undefined, effort: s.effort ?? undefined, isNew: false });
}

/**
 * Retomada no boot + vigia. Devolve `fechar()` que desliga o vigia (onClose do painel, ou fim do runner).
 * Roda uma vez por processo que hospeda o motor.
 */
export async function iniciarRetomada(d: DepsRetomada): Promise<{ fechar(): void }> {
  const { pool, motor, log } = d;
  // Turnos cortados por restart do servidor (deploy, crash): nada roda em memória depois do boot,
  // então retoma cada sessão que estava 'running'/'waiting' com um "continue" em nome do Orion, pra
  // ninguém precisar voltar lá e cutucar. O SDK retoma a conversa pelo id (resume).
  const { rows: cortadas } = await pool.query<SessaoRetomavel>(`${SESSAO_RETOMAVEL} WHERE s.status IN ('running','waiting')`).catch(() => ({ rows: [] as SessaoRetomavel[] }));
  await pool.query("UPDATE claude_sessions SET status = 'idle' WHERE status IN ('running','waiting')").catch(() => {});
  // Fora do await do boot: ele não pode travar (o build.sh espera o /api/health responder). Se o
  // reinício veio de um deploy, o status.json ainda diz 'rodando' (o build só fecha 'ok' depois do health):
  // espera até 3 min o resultado final pra retomada já contar se deu certo. Se este processo morrer antes
  // (health falhou, rollback), quem retoma é o próximo boot, que verá o 'falhou'.
  if (cortadas.length) void (async () => {
    let st = await lerStatus().catch(() => null);
    for (let i = 0; i < 90 && (st?.estado === 'fila' || st?.estado === 'rodando'); i++) {
      await new Promise(r => setTimeout(r, 2000));
      st = await lerStatus().catch(() => null);
    }
    const nota = notaDeploy(st, new Date(), st?.estado === 'falhou' && st.log ? await tailDoLog(st.log, 30) : '');
    for (const s of cortadas) {
      // Enquanto o boot esperava o deploy terminar, o vigia (2 min) pode já ter retomado esta sessão: se ela está em
      // turno ou já ganhou um result depois do corte, retomar de novo duplica o turno (27/11/2026: duas retomadas
      // na mesma sessão colidiram no seq e derrubaram o painel).
      if (motor.status(s.id) === 'running' || motor.status(s.id) === 'waiting') { log(`retomada: sessão ${s.id} já está em turno, pulando`); continue; }
      const { rows: [ult] } = await pool.query<{ type: string }>(`SELECT type FROM claude_events WHERE session_id = $1 AND type IN ('error','interrupted','result','user_prompt') ORDER BY seq DESC LIMIT 1`, [s.id]).catch(() => ({ rows: [] as { type: string }[] }));
      if (ult?.type === 'result') { log(`retomada: sessão ${s.id} já concluiu um turno depois do corte, pulando`); continue; }
      if (motor.status(s.id) !== 'idle') continue; // alguém mandou mensagem enquanto esperávamos o deploy
      log(`retomando sessão ${s.id} cortada por restart`);
      void retomar(d, s, RESUME_PROMPT + nota).catch(e => log(`retomada de ${s.id} falhou: ${(e as Error).message}`));
    }
  })();

  // Vigia: turno que caiu com erro do SDK/API (sem reinício) fica parado em 'error' até alguém cutucar.
  // A cada 2 min, retoma quem caiu há 1-30 min com evento 'error' (nunca 'interrupted' = Parar manual,
  // nem result com erro = orçamento/limite de turnos, que param de propósito). Mesmo limite de 3 seguidas.
  // ponytail: varredura por intervalo; vira evento do runner quando o motor sair pro processo próprio.
  const vigia = setInterval(() => void (async () => {
    const { rows } = await pool.query<SessaoRetomavel>(`${SESSAO_RETOMAVEL}
      WHERE s.status = 'error' AND s.archived IS NOT TRUE AND s.last_error IS DISTINCT FROM $1
        AND s.updated_at BETWEEN now() - interval '30 minutes' AND now() - interval '1 minute'
        AND (SELECT e.type FROM claude_events e WHERE e.session_id = s.id AND e.type IN ('error','interrupted','result','user_prompt') ORDER BY e.seq DESC LIMIT 1) = 'error'`, [NAO_RETOMADA]);
    for (const s of rows) {
      if (motor.status(s.id) === 'running' || motor.status(s.id) === 'waiting') continue;
      log(`vigia: retomando sessão ${s.id} que caiu com erro`);
      await retomar(d, s, VIGIA_PROMPT(s.last_error ?? 'erro'));
    }
  })().catch(e => log(`vigia falhou: ${(e as Error).message}`)), 2 * 60_000);
  return { fechar: () => clearInterval(vigia) };
}
