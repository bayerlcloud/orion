export function applySchema(db) {
  db.exec(`
    -- ── Memórias (core) ───────────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      type        TEXT NOT NULL DEFAULT 'raw',
      -- raw | episodic | semantic | skill
      content     TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'unknown',
      -- whatsapp | plugin | cron | vault | neo
      confidence  REAL NOT NULL DEFAULT 0.1,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata    TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type       ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed   ON memories(last_accessed DESC);

    -- FTS5 para busca lexical (BM25)
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;

    -- ── Entidades (Mem0-style) ──────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS entities (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      -- person | project | tool | pet | place | concept | credential
      description TEXT,
      confidence  REAL NOT NULL DEFAULT 0.8,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(name, type)
    );

    -- ── Relações (knowledge graph leve) ───────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS relations (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      subject     TEXT NOT NULL,
      relation    TEXT NOT NULL,
      -- has_pet | uses | works_on | prefers | is_a | belongs_to | knows
      object      TEXT NOT NULL,
      confidence  REAL NOT NULL DEFAULT 0.8,
      source      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(subject, relation, object)
    );

    CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject);
    CREATE INDEX IF NOT EXISTS idx_relations_object  ON relations(object);

    -- ── Skills ──────────────────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS skills (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      content     TEXT NOT NULL,
      vault_path  TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      confidence  REAL NOT NULL DEFAULT 0.5,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Cron jobs ─────────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name        TEXT NOT NULL,
      description TEXT,
      schedule    TEXT NOT NULL,
      task_prompt TEXT NOT NULL,
      tools       TEXT NOT NULL DEFAULT '[]',
      status      TEXT NOT NULL DEFAULT 'active',
      -- active | paused | deleted
      last_run    INTEGER,
      next_run    INTEGER,
      run_count   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by  TEXT NOT NULL DEFAULT 'orion'
    );

    -- ── Sessões ──────────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      channel           TEXT NOT NULL,
      -- whatsapp | plugin | chat_ui | neo | cron
      jid               TEXT,
      claude_session_id TEXT,
      title             TEXT,
      message_count     INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      last_active       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_jid     ON sessions(jid);
    CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel);

    -- ── Mensagens ─────────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL,
      -- user | assistant
      content     TEXT NOT NULL,
      channel     TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  `)

  // ── Sessões Claude Code (index do filesystem) ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_sessions (
      id           TEXT PRIMARY KEY,
      path         TEXT NOT NULL,
      cwd          TEXT NOT NULL DEFAULT '/config/workspace',
      custom_title TEXT,
      ai_title     TEXT,
      last_modified INTEGER,
      message_count INTEGER DEFAULT 0,
      first_user_msg TEXT,
      indexed_at   INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_cs_modified ON claude_sessions(last_modified DESC);
  `)

  // Migrações aditivas (ALTER TABLE é seguro dentro de try/catch)
  // ── Session Registry (sessões nomeadas visíveis no plugin) ────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_registry (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name              TEXT NOT NULL,
      project           TEXT,
      role              TEXT DEFAULT 'executor',
      claude_session_id TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER,
      closed_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sr_name    ON session_registry(name);
    CREATE INDEX IF NOT EXISTS idx_sr_project ON session_registry(project);
    CREATE INDEX IF NOT EXISTS idx_sr_status  ON session_registry(status);
  `)

  // ── Projects (registry de projetos conhecidos) ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name        TEXT NOT NULL UNIQUE,
      slug        TEXT NOT NULL UNIQUE,
      path        TEXT NOT NULL,
      claude_md   TEXT,
      dev_port    INTEGER,
      subdomain   TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  // Seed de projetos (adaptar ao seu ambiente)
  const knownProjects = [
    { name: 'Brandspace',       slug: 'brandspace',      path: process.env.WORKSPACE_DIR ? process.env.WORKSPACE_DIR+'/brandspace'      : '/config/workspace/brandspace',      claude_md: null, dev_port: 8080 },
    { name: 'TrackingMachine',  slug: 'trackingmachine', path: process.env.WORKSPACE_DIR ? process.env.WORKSPACE_DIR+'/trackingmachine' : '/config/workspace/trackingmachine', claude_md: null, dev_port: 8081 },
    { name: 'Ralab',            slug: 'ralab',           path: process.env.WORKSPACE_DIR ? process.env.WORKSPACE_DIR+'/ralab'           : '/config/workspace/ralab',           claude_md: null, dev_port: 8082 },
    { name: 'FisioExpert',      slug: 'fisioexpert',     path: process.env.WORKSPACE_DIR ? process.env.WORKSPACE_DIR+'/fisioexpert'     : '/config/workspace/fisioexpert',     claude_md: null, dev_port: 8083 },
    { name: 'ABCPrime',         slug: 'abcprime',        path: process.env.WORKSPACE_DIR ? process.env.WORKSPACE_DIR+'/abcprime'        : '/config/workspace/abcprime',        claude_md: null, dev_port: 8084 },
    { name: 'Orion',            slug: 'orion',           path: process.env.WORKSPACE_DIR ? process.env.WORKSPACE_DIR+'/orion'           : '/config/workspace/orion',           claude_md: null, dev_port: 8088 },
  ]
  const upsertProject = db.prepare(`
    INSERT INTO projects (name, slug, path, claude_md, dev_port)
    VALUES (@name, @slug, @path, @claude_md, @dev_port)
    ON CONFLICT(slug) DO NOTHING
  `)
  for (const p of knownProjects) {
    try { upsertProject.run(p) } catch (_e) {}
  }

  const migrations = [
    `ALTER TABLE messages ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE sessions ADD COLUMN context_summary TEXT`,
    `ALTER TABLE claude_sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE claude_sessions ADD COLUMN deleted_at INTEGER`,
    // Feedback loop de confiança
    `ALTER TABLE memories ADD COLUMN helpful_votes INT DEFAULT 0`,
    `ALTER TABLE memories ADD COLUMN unhelpful_votes INT DEFAULT 0`,
    `ALTER TABLE memories ADD COLUMN user_corrected INT DEFAULT 0`,
    // Soft delete
    `ALTER TABLE memories ADD COLUMN archived INT NOT NULL DEFAULT 0`,
    // Tags e categoria
    `ALTER TABLE memories ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`,
    // Provenance — rastreabilidade de origem
    `ALTER TABLE memories ADD COLUMN source_channel TEXT`,
    `ALTER TABLE memories ADD COLUMN source_session_id TEXT`,
    `ALTER TABLE memories ADD COLUMN source_tool TEXT`,
    // Skill lifecycle — active | stale | archived
    `ALTER TABLE skills ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE skills ADD COLUMN last_used_at INTEGER`,
    // Forgetting schedule (SM-2 spaced repetition)
    `ALTER TABLE memories ADD COLUMN next_review_at INTEGER`,
    `ALTER TABLE memories ADD COLUMN review_interval_days INTEGER DEFAULT 1`,
    `ALTER TABLE memories ADD COLUMN review_ease REAL DEFAULT 2.5`,
    // Concept drift / version history
    `ALTER TABLE memories ADD COLUMN previous_content TEXT`,
    `ALTER TABLE memories ADD COLUMN version_count INTEGER DEFAULT 1`,
    `ALTER TABLE memories ADD COLUMN superseded_by TEXT`,
    `ALTER TABLE memories ADD COLUMN supersedes TEXT`,
    // Sessões abertas persistidas no banco (em vez de localStorage)
    `ALTER TABLE claude_sessions ADD COLUMN opened_at INTEGER`,
    // Último papel que respondeu: 'user' | 'assistant'
    `ALTER TABLE claude_sessions ADD COLUMN last_msg_role TEXT`,
    // Rascunho persistido no banco
    `ALTER TABLE claude_sessions ADD COLUMN draft_text TEXT`,
    `ALTER TABLE claude_sessions ADD COLUMN draft_files TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE claude_sessions ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0`,
    // Propriedade de sessão: quem criou, visibilidade, último ator
    `ALTER TABLE claude_sessions ADD COLUMN created_by INTEGER`,
    `ALTER TABLE claude_sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'personal'`,
    `ALTER TABLE claude_sessions ADD COLUMN last_actor INTEGER`,
    `ALTER TABLE claude_sessions ADD COLUMN last_actor_at INTEGER`,
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch (_e) { /* coluna já existe, ignora */ }
  }

  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_active ON messages(session_id, active, created_at)`) } catch (_e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_archived  ON memories(archived)`) } catch (_e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_category  ON memories(category)`) } catch (_e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_banks (
      category    TEXT PRIMARY KEY,
      sample_count INT DEFAULT 0,
      top_memories TEXT DEFAULT '[]',
      updated_at  INT DEFAULT (unixepoch())
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_versions (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      memory_id   TEXT NOT NULL,
      content     TEXT NOT NULL,
      confidence  REAL NOT NULL,
      snapshot_at INTEGER NOT NULL DEFAULT (unixepoch()),
      reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fv_memory ON fact_versions(memory_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_questions (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      question    TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'general',
      context     TEXT,
      answered    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      answered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pq_answered ON proactive_questions(answered, created_at);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_calibration (
      id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      confidence_low REAL NOT NULL,
      confidence_hi  REAL NOT NULL,
      predicted_avg  REAL NOT NULL,
      actual_accuracy REAL NOT NULL,
      sample_count   INTEGER NOT NULL,
      computed_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS co_retrievals (
      id_a    TEXT NOT NULL,
      id_b    TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 1,
      last_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (id_a, id_b)
    );
    CREATE INDEX IF NOT EXISTS idx_co_a ON co_retrievals(id_a, count DESC);
    CREATE INDEX IF NOT EXISTS idx_co_b ON co_retrievals(id_b, count DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS drift_log (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      memory_id   TEXT NOT NULL,
      old_content TEXT NOT NULL,
      new_content TEXT NOT NULL,
      distance    REAL NOT NULL,
      detected_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_drift_mem  ON drift_log(memory_id);
    CREATE INDEX IF NOT EXISTS idx_drift_time ON drift_log(detected_at DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS tier2_summaries (
      category    TEXT PRIMARY KEY,
      summary     TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS tier3_narratives (
      theme       TEXT PRIMARY KEY,
      narrative   TEXT NOT NULL,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_events (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      memory_id   TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      -- absolute | month_year | relative | connective
      event_text  TEXT,
      epoch       INTEGER,
      precision   TEXT,
      -- day | month | year | week
      relation    TEXT
      -- before | after | during | concurrent | immediately_after
    );
    CREATE INDEX IF NOT EXISTS idx_te_memory ON temporal_events(memory_id);
    CREATE INDEX IF NOT EXISTS idx_te_epoch  ON temporal_events(epoch);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_te_uniq ON temporal_events(memory_id, event_type, event_text);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS contradiction_queue (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      memory_id_a   TEXT NOT NULL,
      memory_id_b   TEXT NOT NULL,
      content_a     TEXT NOT NULL,
      content_b     TEXT NOT NULL,
      question      TEXT NOT NULL,
      score         REAL NOT NULL DEFAULT 0,
      resolved      INTEGER NOT NULL DEFAULT 0,
      resolved_at   INTEGER,
      resolution    TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_cq_resolved ON contradiction_queue(resolved, score DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS causal_links (
      id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      cause               TEXT NOT NULL,
      effect              TEXT NOT NULL,
      confidence          REAL NOT NULL DEFAULT 0.6,
      evidence_memory_id  TEXT,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(cause, effect)
    );
    CREATE INDEX IF NOT EXISTS idx_cl_cause  ON causal_links(cause);
    CREATE INDEX IF NOT EXISTS idx_cl_effect ON causal_links(effect);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_bundles (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name          TEXT NOT NULL UNIQUE,
      description   TEXT,
      skill_names   TEXT NOT NULL DEFAULT '[]',
      trigger_words TEXT NOT NULL DEFAULT '[]',
      usage_count   INTEGER NOT NULL DEFAULT 0,
      last_used_at  INTEGER,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_co_usage (
      skill_a   TEXT NOT NULL,
      skill_b   TEXT NOT NULL,
      co_count  INTEGER NOT NULL DEFAULT 1,
      last_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (skill_a, skill_b)
    );
    CREATE INDEX IF NOT EXISTS idx_scu_a ON skill_co_usage(skill_a, co_count DESC);
    CREATE INDEX IF NOT EXISTS idx_scu_b ON skill_co_usage(skill_b, co_count DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_session_usage (
      skill_name  TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      used_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (skill_name, session_id)
    )
  `)

  const skillDepMigrations = [
    `ALTER TABLE skills ADD COLUMN requires_skills TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE skills ADD COLUMN conflicts_with TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE skills ADD COLUMN absorbed_into TEXT`,
    `ALTER TABLE skills ADD COLUMN source TEXT DEFAULT 'manual'`,
  ]
  for (const sql of skillDepMigrations) {
    try { db.exec(sql) } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_suggestions (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name              TEXT NOT NULL UNIQUE,
      schedule          TEXT NOT NULL,
      task_prompt       TEXT NOT NULL,
      rationale         TEXT,
      source_session_id TEXT,
      activated         INTEGER NOT NULL DEFAULT 0,
      activated_at      INTEGER,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_cs_activated ON cron_suggestions(activated, created_at DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_patterns (
      id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      pattern              TEXT NOT NULL,
      user_message_snippet TEXT,
      session_id           TEXT,
      memory_id            TEXT,
      synthesized          INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_tp_pattern ON task_patterns(pattern, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tp_synth   ON task_patterns(synthesized);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS dedup_queue (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      id_a             TEXT NOT NULL,
      content_a        TEXT NOT NULL,
      id_b             TEXT NOT NULL,
      content_b        TEXT NOT NULL,
      cosine_sim       REAL NOT NULL DEFAULT 0,
      lev_distance     REAL NOT NULL DEFAULT 0,
      question_sent_at INTEGER,
      resolved         INTEGER NOT NULL DEFAULT 0,
      vote             TEXT,
      resolved_at      INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(id_a, id_b)
    );
    CREATE INDEX IF NOT EXISTS idx_dq_resolved ON dedup_queue(resolved, cosine_sim DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_rejections (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      skill_name      TEXT NOT NULL,
      context         TEXT,
      suggestion      TEXT,
      user_correction TEXT,
      approved        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_sr_skill ON skill_rejections(skill_name, created_at DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_patches (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      skill_name      TEXT NOT NULL,
      failure_pattern TEXT,
      edge_case       TEXT,
      patch_text      TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_sp_skill ON skill_patches(skill_name, created_at DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_snapshots (
      id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      session_id     TEXT NOT NULL,
      snapshot_epoch INTEGER NOT NULL,
      memory_id      TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      confidence     REAL NOT NULL,
      category       TEXT,
      type           TEXT,
      UNIQUE(session_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ms_memory  ON memory_snapshots(memory_id, snapshot_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_ms_epoch   ON memory_snapshots(snapshot_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_ms_session ON memory_snapshots(session_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS improvements (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      mechanism   TEXT NOT NULL DEFAULT 'geral',
      note        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'aberto',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_imp_status ON improvements(status, created_at DESC);
  `)

  const sessionLineageMigrations = [
    `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN archived_session INTEGER NOT NULL DEFAULT 0`,
  ]
  for (const sql of sessionLineageMigrations) {
    try { db.exec(sql) } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_output (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      job_id     TEXT NOT NULL REFERENCES cron_jobs(id),
      ran_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      status     TEXT NOT NULL,
      output     TEXT,
      error      TEXT,
      model_used TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_output_job ON cron_output(job_id, ran_at DESC);
  `)
  const cronAdvancedMigrations = [
    `ALTER TABLE cron_jobs ADD COLUMN script TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN no_agent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE cron_jobs ADD COLUMN model TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN context_from TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE cron_jobs ADD COLUMN last_output TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN last_status TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN skip_if_recent INTEGER`,
    `ALTER TABLE cron_jobs ADD COLUMN repeat_n INTEGER`,
    `ALTER TABLE cron_jobs ADD COLUMN target_session TEXT`,
  ]
  for (const sql of cronAdvancedMigrations) {
    try { db.exec(sql) } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL DEFAULT (unixepoch()),
      jid               TEXT,
      session_id        TEXT,
      model             TEXT,
      was_trivial       INTEGER NOT NULL DEFAULT 0,
      input_chars       INTEGER NOT NULL DEFAULT 0,
      output_chars      INTEGER NOT NULL DEFAULT 0,
      est_input_tokens  INTEGER,
      est_output_tokens INTEGER,
      est_cost_usd      REAL,
      channel           TEXT,
      duration_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_call_log_ts ON call_log(ts DESC);
  `)

  const cronH5Migrations = [
    `ALTER TABLE cron_jobs ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'cron'`,
    `ALTER TABLE cron_jobs ADD COLUMN interval_minutes INTEGER`,
    `ALTER TABLE cron_jobs ADD COLUMN fire_at INTEGER`,
    `ALTER TABLE cron_jobs ADD COLUMN deliver TEXT NOT NULL DEFAULT 'whatsapp'`,
    `ALTER TABLE cron_jobs ADD COLUMN origin TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN workdir TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN last_delivery_error TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN state TEXT NOT NULL DEFAULT 'scheduled'`,
    `ALTER TABLE cron_jobs ADD COLUMN paused_at INTEGER`,
    `ALTER TABLE cron_jobs ADD COLUMN paused_reason TEXT`,
    `ALTER TABLE cron_jobs ADD COLUMN next_run INTEGER`,
    `ALTER TABLE cron_jobs ADD COLUMN inject_defense INTEGER NOT NULL DEFAULT 1`,
  ]
  for (const sql of cronH5Migrations) {
    try { db.exec(sql) } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      goal         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'planning',
      -- planning | running | done | failed
      board_name   TEXT,
      board_id     TEXT,
      plan         TEXT NOT NULL DEFAULT '[]',
      result       TEXT,
      source       TEXT NOT NULL DEFAULT 'api',
      -- api | whatsapp | cron
      session_id   TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at   INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, created_at DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestrations (
      id           TEXT PRIMARY KEY,
      goal         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      steps        TEXT NOT NULL DEFAULT '[]',
      result       TEXT,
      error        TEXT,
      work_dir     TEXT,
      source       TEXT NOT NULL DEFAULT 'api',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orch_status ON orchestrations(status, created_at DESC);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_boards (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name       TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS kanban_tasks (
      id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      board_id     TEXT NOT NULL REFERENCES kanban_boards(id),
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      priority     INTEGER NOT NULL DEFAULT 0,
      depends_on   TEXT NOT NULL DEFAULT '[]',
      assigned_to  TEXT,
      result       TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at   INTEGER,
      completed_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_board ON kanban_tasks(board_id, status);
    CREATE TABLE IF NOT EXISTS kanban_workers (
      id           TEXT PRIMARY KEY,
      board_id     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'idle',
      current_task TEXT,
      last_beat    INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      question    TEXT NOT NULL,
      context     TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      answer      TEXT,
      source      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      answered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS autonomous_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      description TEXT NOT NULL,
      undo_kind   TEXT,
      undo_data   TEXT,
      undone      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_auto_actions ON autonomous_actions(undone, created_at DESC);

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL DEFAULT '',
      email         TEXT,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'collaborator' CHECK(role IN ('owner','collaborator')),
      avatar_color  TEXT NOT NULL DEFAULT '#6366f1',
      is_active     INTEGER NOT NULL DEFAULT 1,
      notes         TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER REFERENCES users(id),
      username     TEXT NOT NULL,
      method       TEXT NOT NULL,
      path         TEXT NOT NULL,
      ip           TEXT,
      status_code  INTEGER,
      duration_ms  INTEGER,
      body_summary TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS collab_tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
      priority     TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
      due_date     INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by   INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_collab_tasks_user ON collab_tasks(user_id, status);

    CREATE TABLE IF NOT EXISTS user_permissions (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource TEXT NOT NULL,
      allowed  INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id, resource)
    );
  `)

  try { db.exec(`ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id)`) } catch {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN input_tokens INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN output_tokens INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN last_assessment TEXT`) } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN last_assessment_at INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN token_budget_monthly INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN tokens_this_month INTEGER DEFAULT 0`) } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN budget_notified_at INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN whatsapp_jid TEXT`) } catch {}
}
