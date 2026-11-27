import { describe, it, expect } from 'vitest';
import {
  MIN_SESSOES, TRECHO_MAX, agregar, aplicarRegra, assinaturaDe, hashAssinatura, linhaDoErro,
  motivoHook, normalizarMensagem, primeiroComando, type ErroBruto, type PayloadRegra,
} from '../server/curador/regras.js';
import type { CurQuery } from '../server/curador/proposals.js';

function fakeQuery(responder: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number | null } | undefined) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const q: CurQuery = async (sql, params) => { calls.push({ sql, params }); return responder(sql, params) ?? { rows: [], rowCount: 0 }; };
  return { q, calls };
}

describe('normalização da assinatura', () => {
  it('primeiroComando ignora cd, variáveis, sudo e paths; fica o programa em minúsculas', () => {
    expect(primeiroComando('cd /srv/projects/x && npm install @vitejs/plugin')).toBe('npm');
    expect(primeiroComando('sudo -u danilo git push origin main')).toBe('git');
    expect(primeiroComando('NODE_PATH=/x/node_modules node dist/a.js')).toBe('node');
    expect(primeiroComando('~/.local/bin/dbfor brandspace psql < /tmp/a.sql')).toBe('dbfor');
    expect(primeiroComando('cd /srv/x\ngit remote -v')).toBe('git');
    expect(primeiroComando('timeout 30 SSH -i k root@h "x"')).toBe('ssh');
    expect(primeiroComando('')).toBe('?');
  });

  it('linhaDoErro pula "Exit code" e stdout, prefere a linha com cara de erro', () => {
    expect(linhaDoErro('Exit code 1\n/usr/bin/ffmpeg\ncat: /tmp/a.log: No such file or directory')).toBe('cat: /tmp/a.log: No such file or directory');
    expect(linhaDoErro('Exit code 2\n\nup to date, audited 402 packages')).toBe('up to date, audited 402 packages');
    expect(linhaDoErro('Exit code 1')).toBe('');
  });

  it('normalizarMensagem apaga o que varia: literais citados, paths, ids e números; corta em 80', () => {
    const a = normalizarMensagem('ERROR:  column "data_hora" does not exist');
    const b = normalizarMensagem('ERROR: column "direction" does not exist');
    expect(a).toBe(b);
    expect(a).toBe('ERROR: column "…" does not exist');
    expect(normalizarMensagem('/bin/bash: line 1: /tmp/fix_barbara.sql: No such file or directory')).toBe('/…: line #: /…: No such file or directory');
    expect(normalizarMensagem("tail: cannot open '/tmp/shopify-dev.log' for reading")).toBe('tail: cannot open "…" for reading');
    expect(normalizarMensagem('Permission to use Bash with command ls -la /srv/x/.env has been denied by the user')).toBe('permissão negada para o comando');
    expect(normalizarMensagem('<tool_use_error>Blocked: sleep 25 followed by: echo</tool_use_error>')).toBe('Blocked: sleep # followed by: echo');
    expect(normalizarMensagem('x'.repeat(200))).toHaveLength(80);
  });

  it('motivoHook fica só com o motivo, sem o comando do hook nem o prompt original', () => {
    expect(motivoHook('UserPromptSubmit operation blocked by hook:\n[node /x/hook.js]: sem token no prompt\n\nOriginal prompt: oi')).toBe('sem token no prompt');
  });

  it('assinaturaDe: bash = programa + mensagem; trecho com comando e erro em até 200 chars; curta demais vira null', () => {
    const a = assinaturaDe({ project_id: 5, session_id: 's1', tipo: 'bash', comando: 'dbfor tm psql "SELECT 1"', mensagem: 'Exit code 127\n/bin/bash: line 1: dbfor: command not found' })!;
    expect(a.assinatura).toBe('bash:dbfor:/…: line #: dbfor: command not found');
    expect(a.trecho).toBe('$ dbfor tm psql "SELECT 1" → /bin/bash: line 1: dbfor: command not found');
    const longo = assinaturaDe({ project_id: 5, session_id: 's1', tipo: 'bash', comando: 'x '.repeat(200), mensagem: 'Exit code 1\n' + 'erro '.repeat(100) })!;
    expect(longo.trecho.length).toBeLessThanOrEqual(TRECHO_MAX);
    expect(assinaturaDe({ project_id: 5, session_id: 's1', tipo: 'bash', comando: 'ssh h', mensagem: 'Exit code 7\n255' })).toBeNull();
    expect(assinaturaDe({ project_id: 5, session_id: 's1', tipo: 'bash', comando: 'ls', mensagem: null })).toBeNull();
    const h = assinaturaDe({ project_id: 1, session_id: 's1', tipo: 'hook', comando: null, mensagem: 'UserPromptSubmit operation blocked by hook:\n[h]: cola o token 12345 aqui\n\nOriginal prompt: x' })!;
    expect(h.assinatura).toBe('hook:cola o token # aqui');
    const r = assinaturaDe({ project_id: 1, session_id: 's1', tipo: 'result', comando: null, mensagem: 'error_during_execution' })!;
    expect(r.assinatura).toBe('result:error_during_execution');
  });
});

