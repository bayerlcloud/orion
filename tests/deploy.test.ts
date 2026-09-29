import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  escreverPedido, lerHistorico, lerStatus, limparPor, nomeDeBuildValido, ordenarHistorico, parseStatus, pedidoPendente, statusEfetivo, validarRef, versaoNoAr,
} from '../server/deploy/estado';

describe('validação', () => {
  it('ref só main ou sha', () => {
    expect(validarRef(undefined)).toBe('main');
    expect(validarRef(' main ')).toBe('main');
    expect(validarRef('690B817ABC')).toBe('690b817abc');
    expect(validarRef('feature/x; rm -rf /')).toBeNull();
    expect(validarRef('HEAD~1')).toBeNull();
  });
  it('nome de quem pediu sai limpo', () => {
    expect(limparPor('Danilo')).toBe('Danilo');
    expect(limparPor('x"; echo `id`')).toBe('x echo id');
    expect(limparPor('')).toBe('painel');
    expect(limparPor('a'.repeat(80)).length).toBe(40);
  });
  it('nome de build', () => {
    expect(nomeDeBuildValido('690b817abc-20260929-140501')).toBe(true);
    expect(nomeDeBuildValido('../etc')).toBe(false);
  });
});

describe('status', () => {
  it('parse tolerante e build travado vira falhou', () => {
    expect(parseStatus('nada')).toBeNull();
    expect(parseStatus('{"estado":"zzz"}')).toBeNull();
    const s = parseStatus('{"estado":"rodando","etapa":"testes","sha":"abc","inicio":"2026-09-29T10:00:00Z"}')!;
    expect(s.msg).toBe('');
    expect(statusEfetivo(s, Date.parse('2026-09-29T10:30:00Z'))!.estado).toBe('rodando');
    expect(statusEfetivo(s, Date.parse('2026-09-29T10:50:00Z'))!.estado).toBe('falhou');
    expect(statusEfetivo(parseStatus('{"estado":"ok","inicio":"2026-09-29T10:00:00Z"}'), Date.parse('2026-12-01T00:00:00Z'))!.estado).toBe('ok');
  });
  it('histórico mais novo primeiro', () => {
    const a = parseStatus('{"estado":"ok","inicio":"2026-09-29T10:00:00Z","fim":"2026-09-29T10:05:00Z"}')!;
    const b = parseStatus('{"estado":"falhou","inicio":"2026-09-29T11:00:00Z","fim":"2026-09-29T11:02:00Z"}')!;
    expect(ordenarHistorico([a, b])[0]).toBe(b);
  });
});

describe('disco', () => {
  it('pedido, status, histórico e versão no ar', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'builds-'));
    try {
      expect(await pedidoPendente(dir)).toBeNull();
      await escreverPedido('main', 'Danilo', dir);
      expect(JSON.parse(await readFile(path.join(dir, 'pedido.json'), 'utf8'))).toMatchObject({ ref: 'main', por: 'Danilo' });
      expect((await pedidoPendente(dir))?.por).toBe('Danilo');
      expect(await lerStatus(dir)).toBeNull();
      await writeFile(path.join(dir, 'status.json'), '{"estado":"ok","etapa":"no ar","sha":"abc","inicio":"2026-09-29T10:00:00Z","fim":"2026-09-29T10:03:00Z","nome":"abc1234567-20260929-100000"}');
      expect((await lerStatus(dir))?.estado).toBe('ok');
      await writeFile(path.join(dir, 'abc1234567-20260929-100000.json'), '{"estado":"ok","inicio":"2026-09-29T10:00:00Z","fim":"2026-09-29T10:03:00Z","nome":"abc1234567-20260929-100000"}');
      await writeFile(path.join(dir, 'lixo.json'), '{}');
      expect((await lerHistorico(dir)).map(h => h.nome)).toEqual(['abc1234567-20260929-100000']);
      const link = path.join(dir, 'live');
      await symlink(path.join(dir, 'abc1234567-20260929-100000'), link);
      expect(await versaoNoAr(link)).toBe('abc1234567-20260929-100000');
      const link2 = path.join(dir, 'live2');
      await symlink('/srv/orion', link2);
      expect(await versaoNoAr(link2)).toBe('repo (orion)');
      expect(await versaoNoAr(path.join(dir, 'nao-existe'))).toBe('?');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
