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
  it('mensagem enfileirada: dois textos finais no mesmo turno (sem ferramenta no meio) ficam os dois', () => {
    // Achado pelo Danilo (04/10/2026): compositor manda a próxima mensagem enfileirada antes do
    // Claude terminar a primeira; os dois pedidos caem no mesmo turno e cada um ganha seu próprio
    // texto final, sem nenhuma ferramenta entre eles — não é "vou olhar X" seguido do resultado.
    const turn = [
      { id: 'u1', kind: 'user', text: '[G] pergunta 1' },
      { id: 'u2', kind: 'user', text: '[G] pergunta 2' },
      { id: 't1', kind: 'text', text: 'Resposta da pergunta 1.' },
      { id: 't2', kind: 'text', text: 'Resposta da pergunta 2.' },
    ] as unknown as ConvEvent[];
    expect(compactarTurno(turn).map(e => e.id)).toEqual(['u1', 'u2', 't1', 't2']);
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
