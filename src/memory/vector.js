import { load as loadSqliteVec } from 'sqlite-vec'
import { getDb } from '../db/index.js'

let _vecLoaded = false

function ensureVec() {
  if (_vecLoaded) return
  try {
    const db = getDb()
    loadSqliteVec(db)
    // Cria tabela vetorial usando rowid de memories (INTEGER, compatível com vec0)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        memory_rowid INTEGER PRIMARY KEY,
        embedding float[384]
      )
    `)
    _vecLoaded = true
    console.log('[vector] sqlite-vec carregado')
  } catch (err) {
    console.error('[vector] sqlite-vec indisponível:', err.message)
  }
}

export function saveVector(memoryRowid, embedding) {
  if (!embedding || embedding.length !== 384) return
  try {
    ensureVec()
    if (!_vecLoaded) return
    const db = getDb()
    // BigInt obrigatório: o vec0 rejeita Number do better-sqlite3 com
    // "Only integers are allows for primary key values" (bug silencioso histórico).
    // DELETE+INSERT em vez de OR REPLACE: o vec0 não honra INSERT OR REPLACE
    // (dispara "UNIQUE constraint failed"), então limpamos antes de reinserir.
    const rid = BigInt(memoryRowid)
    db.prepare('DELETE FROM vec_memories WHERE memory_rowid = ?').run(rid)
    db.prepare('INSERT INTO vec_memories(memory_rowid, embedding) VALUES(?, ?)').run(
      rid,
      new Float32Array(embedding)
    )
  } catch (err) {
    console.error('[vector] erro ao salvar vetor:', err.message)
  }
}

export function searchVectors(queryEmbedding, { limit = 10 } = {}) {
  if (!queryEmbedding || queryEmbedding.length !== 384) return []
  try {
    ensureVec()
    if (!_vecLoaded) return []
    const db = getDb()
    // k maior que limit: memórias arquivadas são filtradas DEPOIS do match do
    // vec0, então pedimos folga para ainda devolver `limit` resultados vivos
    return db.prepare(`
      SELECT m.id, m.rowid AS memory_rowid, vm.distance,
             m.content, m.type, m.confidence, m.access_count, m.last_accessed, m.created_at
      FROM vec_memories vm
      JOIN memories m ON m.rowid = vm.memory_rowid
      WHERE vm.embedding MATCH ? AND k = ?
        AND (m.archived = 0 OR m.archived IS NULL)
      ORDER BY vm.distance
      LIMIT ?
    `).all(new Float32Array(queryEmbedding), limit * 3, limit)
  } catch (err) {
    console.error('[vector] erro na busca vetorial:', err.message)
    return []
  }
}
