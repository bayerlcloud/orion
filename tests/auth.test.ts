import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, newSessionId } from '../server/auth.js';

describe('senha', () => {
  it('aceita a senha certa e recusa a errada', async () => {
    const h = await hashPassword('123456');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('123456', h)).toBe(true);
    expect(await verifyPassword('1234567', h)).toBe(false);
  });
  it('gera hashes diferentes para a mesma senha (salt)', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });
  it('recusa formato estranho sem lançar', async () => {
    expect(await verifyPassword('a', 'nada')).toBe(false);
    expect(await verifyPassword('a', 'scrypt$$')).toBe(false);
  });
  it('não aceita senha vazia no hash', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});

describe('sessão', () => {
  it('id tem 64 hex e é único', () => {
    const a = newSessionId(), b = newSessionId();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
