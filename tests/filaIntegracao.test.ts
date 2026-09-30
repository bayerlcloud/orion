import { describe, it, expect } from 'vitest';
import { FilaIntegracao } from '../server/integracao/fila';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('FilaIntegracao', () => {
  it('serializa por projeto e paraleliza entre projetos', async () => {
    const f = new FilaIntegracao(); const log: string[] = [];
    const job = (n: string, ms: number) => async () => { log.push(`+${n}`); await wait(ms); log.push(`-${n}`); };
    await Promise.all([f.enfileirar(1, job('a', 30)), f.enfileirar(1, job('b', 1)), f.enfileirar(2, job('c', 1))]);
    expect(log.indexOf('-a')).toBeLessThan(log.indexOf('+b'));
    expect(log.indexOf('+c')).toBeLessThan(log.indexOf('-a'));
  });
  it('job com erro não trava a fila', async () => {
    const f = new FilaIntegracao(); let rodou = false;
    await f.enfileirar(1, async () => { throw new Error('x'); }).catch(() => {});
    await f.enfileirar(1, async () => { rodou = true; });
    expect(rodou).toBe(true);
  });
  it('tamanho conta o que está na fila do projeto', async () => {
    const f = new FilaIntegracao();
    const a = f.enfileirar(1, () => wait(20)); const b = f.enfileirar(1, () => wait(1));
    expect(f.tamanho(1)).toBe(2); expect(f.tamanho(2)).toBe(0);
    await Promise.all([a, b]);
    expect(f.tamanho(1)).toBe(0);
  });
});
