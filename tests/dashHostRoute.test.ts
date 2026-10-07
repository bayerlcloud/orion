import { describe, it, expect } from 'vitest';
import { hostValido } from '../server/routes/dash.js';

describe('hostValido', () => {
  it('aceita c3 e os remotos conhecidos', () => {
    expect(hostValido('c3')).toBe('c3');
    expect(hostValido('c1')).toBe('c1');
    expect(hostValido('hostinger')).toBe('hostinger');
  });
  it('cai para c3 em host desconhecido ou ausente', () => {
    expect(hostValido('xyz')).toBe('c3');
    expect(hostValido(undefined)).toBe('c3');
  });
});
