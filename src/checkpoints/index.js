/**
 * Checkpoints — git shadow store para undo de código fonte.
 * Copia src/ para um shadow git repo e faz commit.
 * Max 20 snapshots (os mais antigos são mantidos mas não listados).
 */
import { execa } from 'execa'
import { existsSync } from 'fs'
import { mkdir, rm, cp } from 'fs/promises'
import path from 'path'
import { createLogger } from '../logger.js'
const logger = createLogger('checkpoints')

const CHECKPOINT_REPO = path.resolve('/config/workspace/orion/data/checkpoints/shadow-repo')
const SOURCE_DIR      = path.resolve('/config/workspace/orion/src')
const SHADOW_SRC      = path.join(CHECKPOINT_REPO, 'src')
const MAX_CHECKPOINTS = 20

async function ensureRepo() {
  if (!existsSync(CHECKPOINT_REPO)) {
    await mkdir(CHECKPOINT_REPO, { recursive: true })
    await execa('git', ['init'], { cwd: CHECKPOINT_REPO })
    await execa('git', ['config', 'user.email', 'orion@local'], { cwd: CHECKPOINT_REPO })
    await execa('git', ['config', 'user.name', 'Orion Checkpoint'], { cwd: CHECKPOINT_REPO })
  }
}

async function syncToShadow() {
  if (existsSync(SHADOW_SRC)) await rm(SHADOW_SRC, { recursive: true, force: true })
  await cp(SOURCE_DIR, SHADOW_SRC, { recursive: true })
}

async function syncFromShadow() {
  if (existsSync(SOURCE_DIR)) await rm(SOURCE_DIR, { recursive: true, force: true })
  await cp(SHADOW_SRC, SOURCE_DIR, { recursive: true })
}

export async function createCheckpoint(label = 'manual') {
  await ensureRepo()
  await syncToShadow()

  await execa('git', ['add', '-A'], { cwd: CHECKPOINT_REPO })

  const msg = `checkpoint: ${label}`
  try {
    await execa('git', ['commit', '-m', msg], { cwd: CHECKPOINT_REPO })
    logger.info({ label }, 'checkpoint criado')
    return { ok: true, changed: true, label }
  } catch {
    // Nada mudou desde o último checkpoint
    return { ok: true, changed: false, label }
  }
}

export async function listCheckpoints() {
  await ensureRepo()
  try {
    const { stdout } = await execa(
      'git', ['log', `--max-count=${MAX_CHECKPOINTS}`, '--format=%H|%s|%ai'],
      { cwd: CHECKPOINT_REPO }
    )
    if (!stdout.trim()) return []
    return stdout.trim().split('\n').map(line => {
      const [hash, subject, date] = line.split('|')
      return { hash, subject, date }
    })
  } catch {
    return []
  }
}

export async function restoreCheckpoint(hash) {
  await ensureRepo()
  await execa('git', ['checkout', hash, '--', 'src/'], { cwd: CHECKPOINT_REPO })
  await syncFromShadow()
  logger.info({ hash }, 'checkpoint restaurado')
  return { ok: true, hash }
}
