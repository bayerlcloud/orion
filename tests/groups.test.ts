import { describe, it, expect } from 'vitest';
import { validateGroupName, GROUP_NAME_MAX } from '../server/claude/groups';

/**
 * "Agrupamento de sessões em pastas nomeadas" (ver PARIDADE.md, item 12 da seção 13) — validação do
 * nome de uma pasta, autoridade final do lado servidor (nunca confia no que `web/src/claude/mapper.ts`
 * — `validateGroupName`, cópia deliberada — já validou). Mesma regra/limite do rename de sessão
 * (`POST /api/claude/sessions/:id/rename`, `title.trim().slice(0, 120)`) — sem restrição de
 * caractere: nome de pasta é só um rótulo livre no Postgres, diferente do nome de worktree (que vira
 * nome de branch git e por isso tem uma regra bem mais estrita em `server/claude/worktree.ts`).
 */
describe('validateGroupName', () => {
  it('nome vazio é inválido', () => {
    expect(validateGroupName('')).toBeTruthy();
  });

  it('nome só espaço é inválido (trim antes de checar)', () => {
    expect(validateGroupName('   ')).toBeTruthy();
  });

  it('nome normal com acento/espaço é válido', () => {
    expect(validateGroupName('Projetos da c3')).toBeNull();
  });

  it(`limite de ${GROUP_NAME_MAX} caracteres: no limite é válido, 1 a mais é inválido`, () => {
    expect(validateGroupName('a'.repeat(GROUP_NAME_MAX))).toBeNull();
    expect(validateGroupName('a'.repeat(GROUP_NAME_MAX + 1))).toBeTruthy();
  });

  it('sem restrição de caractere (diferente do nome de worktree) — emoji e símbolos passam', () => {
    expect(validateGroupName('🔥 Urgente / hoje!')).toBeNull();
  });
});
