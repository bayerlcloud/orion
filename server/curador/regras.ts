/**
 * Regras propostas a partir de ERROS REPETIDOS (tarefa C1, 27/11/2026). Roda dentro do ciclo do
 * curador (run.ts), logo depois do extrator, sem timer novo. Lê claude_events dos últimos 14 dias e
 * dá uma ASSINATURA a cada erro: projeto + tipo, onde tipo é (a) Bash com is_error (programa do
 * comando + mensagem normalizada, sem números, paths e literais), (b) prompt barrado por hook
 * UserPromptSubmit (system com prevent_continuation) e (c) result com is_error. Mesma assinatura
 * em >= 3 sessões distintas do projeto = erro repetido. Para cada uma sem proposta (hash único em
 * curadoria_propostas, tipo 'regra'), o MODELO_EXTRATOR (haiku) redige uma regra de nível 2 em 1 a
 * 2 linhas e a proposta nasce PENDENTE: nada vira regra sem aprovação no painel (aplicarRegra,
 * chamada por routes/curadoria.ts). Teto: MAX_PROPOSTAS_POR_PROJETO novas por projeto por ciclo.
 * Funções puras (normalizar, agregar) em tests/curadorRegras.test.ts; o SDK só entra em proporRegras.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Pool } from 'pg';
import type { CurQuery } from './proposals.js';
import { MODELO_EXTRATOR } from './extrator.js';
import { salvarMemoria } from '../claude/memoryTool.js';
import type { Embedder } from '../memories/embed.js';
import { ValidationError } from '../memories/util.js';

export const JANELA_DIAS = 14;
export const MIN_SESSOES = 3;
export const MAX_PROPOSTAS_POR_PROJETO = 5;
export const TRECHO_MAX = 200;
const MSG_MAX = 80;
const MAX_EVIDENCIAS = 3;

export type ErroBruto = {
  project_id: number;
  session_id: string;
  tipo: 'bash' | 'hook' | 'result';
  /** Só no tipo bash: o comando que falhou. */
  comando?: string | null;
  /** Conteúdo do tool_result, texto do bloqueio do hook ou result da sessão. */
  mensagem: string | null;
};

export type Repetido = {
  project_id: number;
  assinatura: string;
  hash: string;
  ocorrencias: number;
  sessoes: number;
  evidencias: string[];
};

export type PayloadRegra = Repetido & {
  titulo: string;
  regra_texto: string;
  justificativa: string;
};

const PALAVRAS_ERRO = /error|erro|not found|no such|traceback|cannot|can't|denied|negad|fail|falh|invalid|unexpected|exception|blocked|bloquead|permiss|timeout|refused/i;

function compactar(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A linha que descreve o erro. O tool_result do Bash vem "Exit code N" + stdout + stderr, então a
 * primeira linha com cara de erro ganha; sem nenhuma, fica a primeira linha útil.
 * ponytail: heurística por palavras; cobre os casos reais vistos no banco (psql, python, cat, npm).
 */
export function linhaDoErro(texto: string | null | undefined): string {
  const linhas = (texto ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^exit code \d+$/i.test(l));
  const linha = linhas.find((l) => PALAVRAS_ERRO.test(l)) ?? linhas[0] ?? '';
  // Traceback do Python: a exceção de verdade é a última linha, o cabeçalho é sempre igual.
  return /^Traceback/.test(linha) ? linhas[linhas.length - 1] : linha;
}

/**
 * Apaga segredos antes de qualquer trecho ir para o payload da proposta (fica no banco e no
 * painel) ou para o prompt do modelo: tokens conhecidos, VAR_COM_SENHA=valor, Bearer, JWT e
 * credenciais em URL.
 */
export function mascarar(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/(sbp_|ghp_|github_pat_|cfat_|sk-|xox[abp]-)[A-Za-z0-9_-]+/g, '$1…')
    .replace(/\b(\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|SENHA|API_?KEY)\w*)=("[^"]*"|'[^']*'|\S+)/g, '$1=…')
    .replace(/Bearer [A-Za-z0-9._~+/=-]+/g, 'Bearer …')
    .replace(/\b(token|password|senha|key|secret)=\S+/gi, '$1=…')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '…')
    .replace(/\b(postgres(?:ql)?|mysql|redis|https?):\/\/[^@\s]+@/g, '$1://…@');
}

/** Motivo curto de um bloqueio de hook (mesma regra de hookBlockReason no front). */
export function motivoHook(content: string | null | undefined): string {
  const semPrompt = (content ?? '').split('\n\nOriginal prompt:')[0];
  const i = semPrompt.lastIndexOf(']: ');
  return (i >= 0 ? semPrompt.slice(i + 3) : semPrompt.replace(/^UserPromptSubmit operation blocked by hook:\s*/, '')).trim();
}

