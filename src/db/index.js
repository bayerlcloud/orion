import Database from 'better-sqlite3'
import { applySchema } from './schema.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '../../data/memory.db')

let _db = null

function repairFts(db) {
  try {
    db.prepare("INSERT INTO memories_fts(memories_fts) VALUES(?)").run('integrity-check')
  } catch (err) {
    // FTS corrompida — dropa e recria
    try {
      db.exec(`
        DROP TABLE IF EXISTS memories_fts;
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories;
      `)
    } catch (_e) {
      // ignora falha no repair para não travar o boot
    }
  }
}

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH)
    // Pragmas de resiliência (antes do schema)
    _db.pragma('journal_mode = WAL')
    _db.pragma('wal_autocheckpoint = 100')
    _db.pragma('foreign_keys = ON')
    _db.pragma('busy_timeout = 5000')
    applySchema(_db)
    repairFts(_db)
  }
  return _db
}
