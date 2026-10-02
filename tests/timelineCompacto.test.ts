import { describe, it, expect } from 'vitest';
import { compactarTurno } from '../web/src/claude/mapper';
import type { ConvEvent } from '../web/src/claude/types';

describe('compactarTurno (menu ⋮ > Só pergunta e resposta)', () => {
  it('tira ferramentas, pensamento e texto intermediário; deixa usuário, última resposta e erro', () => {
    const turn = [
      { id: 'u', kind: 'user', text: '[G] faz X' },
      { id: 'th', kind: 'thinking', text: 'hmm' },
      { id: 't1', kind: 'text', text: 'Vou olhar.' },
      { id: 'b', kind: 'tool', toolUseId: 'x', name: 'Bash', label: 'Bash', status: 'success', input: { command: 'ls' } },
      { id: 't2', kind: 'text', text: 'Pronto.' },
      { id: 'r', kind: 'result', ok: false, error: 'caiu' },
    ] as unknown as ConvEvent[];
    expect(compactarTurno(turn).map(e => e.id)).toEqual(['u', 't2', 'r']);
  });
  it('turno ainda rodando: mantém o busy e o último texto parcial', () => {
    const turn = [
      { id: 'u', kind: 'user', text: '[G] oi' },
      { id: 'b', kind: 'tool', toolUseId: 'x', name: 'Read', label: 'Read', status: 'running' },
      { id: 't', kind: 'text', text: 'Lend', streaming: true },
      { id: 'busy', kind: 'busy' },
    ] as unknown as ConvEvent[];
    expect(compactarTurno(turn).map(e => e.id)).toEqual(['u', 't', 'busy']);
  });
});
