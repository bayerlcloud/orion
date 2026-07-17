/**
 * Brain API — dados para a página /brain (mapa visual + painéis).
 *
 * Fornece:
 *   - getBrainGraph(): nós (entidades + memórias-âncora) e arestas
 *     (relações + links causais + contradições) para o grafo force-directed
 *   - listBrainFiles() / readBrainFile(): explorador de arquivos do motor + vault (.md)
 *   - getBrainSkills(): skills auto-geradas + patches + taxa de rejeição
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, extname, resolve } from 'path'
import { getDb } from '../db/index.js'

// ── Grafo do cérebro ──────────────────────────────────────────────────────────

const TYPE_COLORS = {
  person: '#f472b6', project: '#818cf8', tool: '#34d399',
  pet: '#fbbf24', place: '#22d3ee', concept: '#a78bfa',
  credential: '#f87171', memory: '#64748b', effect: '#fb923c',
}
// Cor do nó-memória pela categoria
const CATEGORY_COLORS = {
  person: '#f472b6', decision: '#fbbf24', project: '#818cf8',
  tool: '#34d399', user_pref: '#22d3ee', concept: '#a78bfa', general: '#64748b',
}

export function getBrainGraph({ maxNodes = 160 } = {}) {
  const db = getDb()
  const nodes = new Map()  // id -> node
  const edges = []

  // Limpa o rótulo: remove o prefixo de fonte ([vault:arquivo.md], [claude:...], [mem:...])
  // e marcadores markdown, mostrando o CONTEXTO real da memória em vez do nome do arquivo.
  const cleanLabel = (raw) => {
    let s = String(raw ?? '')
      .replace(/^\s*\[[^\]]*\]\s*/, '')   // tira "[vault:ABCPrimeCred/index.md] "
      .replace(/^#{1,6}\s*/, '')          // tira "## "
      .replace(/^[-*>\s]+/, '')           // tira bullets/citações iniciais
      .replace(/\s+/g, ' ')
      .trim()
    if (!s) s = String(raw ?? '').replace(/\s+/g, ' ').trim()  // fallback se sobrou vazio
    return s.slice(0, 42)
  }
  const addNode = (id, label, type, color, weight = 1) => {
    if (!id) return
    if (nodes.has(id)) { nodes.get(id).weight += weight; return }
    nodes.set(id, { id, label: cleanLabel(label), type, color: color ?? TYPE_COLORS[type] ?? '#64748b', weight })
  }

  // 1. NÚCLEO: as memórias de verdade, coloridas por categoria (top por confiança/recência)
  const memIds = new Set()
  const memCat = new Map()
  const ensureMem = (id, content, category) => {
    if (memIds.has(id)) return
    addNode(`mem:${id}`, content, 'memory', CATEGORY_COLORS[category] ?? '#64748b', 1)
    memIds.add(id); memCat.set(id, category || 'general')
  }
  let mems = []
  try {
    mems = db.prepare(`SELECT id, content, category, confidence, access_count FROM memories WHERE archived=0 AND type!='raw' ORDER BY confidence DESC, last_accessed DESC LIMIT ?`).all(maxNodes)
  } catch { try { mems = db.prepare(`SELECT id, content, category, confidence, access_count FROM memories WHERE archived=0 AND type!='raw' ORDER BY confidence DESC LIMIT ?`).all(maxNodes) } catch {} }
  for (const m of mems) {
    addNode(`mem:${m.id}`, m.content, 'memory', CATEGORY_COLORS[m.category] ?? '#64748b', 1 + Math.min(4, (m.access_count || 0) * 0.4))
    memIds.add(m.id); memCat.set(m.id, m.category || 'general')
  }

  // 2. CO-RETRIEVAL → garante ambos os nós e liga (memórias acessadas juntas)
  try {
    const co = db.prepare(`SELECT id_a, id_b, count FROM co_retrievals ORDER BY count DESC LIMIT 400`).all()
    for (const c of co) {
      for (const cid of [c.id_a, c.id_b]) {
        if (!memIds.has(cid)) {
          try { const r = db.prepare(`SELECT id, content, category FROM memories WHERE id=? AND archived=0`).get(cid); if (r) ensureMem(r.id, r.content, r.category) } catch {}
        }
      }
      if (memIds.has(c.id_a) && memIds.has(c.id_b)) {
        edges.push({ source: `mem:${c.id_a}`, target: `mem:${c.id_b}`, label: `co-acesso ×${c.count}`, type: 'assoc', confidence: c.count })
      }
    }
  } catch {}

  // 2b. HUBS por categoria → conecta cada memória ao seu grupo (cria clusters visuais)
  const cats = new Set([...memCat.values()])
  for (const cat of cats) addNode(`cat:${cat}`, cat.toUpperCase(), 'hub', CATEGORY_COLORS[cat] ?? '#64748b', 9)
  for (const [id, cat] of memCat) edges.push({ source: `mem:${id}`, target: `cat:${cat}`, type: 'cat', label: cat })

  // 3. Entidades + relações (knowledge graph de conversa, quando houver)
  try {
    for (const e of db.prepare(`SELECT name, type, confidence FROM entities ORDER BY confidence DESC LIMIT 60`).all()) {
      addNode(`ent:${e.name}`, e.name, e.type, null, 2.5)
    }
    for (const r of db.prepare(`SELECT subject, relation, object, confidence FROM relations ORDER BY confidence DESC LIMIT 150`).all()) {
      addNode(`ent:${r.subject}`, r.subject, 'concept', null, 1)
      addNode(`ent:${r.object}`, r.object, 'concept', null, 1)
      edges.push({ source: `ent:${r.subject}`, target: `ent:${r.object}`, label: r.relation, type: 'relation', confidence: r.confidence })
    }
  } catch {}

  // 4. Links causais → arestas causa→efeito (laranja)
  try {
    for (const c of db.prepare(`SELECT cause, effect, confidence FROM causal_links ORDER BY confidence DESC LIMIT 80`).all()) {
      addNode(`cause:${c.cause}`, c.cause, 'concept', '#a78bfa', 1)
      addNode(`effect:${c.effect}`, c.effect, 'effect', '#fb923c', 1)
      edges.push({ source: `cause:${c.cause}`, target: `effect:${c.effect}`, label: 'causa', type: 'causal', confidence: c.confidence })
    }
  } catch {}

  // 5. Contradições → arestas vermelhas entre memórias
  try {
    for (const c of db.prepare(`SELECT memory_id_a, memory_id_b, content_a, content_b, score FROM contradiction_queue WHERE resolved=0 ORDER BY score DESC LIMIT 30`).all()) {
      addNode(`mem:${c.memory_id_a}`, c.content_a, 'memory', '#64748b', 1)
      addNode(`mem:${c.memory_id_b}`, c.content_b, 'memory', '#64748b', 1)
      edges.push({ source: `mem:${c.memory_id_a}`, target: `mem:${c.memory_id_b}`, label: `contradição (${c.score})`, type: 'contradiction', confidence: c.score })
    }
  } catch {}

  const nodeList = [...nodes.values()]
  const validIds = new Set(nodeList.map(n => n.id))
  const edgeList = edges.filter(e => validIds.has(e.source) && validIds.has(e.target))

  return {
    nodes: nodeList,
    edges: edgeList,
    stats: {
      nodes: nodeList.length,
      edges: edgeList.length,
      memories: nodeList.filter(n => n.type === 'memory').length,
      assoc: edgeList.filter(e => e.type === 'assoc').length,
      relations: edgeList.filter(e => e.type === 'relation').length,
      causal: edgeList.filter(e => e.type === 'causal').length,
      contradictions: edgeList.filter(e => e.type === 'contradiction').length,
    },
  }
}

