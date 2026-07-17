// Script de migração: seta Danilo (user bayerl, id=1) como created_by e last_actor
// de todas as claude_sessions que não têm owner definido
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const Database = require('better-sqlite3')
const dbPath = path.join(__dirname, '../data/memory.db')
const db = new Database(dbPath)

// Garantir que o usuário bayerl existe
const existing = db.prepare("SELECT id, username FROM users WHERE username='bayerl'").get()
if (!existing) {
  console.error('Usuário bayerl não encontrado. Rode o servidor uma vez para criar o seed.')
  process.exit(1)
}

const userId = existing.id
console.log(`Usuário bayerl encontrado: id=${userId}`)

const total = db.prepare('SELECT COUNT(*) as n FROM claude_sessions').get()
console.log(`Total de sessões: ${total.n}`)

// Setar created_by onde é NULL
const r1 = db.prepare('UPDATE claude_sessions SET created_by=? WHERE created_by IS NULL').run(userId)
console.log(`created_by setado em ${r1.changes} sessões`)

// Setar last_actor onde é NULL (quem nunca foi aberto pela UI)
const r2 = db.prepare('UPDATE claude_sessions SET last_actor=? WHERE last_actor IS NULL').run(userId)
console.log(`last_actor setado em ${r2.changes} sessões`)

// Verificar resultado
const sample = db.prepare('SELECT id, created_by, last_actor FROM claude_sessions LIMIT 3').all()
console.log('Amostra:', JSON.stringify(sample))

db.close()
console.log('Pronto!')