/** Mensagem sem o que varia entre ocorrências: literais citados, paths, ids e números. */
export function normalizarMensagem(linha: string): string {
  return linha
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/^Permission to use \w+ with command .* has been denied.*$/i, 'permissão negada para o comando')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"')
    .replace(/(?:~|\/)[\w.@~-]+(?:\/[\w.@~-]*)*/g, '/…')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MSG_MAX);
}

/**
 * Programa que falhou: primeiro token do comando sem os prefixos que não dizem nada
 * (cd X &&, VAR=x, sudo, env, timeout, nohup), só o basename, em minúsculas.
 */
export function primeiroComando(cmd: string | null | undefined): string {
  let s = (cmd ?? '').trim();
  for (;;) {
    const antes = s;
    s = s
      .replace(/^cd\s+\S+\s*(&&|;|\n)\s*/, '')
      .replace(/^\w+=\S*\s+/, '')
      .replace(/^(sudo|env|timeout|nohup)(\s+-\S+(\s+\S+)?|\s+\d+)*\s+/, '')
      .trim();
    if (s === antes) break;
  }
  const tok = s.split(/\s+/)[0] ?? '';
  return tok.replace(/^.*\//, '').toLowerCase() || '?';
}

/** Assinatura (chave de agrupamento) e trecho de evidência de um erro. Mensagem curta demais (só número, só path) não vira assinatura. */
export function assinaturaDe(e: ErroBruto): { assinatura: string; trecho: string } | null {
  if (e.tipo === 'bash') {
    const linha = mascarar(linhaDoErro(e.mensagem));
    const msg = normalizarMensagem(linha);
    if (msg.length < 4) return null;
    return {
      assinatura: `bash:${primeiroComando(e.comando)}:${msg}`,
      trecho: `$ ${compactar(mascarar(e.comando), 90)} → ${compactar(linha, TRECHO_MAX - 95)}`,
    };
  }
  const linha = mascarar(e.tipo === 'hook' ? motivoHook(e.mensagem) : linhaDoErro(e.mensagem));
  const msg = normalizarMensagem(linha);
  if (msg.length < 4) return null;
  return { assinatura: `${e.tipo}:${msg}`, trecho: compactar(linha, TRECHO_MAX) };
}

export function hashAssinatura(projectId: number, assinatura: string): string {
  return createHash('sha1').update(`${projectId}|${assinatura}`).digest('hex');
}

/**
 * Agrupa por projeto + assinatura e devolve só o que se repetiu em >= minSessoes sessões distintas,
 * com até 3 evidências (uma por sessão). Ordem: mais sessões, depois mais ocorrências.
 */
export function agregar(erros: ErroBruto[], minSessoes = MIN_SESSOES): Repetido[] {
  type Grupo = { project_id: number; assinatura: string; n: number; sessoes: Set<string>; evid: Map<string, string> };
  const grupos = new Map<string, Grupo>();
  for (const e of erros) {
    const a = assinaturaDe(e);
    if (!a) continue;
    const k = `${e.project_id}|${a.assinatura}`;
    const g = grupos.get(k) ?? { project_id: e.project_id, assinatura: a.assinatura, n: 0, sessoes: new Set(), evid: new Map() };
    g.n++;
    g.sessoes.add(e.session_id);
    if (!g.evid.has(e.session_id) && g.evid.size < MAX_EVIDENCIAS) g.evid.set(e.session_id, a.trecho);
    grupos.set(k, g);
  }
  return [...grupos.values()]
    .filter((g) => g.sessoes.size >= minSessoes)
    .map((g) => ({
      project_id: g.project_id,
      assinatura: g.assinatura,
      hash: hashAssinatura(g.project_id, g.assinatura),
      ocorrencias: g.n,
      sessoes: g.sessoes.size,
      evidencias: [...g.evid.values()],
    }))
    .sort((a, b) => b.sessoes - a.sessoes || b.ocorrencias - a.ocorrencias || a.assinatura.localeCompare(b.assinatura));
}

const CONTEUDO = `CASE WHEN jsonb_typeof(e.payload->'message'->'content') = 'array' THEN e.payload->'message'->'content' ELSE '[]'::jsonb END`;

/** Erros brutos dos últimos JANELA_DIAS dias, das sessões com projeto. Só leitura. */
export async function coletarErros(q: CurQuery, dias = JANELA_DIAS): Promise<ErroBruto[]> {
  const { rows } = await q(
    `WITH tu AS (
       SELECT e.session_id, b->>'id' AS id, b->'input'->>'command' AS comando
         FROM claude_events e CROSS JOIN LATERAL jsonb_array_elements(${CONTEUDO}) b
        WHERE e.type = 'assistant' AND e.ts >= now() - make_interval(days => $1 + 1)
          AND b->>'type' = 'tool_use' AND b->>'name' = 'Bash'
     )
     SELECT s.project_id, e.session_id, 'bash' AS tipo, tu.comando,
            CASE WHEN jsonb_typeof(b->'content') = 'string' THEN b->>'content'
                 ELSE (SELECT string_agg(x->>'text', E'\\n') FROM jsonb_array_elements(b->'content') x WHERE x->>'type' = 'text') END AS mensagem
       FROM claude_events e
       JOIN claude_sessions s ON s.id = e.session_id
       CROSS JOIN LATERAL jsonb_array_elements(${CONTEUDO}) b
       JOIN tu ON tu.session_id = e.session_id AND tu.id = b->>'tool_use_id'
      WHERE e.type = 'user' AND e.ts >= now() - make_interval(days => $1)
        AND b->>'type' = 'tool_result' AND (b->>'is_error')::boolean AND s.project_id IS NOT NULL
     UNION ALL
     SELECT s.project_id, e.session_id, 'hook', NULL, e.payload->>'content'
       FROM claude_events e JOIN claude_sessions s ON s.id = e.session_id
      WHERE e.type = 'system' AND e.ts >= now() - make_interval(days => $1)
        AND e.payload->>'prevent_continuation' = 'true' AND jsonb_typeof(e.payload->'content') = 'string' AND s.project_id IS NOT NULL
     UNION ALL
     SELECT s.project_id, e.session_id, 'result', NULL, coalesce(nullif(e.payload->>'result', ''), e.payload->>'subtype')
       FROM claude_events e JOIN claude_sessions s ON s.id = e.session_id
      WHERE e.type = 'result' AND e.ts >= now() - make_interval(days => $1)
        AND (e.payload->>'is_error')::boolean AND s.project_id IS NOT NULL`,
    [dias],
  );
  return rows as ErroBruto[];
}

export const REGRA_PROMPT = [
  'Você redige regras de projeto (nível 2 da memória do painel Orion) a partir de um erro que se repetiu em várias sessões do MESMO projeto.',
  'Vai receber a assinatura do erro, quantas vezes e em quantas sessões aconteceu e trechos reais. Deduza a regra prática que evita a repetição (o que fazer ou não fazer neste projeto) e grave com a tool regra.',
  'titulo: curto, começando pelo assunto (ex.: "Deploy: publicar só pelo orion-publicar"). texto: 1 a 2 linhas em pt-BR, imperativo e concreto, citando o comando ou recurso envolvido. Sem segredos, sem paths temporários, sem inventar causa que os trechos não mostram.',
  'Se os trechos forem ruído sem lição reaproveitável (erro de digitação, arquivo temporário que sumiu, saída normal marcada como erro), não chame a tool e responda só "nada".',
].join('\n');

export type RegrasStats = { erros: number; repetidas: number; propostas: number; puladas: number; tokens: { entrada: number; saida: number } };

type RegraRedigida = { titulo: string; texto: string };

/** Uma chamada ao modelo barato por assinatura; null quando ele julgou ruído (não chamou a tool). */
async function redigirRegra(r: Repetido, slug: string, opts: { env?: Record<string, string>; model?: string }, stats: RegrasStats): Promise<RegraRedigida | null> {
  let redigida: RegraRedigida | null = null;
  const servidor = createSdkMcpServer({
    name: 'regras',
    version: '1.0.0',
    tools: [
      tool('regra', 'Grava a regra de nível 2 proposta para o projeto (fica pendente de aprovação humana).', {
        titulo: z.string().describe('título curto'),
        texto: z.string().describe('1 a 2 linhas, imperativo, pt-BR'),
      }, async (a) => {
        redigida = { titulo: a.titulo.trim().slice(0, 120), texto: a.texto.trim().slice(0, 400) };
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }),
    ],
  });
  const run = sdkQuery({
    prompt: `Projeto ${slug}. Assinatura: ${r.assinatura}\n${r.ocorrencias} ocorrências em ${r.sessoes} sessões nos últimos ${JANELA_DIAS} dias.\nTrechos:\n${r.evidencias.map((t) => `- ${t}`).join('\n')}`,
    options: {
      cwd: process.env.ORION_REPO ?? '/srv/orion',
      systemPrompt: REGRA_PROMPT,
      model: opts.model ?? MODELO_EXTRATOR,
      maxTurns: 3,
      permissionMode: 'default',
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
      canUseTool: async (toolName) =>
        toolName.startsWith('mcp__regras__') ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: 'só a tool regra' },
      mcpServers: { regras: servidor },
      ...(opts.env ? { env: opts.env } : {}),
    },
  });
  for await (const m of run) {
    if (m.type === 'result') {
      const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      stats.tokens.entrada += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
      stats.tokens.saida += u?.output_tokens ?? 0;
    }
  }
  return redigida;
}

