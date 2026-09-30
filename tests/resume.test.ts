import { describe, it, expect } from 'vitest';
import { RESUME_PROMPT, NAO_RETOMADA, VIGIA_PROMPT, shouldResume, notaDeploy, DEPLOY_OK_MARCA } from '../server/routes/claude';
import { DEPLOY_OK_MARCA as MARCA_WEB } from '../web/src/claude/mapper';
import type { Status } from '../server/deploy/estado';

describe('retomada automática', () => {
  const now = new Date('2026-09-29T04:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const auto = (min: number) => ({ prompt: `[Orion] ${RESUME_PROMPT}`, ts: ago(min) });
  it('retoma turno normal cortado', () => expect(shouldResume([{ prompt: '[Danilo] faz tudo', ts: ago(1) }], now)).toBe(true));
  it('retoma de novo logo depois de uma retomada (sessão que publica duas vezes seguidas)', () => expect(shouldResume([auto(1), { prompt: '[Danilo] x', ts: ago(5) }], now)).toBe(true));
  it('para depois de 3 retomadas automáticas seguidas (loop)', () => expect(shouldResume([auto(1), auto(3), auto(5)], now)).toBe(false));
  it('vigia conta junto', () => expect(shouldResume([{ prompt: `[Orion] ${VIGIA_PROMPT('overloaded')}`, ts: ago(1) }, auto(3), auto(5)], now)).toBe(false));
  it('o botão "Continuar de onde parou" de gente zera a conta', () => expect(shouldResume([auto(1), auto(2), { prompt: '[Danilo] Continue de onde parou.', ts: ago(3) }, auto(4)], now)).toBe(true));
  it('retomadas antigas (> 30 min) não contam', () => expect(shouldResume([auto(1), auto(2), auto(40)], now)).toBe(true));
});

describe('sessão não retomada fica visível', () => {
  it('a mensagem gravada tem o trecho que a Timeline usa pra oferecer "Continuar de onde parou"', () => {
    expect(NAO_RETOMADA).toContain('não retomado automaticamente');
  });
});

describe('retomada conta o resultado da publicação', () => {
  const now = new Date('2026-09-30T13:45:00Z');
  const base: Status = { estado: 'ok', etapa: 'publicado x', sha: 'abc1234', msg: 'feat: y', ref: 'main', nome: 'abc1234-20260930-134344', por: 'Danilo', inicio: '2026-09-30T13:43:44Z', fim: '2026-09-30T13:44:10Z', log: '/srv/builds/x.log', anterior: 'old' };
  it('deu certo: traz a marca que a Timeline procura', () => {
    expect(notaDeploy(base, now)).toContain(DEPLOY_OK_MARCA);
    expect(DEPLOY_OK_MARCA).toBe(MARCA_WEB);
  });
  it('falhou: avisa e traz o fim do log', () => {
    const n = notaDeploy({ ...base, estado: 'falhou', etapa: 'falhou em: testes' }, now, 'FAIL tests/x');
    expect(n).toContain('FALHOU'); expect(n).toContain('FAIL tests/x'); expect(n).not.toContain(DEPLOY_OK_MARCA);
  });
  it('deploy antigo ou inexistente: nada', () => {
    expect(notaDeploy(null, now)).toBe('');
    expect(notaDeploy(base, new Date('2026-09-30T14:30:00Z'))).toBe('');
  });
  it('ainda rodando: manda conferir', () => expect(notaDeploy({ ...base, estado: 'rodando', fim: null }, now)).toContain('em andamento'));
});
