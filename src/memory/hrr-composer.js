/**
 * HRR Composer — composição algébrica via Phase Encoding.
 *
 * Phase vectors em [0, 2π):
 *   bind(a, b)   = adição modular de fases → conceito composto
 *   unbind(a, b) = subtração modular → desfaz binding
 *   bundle(vecs) = média circular → superposição de conceitos
 */

import { searchVectors } from './vector.js'
import { logger } from '../logger.js'

const TWO_PI = 2 * Math.PI
const DIM = 384

export function snrEstimate(dim, nItems) {
  if (nItems <= 0) return Infinity
  const snr = Math.sqrt(dim / nItems)
  if (snr < 2.0) logger.warn({ snr: snr.toFixed(2), dim, nItems }, '[hrr] memory bank perto da capacidade')
  return snr
}

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

export function phaseBindVectors(a, b) {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) % TWO_PI
  return out
}

export function phaseUnbindVectors(a, b) {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = ((a[i] - b[i]) % TWO_PI + TWO_PI) % TWO_PI
  return out
}

export function phaseBundleVectors(vectors) {
  if (!vectors || vectors.length === 0) return null
  const dim = vectors[0].length
  const sumSin = new Float64Array(dim)
  const sumCos = new Float64Array(dim)
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) { sumSin[i] += Math.sin(v[i]); sumCos[i] += Math.cos(v[i]) }
  }
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    let angle = Math.atan2(sumSin[i], sumCos[i])
    if (angle < 0) angle += TWO_PI
    out[i] = angle
  }
  return out
}

export function phaseSimilarity(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += Math.cos(a[i] - b[i])
  return dot / a.length
}

export function phaseToFloat(phases) {
  const out = new Float32Array(phases.length)
  for (let i = 0; i < phases.length; i++) out[i] = Math.cos(phases[i])
  return out
}

export function normalize(v) {
  let sumSq = 0
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i]
  const len = Math.sqrt(sumSq) + 1e-8
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / len
  return out
}

export const bindVectors = phaseBindVectors
export const superpose = phaseBundleVectors

export async function retrieveByComposedEntities(entityNames, limit = 10) {
  if (!entityNames || entityNames.length === 0) return []
  const phaseVectors = entityNames.map(name => entityPhaseVector(String(name)))
  snrEstimate(DIM, phaseVectors.length)
  const bundled = phaseBundleVectors(phaseVectors)
  if (!bundled) return []
  const floatQuery = phaseToFloat(bundled)
  try { return searchVectors(Array.from(floatQuery), { limit }) } catch { return [] }
}

export async function probe(entityName, limit = 8) {
  if (!entityName) return []
  const pv = entityPhaseVector(String(entityName))
  try { return searchVectors(Array.from(phaseToFloat(pv)), { limit }) } catch { return [] }
}

export async function related(entityName, limit = 8) {
  if (!entityName) return []
  const anchorVec = entityPhaseVector(String(entityName))
  const SHIFT = Math.PI / 4
  const relVec = new Float32Array(anchorVec.length)
  for (let i = 0; i < anchorVec.length; i++) relVec[i] = ((anchorVec[i] + SHIFT) % (Math.PI * 2))
  try { return searchVectors(Array.from(phaseToFloat(relVec)), { limit }) } catch { return [] }
}

export async function reason(entityNames, limit = 8) {
  if (!entityNames || entityNames.length === 0) return []
  const vecs = entityNames.map(n => entityPhaseVector(String(n)))
  const andVec = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) andVec[i] = Math.min(...vecs.map(v => v[i]))
  snrEstimate(DIM, vecs.length)
  try { return searchVectors(Array.from(phaseToFloat(andVec)), { limit }) } catch { return [] }
}