/** Ciclo completo: coleta, agrega, pula o que já tem proposta e grava até 5 propostas novas por projeto. */
export async function proporRegras(pool: Pool, opts: { env?: Record<string, string>; log?: (m: string) => void; model?: string } = {}): Promise<RegrasStats> {
  const log = opts.log ?? console.log;
  const q: CurQuery = (sql, params) => pool.query(sql, params as any[]);
  const stats: RegrasStats = { erros: 0, repetidas: 0, propostas: 0, puladas: 0, tokens: { entrada: 0, saida: 0 } };
  const erros = await coletarErros(q);
  stats.erros = erros.length;
  const repetidas = agregar(erros);
  stats.repetidas = repetidas.length;
  if (!repetidas.length) return stats;

  const { rows: existentes } = await q(
    `SELECT payload->>'hash' AS hash FROM curadoria_propostas WHERE tipo = 'regra' AND payload->>'hash' = ANY($1)`,
    [repetidas.map((r) => r.hash)],
  );
  const ja = new Set(existentes.map((r: any) => r.hash));
  const { rows: projetos } = await q('SELECT id, slug FROM projects');
  const slug = new Map<number, string>(projetos.map((p: any) => [p.id, p.slug]));
  const porProjeto = new Map<number, number>();

  for (const r of repetidas) {
    if (ja.has(r.hash)) continue;
    const n = porProjeto.get(r.project_id) ?? 0;
    if (n >= MAX_PROPOSTAS_POR_PROJETO) { stats.puladas++; continue; }
    const nome = slug.get(r.project_id) ?? String(r.project_id);
    let regra: RegraRedigida | null = null;
    try {
      regra = await redigirRegra(r, nome, opts, stats);
    } catch (e) {
      log(`curador regras ${nome}: modelo falhou (${(e as Error)?.message ?? e}); tenta de novo na próxima rodada`);
      continue;
    }
    if (!regra) {
      // Ruído segundo o modelo: fica registrado já rejeitado, para o hash barrar o reprocessamento amanhã.
      const ruido: PayloadRegra = { ...r, titulo: '', regra_texto: '', justificativa: 'ruído, julgado pelo modelo' };
      await q(
        `INSERT INTO curadoria_propostas (tipo, payload, status, decided_at) VALUES ('regra', $1, 'rejeitada', now())
         ON CONFLICT ((payload->>'hash')) WHERE tipo = 'regra' DO NOTHING`,
        [JSON.stringify(ruido)],
      );
      stats.puladas++;
      continue;
    }
    const payload: PayloadRegra = {
      ...r,
      titulo: regra.titulo,
      regra_texto: regra.texto,
      justificativa: `erro repetido em ${r.sessoes} sessões (${r.ocorrencias} ocorrências) nos últimos ${JANELA_DIAS} dias`,
    };
    await q(
      `INSERT INTO curadoria_propostas (tipo, payload) VALUES ('regra', $1)
       ON CONFLICT ((payload->>'hash')) WHERE tipo = 'regra' DO NOTHING`,
      [JSON.stringify(payload)],
    );
    porProjeto.set(r.project_id, n + 1);
    stats.propostas++;
    log(`curador: regra proposta para ${nome}: ${regra.titulo}`);
  }
  return stats;
}

