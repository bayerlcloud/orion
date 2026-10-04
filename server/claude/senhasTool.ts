/**
 * Tool MCP in-process "orion-senhas": busca/cadastra/atualiza itens no cofre Vaultwarden do Danilo
 * (orion.bayerl.cloud/senhas) via `bw` CLI. Só entra no turno quando quem mandou é owner
 * (routes/claude.ts), porque o cofre é o pessoal dele, não um cofre da equipe.
 *
 * O `bw` roda como o usuário do processo (danilo). A sessão desbloqueada (BW_SESSION) NUNCA passa
 * pelo chat: o Danilo gera com `bw login`/`bw unlock` direto num terminal (fora desta sessão) e
 * grava em ~/.orion/bw-session.env (chmod 600), lido aqui a cada chamada — nunca cacheado em
 * memória do processo, para uma troca de senha valer na hora sem reiniciar o Orion.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

const SESSION_FILE = path.join(homedir(), '.orion', 'bw-session.env');

async function bwSession(): Promise<string | null> {
  try {
    const txt = await readFile(SESSION_FILE, 'utf8');
    return /^BW_SESSION=(.+)$/m.exec(txt)?.[1]?.trim() || null;
  } catch { return null; }
}

function run(args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = execFile('bw', args, { env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error as any).code ?? 1 : 0, out: stdout, err: stderr }));
    if (input) { child.stdin?.write(input); child.stdin?.end(); }
  });
}

const SEM_SESSAO = 'Cofre travado: não achei ~/.orion/bw-session.env (ou a sessão dentro dele expirou). '
  + 'O Danilo precisa gerar uma nova num terminal fora do chat: `bw login <email>` (ou `bw unlock`, se já logado), '
  + 'depois `mkdir -p ~/.orion && echo \'BW_SESSION=<valor que o bw imprimiu>\' > ~/.orion/bw-session.env && chmod 600 ~/.orion/bw-session.env`.';

type Item = { id: string; name: string; login?: { username?: string; password?: string; uris?: { uri: string }[] }; notes?: string | null };

async function bwList(session: string, busca: string): Promise<Item[]> {
  const r = await run(['list', 'items', '--search', busca], { BW_SESSION: session });
  if (r.code !== 0) throw new Error(r.err.trim() || r.out.trim() || 'bw list falhou');
  return JSON.parse(r.out || '[]');
}

function resumo(it: Item) {
  return { id: it.id, nome: it.name, usuario: it.login?.username ?? null, senha: it.login?.password ?? null, url: it.login?.uris?.[0]?.uri ?? null, notas: it.notes ?? null };
}

export function orionSenhasServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'orion-senhas',
    version: '1.0.0',
    instructions: 'Cofre pessoal do Danilo (Vaultwarden). buscar antes de inventar ou supor uma credencial; cadastrar quando descobrir/gerar uma senha nova; '
      + 'atualizar quando ela mudar. Nunca mostre a senha em texto fora da resposta direta a quem pediu; nunca grave senha em memória (orion-memory) nem em arquivo do repositório.',
    tools: [
      tool('buscar', 'Procura itens no cofre pelo nome/usuário/URL. Devolve usuário, senha e URL de cada item encontrado.',
        { busca: z.string().min(1).describe('Texto a procurar (nome do site, serviço, usuário...)') },
        async (a) => {
          const session = await bwSession();
          if (!session) return { content: [{ type: 'text' as const, text: SEM_SESSAO }], isError: true };
          try {
            const itens = await bwList(session, a.busca);
            if (!itens.length) return { content: [{ type: 'text' as const, text: `nada encontrado para "${a.busca}".` }] };
            return { content: [{ type: 'text' as const, text: JSON.stringify(itens.map(resumo)) }] };
          } catch (e) { return { content: [{ type: 'text' as const, text: String((e as Error).message) }], isError: true }; }
        }),
      tool('cadastrar', 'Cria um item novo (login) no cofre.',
        { nome: z.string().min(1), usuario: z.string().optional(), senha: z.string().min(1), url: z.string().optional(), notas: z.string().optional() },
        async (a) => {
          const session = await bwSession();
          if (!session) return { content: [{ type: 'text' as const, text: SEM_SESSAO }], isError: true };
          const tpl = await run(['get', 'template', 'item'], { BW_SESSION: session });
          if (tpl.code !== 0) return { content: [{ type: 'text' as const, text: tpl.err || 'bw get template falhou' }], isError: true };
          const loginTpl = await run(['get', 'template', 'item.login'], { BW_SESSION: session });
          const item = { ...JSON.parse(tpl.out), type: 1, name: a.nome, notes: a.notas ?? null,
            login: { ...JSON.parse(loginTpl.out), username: a.usuario ?? null, password: a.senha, uris: a.url ? [{ uri: a.url }] : [] } };
          const enc = await run(['encode'], {}, JSON.stringify(item));
          const created = await run(['create', 'item', enc.out.trim()], { BW_SESSION: session });
          if (created.code !== 0) return { content: [{ type: 'text' as const, text: created.err || 'bw create falhou' }], isError: true };
          return { content: [{ type: 'text' as const, text: `cadastrado: ${a.nome}.` }] };
        }),
      tool('atualizar', 'Atualiza usuário/senha/URL/notas de um item existente (acha pelo id de buscar, ou por um nome que bata com só um item).',
        { id: z.string().optional(), nome: z.string().optional(), usuario: z.string().optional(), senha: z.string().optional(), url: z.string().optional(), notas: z.string().optional() },
        async (a) => {
          const session = await bwSession();
          if (!session) return { content: [{ type: 'text' as const, text: SEM_SESSAO }], isError: true };
          let id = a.id;
          if (!id) {
            if (!a.nome) return { content: [{ type: 'text' as const, text: 'passe id (de buscar) ou nome.' }], isError: true };
            const achados = await bwList(session, a.nome);
            if (achados.length !== 1) return { content: [{ type: 'text' as const, text: achados.length ? `"${a.nome}" bate com ${achados.length} itens; use buscar e passe o id.` : `nada encontrado para "${a.nome}".` }], isError: true };
            id = achados[0].id;
          }
          const got = await run(['get', 'item', id], { BW_SESSION: session });
          if (got.code !== 0) return { content: [{ type: 'text' as const, text: got.err || 'bw get item falhou' }], isError: true };
          const item = JSON.parse(got.out);
          if (a.nome) item.name = a.nome;
          if (a.notas !== undefined) item.notes = a.notas;
          item.login ??= {};
          if (a.usuario !== undefined) item.login.username = a.usuario;
          if (a.senha !== undefined) item.login.password = a.senha;
          if (a.url) item.login.uris = [{ uri: a.url }];
          const enc = await run(['encode'], {}, JSON.stringify(item));
          const edited = await run(['edit', 'item', id, enc.out.trim()], { BW_SESSION: session });
          if (edited.code !== 0) return { content: [{ type: 'text' as const, text: edited.err || 'bw edit falhou' }], isError: true };
          return { content: [{ type: 'text' as const, text: `atualizado: ${item.name}.` }] };
        }),
    ],
  });
}
