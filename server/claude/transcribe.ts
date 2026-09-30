import type { Pool } from 'pg';
import { getSetting } from '../settings.js';

/**
 * Ditado por voz com motor duplo (pedido do Danilo, 30/09/2026):
 * 1. Groq (whisper-large-v3, o modelo completo: erra menos que o turbo em português): o mais rápido e de melhor qualidade; chave `groq_api_key` na
 *    tabela settings (a mesma do Brandspace, nunca no repositório).
 * 2. Whisper local no container `orion-whisper` da c3 (speaches, API compatível com a OpenAI em
 *    127.0.0.1:8090, chave `whisper_local_api_key`): usado se a Groq falhar, demorar ou estourar o
 *    limite. Outros projetos da c3 podem usar o mesmo container com a mesma chave.
 */
const LOCAL_URL = process.env.WHISPER_LOCAL_URL ?? 'http://127.0.0.1:8090';
const LOCAL_MODEL = process.env.WHISPER_LOCAL_MODEL ?? 'Systran/faster-whisper-small';

export type Transcript = { text: string; engine: 'groq' | 'local' };

async function callEngine(url: string, key: string | null, model: string, audio: Blob, filename: string, timeoutMs: number): Promise<string> {
  const fd = new FormData();
  fd.append('file', audio, filename);
  fd.append('model', model);
  fd.append('language', 'pt');
  fd.append('response_format', 'json');
  // Contexto: ajuda o modelo com o vocabulário da equipe (nomes de projetos e termos de programação).
  fd.append('prompt', 'Ditado em português do Brasil para um assistente de programação da equipe Bayerl. Termos comuns: Orion, Claude, deploy, commit, merge, worktree, branch, Supabase, Coolify, Brandspace, FisioExpert, RaLab, mobile, desktop, input, botão, tela.');
  const res = await fetch(url, { method: 'POST', body: fd, headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

export async function transcribe(pool: Pool, audio: Blob, filename: string): Promise<Transcript> {
  const [groqKey, localKey] = await Promise.all([getSetting(pool, 'groq_api_key'), getSetting(pool, 'whisper_local_api_key')]);
  const errors: string[] = [];
  if (groqKey) {
    try { return { text: await callEngine('https://api.groq.com/openai/v1/audio/transcriptions', groqKey, 'whisper-large-v3', audio, filename, 20_000), engine: 'groq' }; }
    catch (e) { errors.push(`groq: ${(e as Error).message}`); }
  }
  try { return { text: await callEngine(`${LOCAL_URL}/v1/audio/transcriptions`, localKey, LOCAL_MODEL, audio, filename, 120_000), engine: 'local' }; }
  catch (e) { errors.push(`local: ${(e as Error).message}`); }
  throw new Error(errors.join(' | '));
}
