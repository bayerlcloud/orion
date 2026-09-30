import { describe, expect, it } from 'vitest';
import { quemMexeu, chavesEnv, classificarBancos, envUsadas, resumoDoc, semCredencial, servidorDoIp } from '../server/projetos/coletar.js';

describe('coletor de projetos', () => {
  it('classifica bancos e marca o do config.toml como principal', () => {
    const b = classificarBancos([
      'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co', 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co',
      'https://tm-supabase.bayerl.cloud', 'https://xxx.supabase.co',
    ], 'aaaaaaaaaaaaaaaaaaaa');
    expect(b[0]).toMatchObject({ tipo: 'Supabase nuvem', ref: 'aaaaaaaaaaaaaaaaaaaa', principal: true });
    expect(b.find(x => x.ref === 'tm-supabase')?.tipo).toBe('Supabase self-hosted');
    expect(b).toHaveLength(3);
    expect(classificarBancos(['https://tm-supabase.bayerl.cloud'], null)[0].principal).toBe(true);
  });

  it('lê só nomes de variável, nunca valores', () => {
    expect(chavesEnv('A=1\n# B=2\nexport C="x"\n  D = y')).toEqual(['A', 'C', 'D']);
    const u = envUsadas("import.meta.env.VITE_X\nprocess.env.NODE_ENV\nprocess.env.KEY\nDeno.env.get('SECRET");
    expect(u).toEqual({ app: ['KEY', 'VITE_X'], edge: ['SECRET'] });
  });

  it('resume o doc pulando títulos, listas e código', () => {
    const r = resumoDoc('# Título\n\n1. regra\n\n```\ncode\n```\n\nSistema de X.\n\nSegundo parágrafo.');
    expect(r).toBe('Sistema de X.\n\nSegundo parágrafo.');
  });

  it('tira credencial da URL do remote e reconhece servidor', () => {
    expect(semCredencial('https://user:tok@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(servidorDoIp('212.47.70.170')).toBe('c2');
    expect(servidorDoIp('104.21.64.218')).toBe('Cloudflare');
  });

  it('quem mexeu: pessoa da sessão, autor do git só sem sessão perto', () => {
    const c = { autor: 'Bayerl', quando: '2026-09-30T12:00:00Z', sha: 'abc' };
    expect(quemMexeu(c, { quem: 'Laís', quando: '2026-09-30T11:00:00Z', title: 't' })).toMatchObject({ quem: 'Laís', quando: '2026-09-30T12:00:00.000Z' });
    expect(quemMexeu(c, { quem: 'Laís', quando: '2026-09-29T11:00:00Z', title: 't' })?.quem).toBe('Bayerl (via git)');
    expect(quemMexeu(null, { quem: 'Gustavo', quando: '2026-09-29T11:00:00Z', title: 't' })?.quem).toBe('Gustavo');
    expect(quemMexeu(null, null)).toBeNull();
  });
});
