import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PLANO = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/;

/**
 * Último toque do Claude no arquivo de plano nesta mensagem (Write/Edit em ~/.claude/plans/*.md).
 * Write traz o texto inteiro: usado direto, porque o pedido de ExitPlanMode pode chegar antes de a
 * escrita terminar quando as duas ferramentas vêm na mesma mensagem.
 */
export function arquivoDePlano(content: unknown): { file: string; text?: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  let achado: { file: string; text?: string } | undefined;
  for (const b of content as { type?: string; name?: string; input?: { file_path?: unknown; content?: unknown } }[]) {
    if (b?.type !== 'tool_use' || !['Write', 'Edit', 'MultiEdit'].includes(String(b.name))) continue;
    const f = b.input?.file_path;
    if (typeof f !== 'string' || !PLANO.test(f)) continue;
    achado = { file: f, text: b.name === 'Write' && typeof b.input?.content === 'string' ? b.input.content : undefined };
  }
  return achado;
}

/**
 * Texto do plano para o pedido de ExitPlanMode: o Claude Code atual não manda o plano no input, ele
 * lê do arquivo. Sem arquivo conhecido, pega o plano mais recente gravado nos últimos 10 minutos.
 * ponytail: o recurso pode pegar o plano de outra sessão se duas planejarem no mesmo minuto.
 */
export async function textoDoPlano(conhecido: { file: string; text?: string } | undefined, dir = path.join(homedir(), '.claude', 'plans')): Promise<{ plan: string; planFilePath: string } | null> {
  if (conhecido?.text !== undefined) return { plan: conhecido.text, planFilePath: conhecido.file };
  let arquivo = conhecido?.file;
  if (!arquivo) {
    try {
      const nomes = (await readdir(dir)).filter(n => n.endsWith('.md'));
      const comData = await Promise.all(nomes.map(async n => ({ f: path.join(dir, n), t: (await stat(path.join(dir, n))).mtimeMs })));
      const recente = comData.sort((a, b) => b.t - a.t)[0];
      if (recente && Date.now() - recente.t < 10 * 60_000) arquivo = recente.f;
    } catch { /* sem pasta */ }
  }
  if (!arquivo) return null;
  try { return { plan: await readFile(arquivo, 'utf8'), planFilePath: arquivo }; } catch { return null; }
}
