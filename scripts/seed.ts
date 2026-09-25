import { createPool } from '../server/db.js';
import { migrate } from '../server/migrations.js';
import { hashPassword } from '../server/auth.js';

// Usuários iniciais pedidos em 2026-09-25. Senha temporária igual para todos; trocar no primeiro uso.
const USERS = [
  { name: 'Danilo', email: 'danilo@bayerlstudio.com.br', role: 'owner', linux_user: 'danilo' },
  { name: 'Laís', email: 'lais@bayerlstudio.com.br', role: 'member', linux_user: 'lais' },
  { name: 'Guilherme', email: 'guilherme@bayerlstudio.com.br', role: 'member', linux_user: 'guilherme' },
] as const;

async function main() {
  const pool = createPool();
  await migrate(pool);
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error('SEED_PASSWORD não definida');
  const hash = await hashPassword(password);
  for (const u of USERS) {
    await pool.query(
      `INSERT INTO users (name, email, role, linux_user, password_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, linux_user = EXCLUDED.linux_user`,
      [u.name, u.email, u.role, u.linux_user, hash]);
    console.log('ok', u.email, u.role);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