/**
 * Aprovação no painel: cria a regra de nível 2 no projeto pelo mesmo salvarMemoria da tool e do
 * extrator (code único, embedding, dedupe no escopo, autor = quem aprovou, origem 'curador').
 * Parecida demais com uma regra existente: ValidationError, a proposta fica pendente para descartar.
 */
export async function aplicarRegra(q: CurQuery, payload: PayloadRegra, userId: number, embedder?: Embedder): Promise<string> {
  const projectId = Number(payload?.project_id);
  const texto = typeof payload?.regra_texto === 'string' ? payload.regra_texto.trim() : '';
  if (!Number.isInteger(projectId) || projectId <= 0 || !texto) throw new ValidationError('proposta de regra sem projeto ou sem texto');
  const { rowCount } = await q('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (!rowCount) throw new ValidationError('o projeto da regra não existe mais');
  const data = new Date().toLocaleDateString('pt-BR');
  const r = await salvarMemoria(
    q,
    { sessionId: 'curador', projectId, userId, autorId: userId },
    {
      titulo: payload.titulo || texto.slice(0, 80),
      corpo: `Curador, ${data}: ${texto}\n\nOrigem: ${payload.ocorrencias} ocorrências em ${payload.sessoes} sessões (${payload.assinatura}).`,
      nivel: 2,
      resumo: texto,
      keywords: ['curador'],
      escopo: 'projeto',
    },
    embedder,
    { origem: 'curador' },
  );
  if (!r.salva) throw new ValidationError(`já existe regra parecida neste projeto (${r.parecida}); descarte a proposta ou edite a existente`);
  return `regra ${r.code} criada no nível 2 do projeto`;
}
