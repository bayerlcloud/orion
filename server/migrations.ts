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
  {
    id: '008_tools_details',
    sql: `
      ALTER TABLE tools ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // Paridade de persistência do esforço com modo/modelo (28/09/2026, follow-up ao vivo do Bayerl —
    // ver PARIDADE.md): até aqui `effort` nunca tinha coluna própria, só era reenviado em cada
    // create/send e resetava pra 'medium' a cada reload/troca de aba. Nullable, sem DEFAULT — mesmo
    // tipo de `model` (não de `permission_mode`, que é NOT NULL DEFAULT): sessão sem esforço
    // explícito escolhido é um estado válido ("sem override", deixa o SDK/conta decidir), não um
    // valor ausente que precisa de um default fixo gravado no banco.
    id: '009_claude_effort',
    sql: `
      ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS effort TEXT;
    `,
  },
  {
    // Painel de skills da "Aba Claude" (ver PARIDADE.md, server/claude/skills.ts): habilitar/
    // desabilitar uma skill descoberta em disco, por projeto. Só guarda OVERRIDES explícitos — uma
    // skill sem linha aqui está habilitada (comportamento de sempre); a linha só existe depois que
    // alguém mexe no toggle pelo menos uma vez. `enabled` nunca é NULL: a ausência da linha já
    // representa "sem override" (mesmo padrão de `claude_sessions.effort`, nullable — aqui a
    // "ausência" é a linha inteira, não um valor nulo dentro dela).
    id: '010_claude_skill_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS claude_skill_settings (
        project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        skill_name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL,
        updated_by INT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, skill_name)
      );
    `,
  },
  {
    // "Aba Claude" — agrupamento de sessões em pastas nomeadas (ver PARIDADE.md, item 12 da seção
    // 13): até aqui `claude_sessions` não tinha nenhum conceito de pasta/grupo manual — só o
    // "Agrupar por Nenhum/Projeto/Atividade" automático e nunca persistido (web/src/claude/mapper.ts
    // `groupSessions`). Tabela nova em vez de só uma coluna: uma pasta tem metadados próprios (nome,
    // quem criou, quando) independentes de qualquer sessão, inclusive pode existir vazia (criada mas
    // sem nada dentro ainda) — uma coluna sozinha em claude_sessions não teria onde guardar isso.
    // `id TEXT` (não SERIAL) pro mesmo padrão de `claude_sessions.id` (gerado com randomUUID() na
    // rota, não pelo Postgres). `created_by` só pra auditoria — grupos são compartilhados entre todos
    // os usuários (mesmo modelo de "caixa compartilhada" que claude_sessions já tem: GET
    // /api/claude/sessions devolve as sessões de TODOS os usuários, sem filtro por dono; ver
    // PARIDADE.md pra essa decisão de escopo). `group_id` em claude_sessions: FK nullable com
    // ON DELETE SET NULL — apagar uma pasta solta as sessões de volta pro nível raiz ("Sem pasta"),
    // nunca apaga a sessão em si.
    id: '011_claude_session_groups',
    sql: `
      CREATE TABLE IF NOT EXISTS claude_session_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES claude_session_groups(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS claude_sessions_group_idx ON claude_sessions (group_id);
    `,
  },
  {
    // Ponte de root do chat (server/claude/rootTool.ts + deploy/root-run.py): cada aprovação de
    // mcp__orion-root__exec vale para UMA execução; o helper marca used_at ao consumir.
    id: '012_claude_approvals_used_at',
    sql: `ALTER TABLE claude_approvals ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;`,
  },
  {
    id: '012_tools_tag',
    sql: `
      ALTER TABLE tools ADD COLUMN IF NOT EXISTS tag TEXT;
    `,
  },
  {
    // Tokens no lugar de US$ (pedido do Danilo, 30/09/2026): total acumulado por sessão, somado a
    // cada result do SDK. cost_usd fica no banco (dado histórico), mas ninguém mais lê nem escreve.
    id: '013_claude_sessions_tokens',
    sql: `
      ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS input_tokens BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0;
    `,
  },
  {
    // Previews ao vivo (spec 2026-09-30-preview-design): user_id nulo = preview raiz do projeto.
    id: '014_previews',
    sql: `
      CREATE TABLE IF NOT EXISTS previews (
        id SERIAL PRIMARY KEY,
        project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        host TEXT NOT NULL UNIQUE,
        port INT NOT NULL UNIQUE,
        worktree_path TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS previews_par ON previews (project_id, COALESCE(user_id, 0));
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
