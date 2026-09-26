import { describe, it, expect } from 'vitest';
import {
  sanitizePhone, extForMime, mimeForExt, validName, validSurname, validTheme, AVATAR_EXTS,
} from '../server/profile/util.js';

describe('sanitizePhone', () => {
  it('mantém dígitos, +, () , - e espaço', () => {
    expect(sanitizePhone('+55 (11) 98888-7777')).toBe('+55 (11) 98888-7777');
  });
  it('remove letras e outros símbolos', () => {
    expect(sanitizePhone('tel: 11 9999_8888 abc')).toBe('11 99998888');
  });
  it('apara espaços das pontas', () => {
    expect(sanitizePhone('   11 2222-3333   ')).toBe('11 2222-3333');
  });
  it('corta em 30 caracteres', () => {
    expect(sanitizePhone('1'.repeat(40)).length).toBe(30);
  });
  it('string vazia continua vazia', () => {
    expect(sanitizePhone('')).toBe('');
    expect(sanitizePhone(null)).toBe('');
    expect(sanitizePhone(undefined)).toBe('');
  });
});

describe('extForMime', () => {
  it('mapeia os MIME aceitos (jpeg vira jpg)', () => {
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/jpg')).toBe('jpg');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('image/gif')).toBe('gif');
  });
  it('aceita maiúsculas e parâmetro de charset', () => {
    expect(extForMime('IMAGE/PNG')).toBe('png');
    expect(extForMime('image/jpeg; charset=binary')).toBe('jpg');
  });
  it('rejeita o que não é imagem suportada', () => {
    expect(extForMime('application/pdf')).toBeNull();
    expect(extForMime('image/svg+xml')).toBeNull();
    expect(extForMime('')).toBeNull();
    expect(extForMime(undefined)).toBeNull();
  });
  it('toda extensão gerada está na lista permitida', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(AVATAR_EXTS).toContain(extForMime(m));
    }
  });
});

describe('mimeForExt', () => {
  it('extensão vira Content-Type', () => {
    expect(mimeForExt('png')).toBe('image/png');
    expect(mimeForExt('jpg')).toBe('image/jpeg');
    expect(mimeForExt('jpeg')).toBe('image/jpeg');
    expect(mimeForExt('webp')).toBe('image/webp');
    expect(mimeForExt('gif')).toBe('image/gif');
  });
  it('desconhecida cai em octet-stream', () => {
    expect(mimeForExt('bmp')).toBe('application/octet-stream');
    expect(mimeForExt('')).toBe('application/octet-stream');
  });
});

describe('validName', () => {
  it('apara e devolve', () => {
    expect(validName('  Ana  ')).toBe('Ana');
  });
  it('vazio lança', () => {
    expect(() => validName('')).toThrow();
    expect(() => validName('   ')).toThrow();
    expect(() => validName(null)).toThrow();
  });
  it('mais de 80 lança', () => {
    expect(() => validName('a'.repeat(81))).toThrow();
    expect(validName('a'.repeat(80)).length).toBe(80);
  });
});

describe('validSurname', () => {
  it('opcional: ausente/vazio vira null', () => {
    expect(validSurname(undefined)).toBeNull();
    expect(validSurname(null)).toBeNull();
    expect(validSurname('   ')).toBeNull();
  });
  it('apara quando tem valor', () => {
    expect(validSurname('  Souza ')).toBe('Souza');
  });
  it('mais de 80 lança', () => {
    expect(() => validSurname('b'.repeat(81))).toThrow();
  });
});

describe('validTheme', () => {
  it('aceita dark e light', () => {
    expect(validTheme('dark')).toBe('dark');
    expect(validTheme('light')).toBe('light');
  });
  it('rejeita qualquer outro valor', () => {
    expect(() => validTheme('escuro')).toThrow();
    expect(() => validTheme('')).toThrow();
    expect(() => validTheme(undefined)).toThrow();
  });
});
