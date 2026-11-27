import { describe, expect, it } from 'vitest';
import { arquivosEditados, relativoAoProjeto, vizinhasParaHeader, type SessaoVizinha } from '../server/claude/vizinhas.js';
import { buildSystemAppend } from '../server/claude/header.js';

const base: SessaoVizinha = { id: 'b', title: 'Site DDC', pessoa: 'Danilo', privada: false, emTurno: true, paradaMin: 0, arquivos: ['sites/ddc/app/page.tsx', 'sites/ddc/components/Header.tsx'] };

// Payloads copiados do banco (claude_events.type = 'assistant'), anonimizados.
const payloadEdit = { type: 'assistant', uuid: 'u1', message: { id: 'msg_1', role: 'assistant', type: 'message', content: [
  { type: 'text', text: 'Vou ajustar o import.' },
  { id: 'toolu_1', name: 'Edit', type: 'tool_use', input: { file_path: '/srv/projects/exemplo-worktrees/ana/sites/x/app/page.tsx', new_string: 'a', old_string: 'b', replace_all: false }, caller: { type: 'direct' } },
] }, timestamp: '2026-11-27T12:40:37.789Z' };
const payloadWrite = { type: 'assistant', message: { role: 'assistant', content: [
  { id: 'toolu_2', name: 'Write', type: 'tool_use', input: { file_path: '/srv/projects/exemplo/app/novo.tsx', content: 'export {}' } },
  { id: 'toolu_3', name: 'Read', type: 'tool_use', input: { file_path: '/srv/projects/exemplo/app/lido.tsx' } },
  { id: 'toolu_4', name: 'NotebookEdit', type: 'tool_use', input: { notebook_path: '/srv/projects/exemplo/analise.ipynb', new_source: '1' } },
] } };

describe('Sessões vizinhas (header)', () => {
  it('sem vizinha não gera bloco nem entra no system append', () => {
    expect(vizinhasParaHeader([])).toBe('');
    expect(vizinhasParaHeader(null)).toBe('');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Ana' })).not.toContain('Outras sessões');
  });
  it('lista título, pessoa, status e arquivos relativos; o header inclui o bloco', () => {
    const txt = vizinhasParaHeader([base, { ...base, id: 'c', title: 'Busca', pessoa: 'Laís', emTurno: false, paradaMin: 9, arquivos: [] }]);
    expect(txt).toContain('Outras sessões ativas neste projeto (últimos 30 min)');
    expect(txt).toContain('- "Site DDC" (Danilo, em turno agora); editou: sites/ddc/app/page.tsx, sites/ddc/components/Header.tsx');
    expect(txt).toContain('- "Busca" (Laís, parada há 9 min); não editou arquivos');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Ana', vizinhas: [base] })).toContain('"Site DDC" (Danilo, em turno agora)');
  });
  it('corta em 8 arquivos e resume o resto como +N', () => {
    const arquivos = Array.from({ length: 11 }, (_, i) => `src/a${i}.ts`);
    const txt = vizinhasParaHeader([{ ...base, arquivos }]);
    expect(txt).toContain('src/a7.ts +3');
    expect(txt).not.toContain('src/a8.ts');
  });
  it('sessão privada mostra só a pessoa, sem título nem arquivos', () => {
    const txt = vizinhasParaHeader([{ ...base, privada: true }]);
    expect(txt).toContain('- sessão privada de Danilo');
    expect(txt).not.toContain('Site DDC');
    expect(txt).not.toContain('page.tsx');
  });
  it('extrai os caminhos de Edit/Write/NotebookEdit do payload real e ignora Read', () => {
    expect(arquivosEditados(payloadEdit)).toEqual(['/srv/projects/exemplo-worktrees/ana/sites/x/app/page.tsx']);
    expect(arquivosEditados(payloadWrite)).toEqual(['/srv/projects/exemplo/app/novo.tsx', '/srv/projects/exemplo/analise.ipynb']);
    expect(arquivosEditados({ type: 'assistant', message: { content: 'texto simples' } })).toEqual([]);
    expect(arquivosEditados(null)).toEqual([]);
  });
  it('caminho fica relativo ao projeto tirando a worktree da sessão ou a raiz do projeto', () => {
    expect(relativoAoProjeto('/srv/projects/exemplo-worktrees/ana/sites/x/app/page.tsx', ['/srv/projects/exemplo-worktrees/ana', '/srv/projects/exemplo'])).toBe('sites/x/app/page.tsx');
    expect(relativoAoProjeto('/srv/projects/exemplo/app/novo.tsx', ['/srv/projects/exemplo-worktrees/ana', '/srv/projects/exemplo/'])).toBe('app/novo.tsx');
    expect(relativoAoProjeto('/etc/hosts', ['/srv/projects/exemplo', null])).toBe('/etc/hosts');
  });
});
