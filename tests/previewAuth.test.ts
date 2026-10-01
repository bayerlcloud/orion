import { describe, it, expect } from 'vitest';
import { assinar, verificar, consumirUmaVez, checarCookie, LOGIN_URL, podeAbrir, urlEntrar, publicoAtivo, proximoPainel } from '../server/preview/auth';

const S = 'segredo-de-teste';

describe('preview auth', () => {
  it('token vale só no host e no prazo', () => {
    const t = assinar({ u: 1, h: 'danilo.fisio.bayerl.cloud', exp: 1000 }, S);
    expect(verificar(t, 'danilo.fisio.bayerl.cloud', S, 999)).toEqual({ u: 1 });
    expect(verificar(t, 'lais.fisio.bayerl.cloud', S, 999)).toBeNull();
    expect(verificar(t, 'danilo.fisio.bayerl.cloud', S, 1001)).toBeNull();
    expect(verificar(t + 'x', 'danilo.fisio.bayerl.cloud', S, 999)).toBeNull();
    expect(verificar(t, 'danilo.fisio.bayerl.cloud', 'outro-segredo', 999)).toBeNull();
    expect(verificar('lixo', 'danilo.fisio.bayerl.cloud', S, 999)).toBeNull();
  });
  it('uso único', () => {
    const exp = Date.now() + 60_000;
    expect(consumirUmaVez('abc', exp)).toBe(true);
    expect(consumirUmaVez('abc', exp)).toBe(false);
  });
  it('checarCookie: sem cookie, de outro host ou vencido redireciona; certo passa', () => {
    const agora = 5000;
    const bom = assinar({ u: 2, h: 'lais.ralab.bayerl.cloud', exp: 9000 }, S);
    expect(checarCookie(undefined, 'lais.ralab.bayerl.cloud', S, agora)).toEqual({ ok: false, redirect: LOGIN_URL });
    expect(checarCookie(bom, 'danilo.ralab.bayerl.cloud', S, agora)).toEqual({ ok: false, redirect: LOGIN_URL });
    expect(checarCookie(bom, 'lais.ralab.bayerl.cloud', S, 9001)).toEqual({ ok: false, redirect: LOGIN_URL });
    expect(checarCookie(bom, 'lais.ralab.bayerl.cloud', S, agora)).toEqual({ ok: true, u: 2 });
  });
  it('segredo vazio nunca aceita (cookie forjado com chave vazia)', () => {
    const forjado = assinar({ u: 1, h: 'x.bayerl.cloud', exp: 9e15 }, '');
    expect(checarCookie(forjado, 'x.bayerl.cloud', '', 1)).toEqual({ ok: false, redirect: LOGIN_URL });
    expect(verificar(forjado, 'x.bayerl.cloud', '', 1)).toBeNull();
  });
});

describe('podeAbrir', () => {
  it('raiz pública abre sem cookie; pessoal nunca; cookie válido sempre', () => {
    expect(podeAbrir({ ehRaiz: true, publico: true, cookieOk: false })).toBe(true);
    expect(podeAbrir({ ehRaiz: true, publico: false, cookieOk: false })).toBe(false);
    expect(podeAbrir({ ehRaiz: false, publico: true, cookieOk: false })).toBe(false);
    expect(podeAbrir({ ehRaiz: false, publico: false, cookieOk: true })).toBe(true);
    expect(podeAbrir({ ehRaiz: true, publico: false, cookieOk: true })).toBe(true);
  });
  it('urlEntrar leva o host para o painel', () => {
    expect(urlEntrar('fisioexpert.bayerl.cloud')).toBe('https://orion.bayerl.cloud/api/preview/entrar?host=fisioexpert.bayerl.cloud');
  });
  it('com um painel só, entrar vai direto para o login', () => {
    expect(proximoPainel('orion.bayerl.cloud', '')).toBeNull();
  });
});

describe('publicoAtivo', () => {
  it('só vale antes do prazo; sem prazo é desligado', () => {
    const agora = Date.parse('2026-10-01T12:00:00Z');
    expect(publicoAtivo('2026-10-03T12:00:00Z', agora)).toBe(true);
    expect(publicoAtivo('2026-10-01T11:59:59Z', agora)).toBe(false);
    expect(publicoAtivo(null, agora)).toBe(false);
    expect(publicoAtivo('lixo', agora)).toBe(false);
  });
});
