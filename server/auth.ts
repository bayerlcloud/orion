import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;
const KEYLEN = 64;

/** Formato armazenado: scrypt$<salt hex>$<hash hex> */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('senha vazia');
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hex] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionId(): string {
  return randomBytes(32).toString('hex');
}

export const SESSION_COOKIE = 'orion_session';
export const SESSION_TTL_DAYS = 30;
