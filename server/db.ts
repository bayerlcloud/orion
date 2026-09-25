import pg from 'pg';

export function createPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

export type User = { id: number; name: string; email: string; role: 'owner' | 'member'; linux_user: string | null };
