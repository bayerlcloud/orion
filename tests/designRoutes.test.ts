import { describe, it, expect } from 'vitest';
import { podeApagar } from '../server/routes/design.js';

describe('podeApagar', () => {
  it('autor pode apagar o próprio design', () => {
    expect(podeApagar({ id: 5, role: 'member' }, { user_id: 5 })).toBe(true);
  });
  it('owner pode apagar design de qualquer um', () => {
    expect(podeApagar({ id: 1, role: 'owner' }, { user_id: 5 })).toBe(true);
  });
  it('member não pode apagar design de outra pessoa', () => {
    expect(podeApagar({ id: 2, role: 'member' }, { user_id: 5 })).toBe(false);
  });
});
