import type { Pool } from 'pg';

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        linux_user TEXT,
        role TEXT NOT NULL CHECK (role IN ('owner','member')),
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logins (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip TEXT,
        user_agent TEXT
      );
    `,
  },
  {
    id: '002_drive',
    sql: `
      CREATE TABLE IF NOT EXISTS drive_files (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        size BIGINT NOT NULL DEFAULT 0,
        mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        path TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS drive_files_user_created_idx ON drive_files (user_id, created_at DESC);
    `,
  },
  {
    id: '003_claude',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        rules TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS claude_sessions (
        id TEXT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        project_id INT REFERENCES projects(id),
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
        status TEXT NOT NULL DEFAULT 'idle',
        cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        turns INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS claude_sessions_updated ON claude_sessions (updated_at DESC);
      CREATE TABLE IF NOT EXISTS claude_events (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
        seq INT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS claude_approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES claude_sessions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input JSONB NOT NULL,
        decision TEXT,
        decided_by INT REFERENCES users(id),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at TIMESTAMPTZ
      );
      INSERT INTO projects (slug, name, path, rules) VALUES ('orion', 'Orion (este sistema)', '/srv/orion', NULL)
        ON CONFLICT (slug) DO NOTHING;
    `,
  },
  {
    id: '004_inventory',
    sql: `
      CREATE TABLE IF NOT EXISTS inventory_snapshots (
        id SERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inventory_snapshots_ts_idx ON inventory_snapshots (ts DESC, id DESC);
    `,
  },
  {
    id: '005_tools',
    sql: `
      CREATE TABLE IF NOT EXISTS tools (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('tool','skill','mcp')),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '⚙️',
        status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo')),
        link TEXT,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS tools_kind_idx ON tools (kind, name);
    `,
  },
  {
    id: '006_claude_ui_state',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_open_tabs JSONB NOT NULL DEFAULT '[]';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_active_session TEXT;
    `,
  },
  {
    id: '007_explorer_ui_state',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS explorer_expanded_keys JSONB;
    `,
  },
];

export async function migrate(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const m of MIGRATIONS) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [m.id]);
    if (rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