// ── Explorador de arquivos (motor + vault) ────────────────────────────────────

// Whitelist de raízes navegáveis (segurança: nada fora destas pastas)
const ROOTS = {
  motor: '/config/workspace/orion/src',
  vault: '/config/workspace/notes/Orion',
  vaultGlobal: '/config/workspace/notes/Global',
}

const ALLOWED_EXT = new Set(['.js', '.md', '.html', '.json', '.py', '.txt'])

function isInsideRoot(absPath) {
  return Object.values(ROOTS).some(root => absPath === root || absPath.startsWith(root + '/'))
}

export function listBrainFiles(rootKey = 'motor', subdir = '') {
  const root = ROOTS[rootKey]
  if (!root) return { error: 'root inválido', dirs: [], files: [] }

  const target = resolve(join(root, subdir))
  if (!isInsideRoot(target) || !existsSync(target)) {
    return { error: 'caminho inválido', dirs: [], files: [] }
  }

  const dirs = []
  const files = []
  try {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'models') continue
      const full = join(target, entry.name)
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: join(subdir, entry.name) })
      } else if (ALLOWED_EXT.has(extname(entry.name))) {
        let size = 0
        try { size = statSync(full).size } catch {}
        files.push({ name: entry.name, path: join(subdir, entry.name), size, ext: extname(entry.name) })
      }
    }
  } catch (e) {
    return { error: e.message, dirs: [], files: [] }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { root: rootKey, subdir, dirs, files }
}

