import { describe, it, expect } from 'vitest';
import { RESUME_PROMPT, NAO_RETOMADA, shouldResume, notaDeploy, DEPLOY_OK_MARCA } from '../server/routes/claude';
import { DEPLOY_OK_MARCA as MARCA_WEB } from '../web/src/claude/mapper';
import type { Status } from '../server/deploy/estado';

describe('retomada pós-restart', () => {
  const now = new Date('2026-09-29T04:00:00Z');
  it('retoma turno normal cortado', () => expect(shouldResume('[Danilo] faz tudo', new Date(now.getTime() - 60_000), now)).toBe(true));
  it('não retoma de novo uma retomada recente (loop de restart)', () => expect(shouldResume(`[Orion] ${RESUME_PROMPT}`, new Date(now.getTime() - 60_000), now)).toBe(false));
  it('retomada antiga pode retomar outra vez', () => expect(shouldResume(`[Orion] ${RESUME_PROMPT}`, new Date(now.getTime() - 11 * 60_000), now)).toBe(true));
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