describe('agregar', () => {
  const erro = (session_id: string, p: Partial<ErroBruto> = {}): ErroBruto => ({
    project_id: 5, session_id, tipo: 'bash', comando: `dbfor tm psql "SELECT ${session_id}"`,
    mensagem: 'Exit code 127\n/bin/bash: line 1: dbfor: command not found', ...p,
  });

  it('só o que se repete em >= 3 sessões distintas; conta ocorrências; uma evidência por sessão (3 no máximo)', () => {
    const erros = [erro('a'), erro('a'), erro('b'), erro('c'), erro('d'), erro('x', { comando: 'cat /tmp/a', mensagem: 'cat: /tmp/a: No such file' }), erro('y', { comando: 'cat /tmp/b', mensagem: 'cat: /tmp/b: No such file' })];
    const r = agregar(erros);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ project_id: 5, assinatura: 'bash:dbfor:/…: line #: dbfor: command not found', ocorrencias: 5, sessoes: 4 });
    expect(r[0].evidencias).toHaveLength(3);
    expect(r[0].evidencias[0]).toContain('SELECT a');
    expect(r[0].evidencias[1]).toContain('SELECT b');
    expect(r[0].hash).toBe(hashAssinatura(5, r[0].assinatura));
    expect(MIN_SESSOES).toBe(3);
  });

  it('mesma mensagem em projetos diferentes são assinaturas diferentes, com hash diferente; ordena por sessões e ocorrências', () => {
    const erros = [
      erro('a'), erro('b'), erro('c'),
      erro('d', { project_id: 13 }), erro('e', { project_id: 13 }), erro('f', { project_id: 13 }), erro('g', { project_id: 13 }),
    ];
    const r = agregar(erros);
    expect(r.map((x) => [x.project_id, x.sessoes])).toEqual([[13, 4], [5, 3]]);
    expect(r[0].hash).not.toBe(r[1].hash);
    expect(agregar(erros, 5)).toEqual([]);
  });

  it('erro sem mensagem útil não entra em grupo nenhum', () => {
    expect(agregar([erro('a', { mensagem: null }), erro('b', { mensagem: 'Exit code 1' }), erro('c', { mensagem: '' })])).toEqual([]);
  });
});

describe('aplicarRegra (aprovação no painel)', () => {
  const payload: PayloadRegra = {
    project_id: 7, assinatura: 'bash:dbfor:/…: dbfor: command not found', hash: 'abc', ocorrencias: 10, sessoes: 5,
    evidencias: ['$ dbfor x → dbfor: command not found'], titulo: 'dbfor: usar o caminho completo',
    regra_texto: 'No TrackingMachine, chame ~/.local/bin/dbfor pelo caminho completo; o PATH do Bash não o tem.',
    justificativa: 'erro repetido em 5 sessões',
  };

  it('cria a memória nível 2 no projeto pelo salvarMemoria, com autor = quem aprovou e origem curador', async () => {
    const { q, calls } = fakeQuery((sql) => (sql.includes('FROM projects') ? { rows: [{ ok: 1 }], rowCount: 1 } : undefined));
    const r = await aplicarRegra(q, payload, 9);
    expect(r).toBe('regra dbfor-usar-o-caminho-completo criada no nível 2 do projeto');
    const ins = calls.find((c) => c.sql.includes('INSERT INTO memories'))!;
    expect(ins.params?.slice(4, 6)).toEqual([2, null]);
    expect(ins.params?.slice(7, 12)).toEqual([7, null, 9, 'curador', 'curador']);
    expect(String(ins.params?.[3])).toContain('10 ocorrências em 5 sessões');
    expect(ins.params?.[2]).toBe(payload.regra_texto);
  });

  it('recusa payload sem projeto ou sem texto e projeto que não existe mais', async () => {
    const { q } = fakeQuery(() => undefined);
    await expect(aplicarRegra(q, { ...payload, regra_texto: '' }, 9)).rejects.toThrow(/sem projeto ou sem texto/);
    await expect(aplicarRegra(q, { ...payload, project_id: 0 }, 9)).rejects.toThrow(/sem projeto ou sem texto/);
    await expect(aplicarRegra(q, payload, 9)).rejects.toThrow(/não existe mais/);
  });

  it('regra quase igual já existente no escopo: erro de validação, nada é inserido', async () => {
    const { q, calls } = fakeQuery((sql) => {
      if (sql.includes('FROM projects')) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('<=>')) return { rows: [{ code: 'dbfor-caminho', title: 'x', sim: 0.97 }], rowCount: 1 };
      return undefined;
    });
    await expect(aplicarRegra(q, payload, 9, async () => [0.1, 0.2])).rejects.toThrow(/já existe regra parecida/);
    expect(calls.some((c) => c.sql.includes('INSERT INTO memories'))).toBe(false);
  });
});
