// Script de migração: seta o owner inicial como created_by e last_actor
// de todas as claude_sessions que não têm owner definido.
//
// Uso: node scripts/set-session-owner.mjs

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const Database = require('better-sqlite3')
const dbPath = path.join(__dirname, '../data/memory.db')
const db = new Database(dbPath)

const ownerUsername = process.env.OWNER_USERNAME || 'admin'
const existing = db.prepare('SELECT id, username FROM users WHERE username=?').get(ownerUsername)
if (!existing) {
  console.error(`Usuário "${ownerUsername}" não encontrado. Rode o servidor uma vez para criar o seed.`)
  process.exit(1)
}

const userId = existing.id
console.log(`Usuário ${existing.username} encontrado: id=${userId}`)

const total = db.prepare('SELECT COUNT(*) as n FROM claude_sessions').get()
console.log(`Total de sessões: ${total.n}`)

const r1 = db.prepare('UPDATE claude_sessions SET created_by=? WHERE created_by IS NULL').run(userId)
console.log(`created_by setado em ${r1.changes} sessões`)

const r2 = db.prepare('UPDATE claude_sessions SET last_actor=? WHERE last_actor IS NULL').run(userId)
console.log(`last_actor setado em ${r2.changes} sessões`)

const sample = db.prepare('SELECT id, created_by, last_actor FROM claude_sessions LIMIT 3').all()
console.log('Amostra:', JSON.stringify(sample))

db.close()
console.log('Pronto!')