export function readBrainFile(rootKey = 'motor', relPath = '') {
  const root = ROOTS[rootKey]
  if (!root) return { error: 'root inválido' }

  const target = resolve(join(root, relPath))
  if (!isInsideRoot(target) || !existsSync(target)) {
    return { error: 'caminho inválido' }
  }
  if (!ALLOWED_EXT.has(extname(target))) {
    return { error: 'extensão não permitida' }
  }

  try {
    const stat = statSync(target)
    if (stat.size > 500_000) return { error: 'arquivo muito grande (>500KB)' }
    const content = readFileSync(target, 'utf8')
    return {
      path: relPath,
      ext: extname(target),
      size: stat.size,
      modified: Math.floor(stat.mtimeMs / 1000),
      content,
    }
  } catch (e) {
    return { error: e.message }
  }
}

export function getBrainRoots() {
  return Object.keys(ROOTS).map(key => ({
    key,
    label: key === 'motor' ? 'Motor (src/)' : key === 'vault' ? 'Vault Orion' : 'Vault Global',
  }))
}

// ── Skills auto-geradas + saúde ───────────────────────────────────────────────

export function getBrainSkills() {
  const db = getDb()

  let skills = []
  try {
    skills = db.prepare(`
      SELECT name, description, content, confidence, usage_count, status, source, created_at, updated_at
      FROM skills WHERE status != 'archived'
      ORDER BY created_at DESC LIMIT 60
    `).all()
  } catch {
    // fallback se coluna source não existir
    try {
      skills = db.prepare(`
        SELECT name, description, content, confidence, usage_count, status, created_at, updated_at
        FROM skills WHERE status != 'archived' ORDER BY created_at DESC LIMIT 60
      `).all().map(s => ({ ...s, source: 'manual' }))
    } catch {}
  }

  let patches = []
  try {
    patches = db.prepare(`
      SELECT skill_name, failure_pattern, patch_text, created_at
      FROM skill_patches ORDER BY created_at DESC LIMIT 20
    `).all()
  } catch {}

  let rejections = []
  try {
    rejections = db.prepare(`
      SELECT skill_name, COUNT(*) as total,
             SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejections
      FROM skill_rejections WHERE created_at > unixepoch() - 86400*30
      GROUP BY skill_name ORDER BY rejections DESC LIMIT 20
    `).all()
  } catch {}

  const rejMap = new Map(rejections.map(r => [r.skill_name, r]))

  return {
    skills: skills.map(s => {
      const rej = rejMap.get(s.name)
      return {
        ...s,
        content: undefined,
        contentPreview: (s.content ?? '').slice(0, 200),
        autoGenerated: s.source === 'synthesizer',
        rejection_pct: rej ? Math.round(100 * rej.rejections / rej.total) : 0,
      }
    }),
    patches,
    counts: {
      total: skills.length,
      autoGenerated: skills.filter(s => s.source === 'synthesizer').length,
      patched: patches.length,
    },
  }
}
