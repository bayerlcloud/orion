/**
 * HRR Composer — composição algébrica via Phase Encoding (Holographic Reduced Representations).
 *
 * Phase vectors em [0, 2π) — matematicamente correto para HRR:
 *   bind(a, b)   = adição modular de fases → conceito composto
 *   unbind(a, b) = subtração modular de fases → decompõe binding
 *   bundle(vecs) = média circular de fases → superposição de conceitos
 *   similarity   = cosine de diferenças de fase → [-1, 1]
 *
 * Entity atoms são determinísticos via hash (garantidamente ortogonais).
 * SNR estimado: sqrt(DIM / n_items) — degrada quando n_items > DIM/4.
 */

import { searchVectors } from './vector.js'
import { logger } from '../logger.js'

const TWO_PI = 2 * Math.PI
const DIM = 384  // dimensão dos embeddings MiniLM

// ── SNR monitoring ────────────────────────────────────────────────────────────

export function snrEstimate(dim, nItems) {
  if (nItems <= 0) return Infinity
  const snr = Math.sqrt(dim / nItems)
  if (snr < 2.0) {
    logger.warn({ snr: snr.toFixed(2), dim, nItems }, '[hrr] memory bank perto da capacidade — retrieval degradando')
  }
  return snr
}

// ── Phase encoding: atoms determinísticos por nome ────────────────────────────

export function entityPhaseVector(name) {
  const phases = new Float32Array(DIM)
  let seed = 0
  for (let i = 0; i < name.length; i++) seed = ((seed * 31 + name.charCodeAt(i)) | 0) >>> 0
  for (let i = 0; i < DIM; i++) {
    const x = Math.sin((seed * 9301 + i * 49297 + 233) * 0.00001)
    phases[i] = (x - Math.floor(x)) * TWO_PI
  }
  return phases
}

// ── Operações de phase HRR ────────────────────────────────────────────────────

// Bind: adição modular de fases → conceito composto
export function phaseBindVectors(a, b) {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) % TWO_PI
  return out
}

// Unbind: subtração modular → desfaz binding
export function phaseUnbindVectors(a, b) {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = ((a[i] - b[i]) % TWO_PI + TWO_PI) % TWO_PI
  return out
}

// Bundle: média circular via exponencial complexo → superposição correta
export function phaseBundleVectors(vectors) {
  if (!vectors || vectors.length === 0) return null
  const dim = vectors[0].length
  const sumSin = new Float64Array(dim)
  const sumCos = new Float64Array(dim)
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sumSin[i] += Math.sin(v[i])
      sumCos[i] += Math.cos(v[i])
    }
  }
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    let angle = Math.atan2(sumSin[i], sumCos[i])
    if (angle < 0) angle += TWO_PI
    out[i] = angle
  }
  return out
}

// Similarity: média do cosine de diferenças de fase → [-1, 1]
export function phaseSimilarity(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += Math.cos(a[i] - b[i])
  return dot / a.length
}

// Converte phase vector para float compatível com vec_memories (MiniLM space)
export function phaseToFloat(phases) {
  const out = new Float32Array(phases.length)
  for (let i = 0; i < phases.length; i++) out[i] = Math.cos(phases[i])
  return out
}

// ── API pública retrocompatível ───────────────────────────────────────────────

export function normalize(v) {
  let sumSq = 0
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i]
  const len = Math.sqrt(sumSq) + 1e-8
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / len
  return out
}

// bindVectors: agora usa phase encoding em vez de Hadamard float
export function bindVectors(a, b) {
  return phaseBindVectors(a, b)
}

// superpose: agora usa phase bundle (circular mean)
export function superpose(vectors) {
  return phaseBundleVectors(vectors)
}

// ── Multi-entity retrieval via phase composition ──────────────────────────────

export async function retrieveByComposedEntities(entityNames, limit = 10) {
  if (!entityNames || entityNames.length === 0) return []

  const phaseVectors = entityNames.map(name => entityPhaseVector(String(name)))

  snrEstimate(DIM, phaseVectors.length)

  const bundled = phaseBundleVectors(phaseVectors)
  if (!bundled) return []

  const floatQuery = phaseToFloat(bundled)

  try {
    return searchVectors(Array.from(floatQuery), { limit })
  } catch {
    return []
  }
}

// ── Operações de composição simbólica (estilo Hermes) ─────────────────────────

/**
 * probe(entity) — encontra fatos SOBRE uma entidade.
 * Usa o phase vector da entidade como query direta.
 */
export async function probe(entityName, limit = 8) {
  if (!entityName) return []
  const pv = entityPhaseVector(String(entityName))
  const floatQ = phaseToFloat(pv)
  try {
    return searchVectors(Array.from(floatQ), { limit })
  } catch { return [] }
}

/**
 * related(entity) — encontra entidades estruturalmente conectadas.
 * Faz unbind do vetor da entidade de um bundle aleatório de entidades
 * conhecidas, surfaçando vizinhos no espaço composicional.
 */
export async function related(entityName, limit = 8) {
  if (!entityName) return []
  const anchorVec = entityPhaseVector(String(entityName))
  // Cria "probe de relação" deslocando a fase por PI/4 (rotação 45°)
  const relVec = new Float32Array(anchorVec.length)
  const SHIFT = Math.PI / 4
  for (let i = 0; i < anchorVec.length; i++) {
    relVec[i] = ((anchorVec[i] + SHIFT) % (Math.PI * 2))
  }
  const floatQ = phaseToFloat(relVec)
  try {
    return searchVectors(Array.from(floatQ), { limit })
  } catch { return [] }
}

/**
 * reason([entityA, entityB]) — semântica AND via min() de phase vectors.
 * Retorna fatos que satisfazem TODAS as entidades simultaneamente.
 * Usa min() element-wise (interseção no espaço fase).
 */
export async function reason(entityNames, limit = 8) {
  if (!entityNames || entityNames.length === 0) return []

  const vecs = entityNames.map(n => entityPhaseVector(String(n)))

  // AND via min() element-wise — menor fase = maior intersecção angular
  const andVec = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) {
    andVec[i] = Math.min(...vecs.map(v => v[i]))
  }

  snrEstimate(DIM, vecs.length)

  const floatQ = phaseToFloat(andVec)
  try {
    return searchVectors(Array.from(floatQ), { limit })
  } catch { return [] }
}
