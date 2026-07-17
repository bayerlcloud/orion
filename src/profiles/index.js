/**
 * Profiles isolados — cada perfil tem seu próprio banco SQLite.
 * DB_PATH já suporta override via env; este módulo gerencia a convenção de pastas.
 *
 * Estrutura: data/profiles/<name>/memory.db
 * Ativo via: ORION_PROFILE=<name> (lido em db/index.js através de DB_PATH)
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createLogger } from '../logger.js'

const logger = createLogger('profiles')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const PROFILES_DIR = path.join(DATA_DIR, 'profiles')
const DEFAULT_DB = path.join(DATA_DIR, 'memory.db')

function ensureProfilesDir() {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true })
}

export function getActiveProfile() {
  return process.env.ORION_PROFILE ?? 'default'
}

export function getProfileDbPath(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(PROFILES_DIR, safe, 'memory.db')
}

export function listProfiles() {
  ensureProfilesDir()
  const active = getActiveProfile()
  const dirs = existsSync(PROFILES_DIR)
    ? readdirSync(PROFILES_DIR).filter(f => statSync(path.join(PROFILES_DIR, f)).isDirectory())
    : []
  // inclui "default" sempre (aponta para o DB padrão se não houver pasta)
  const hasDefault = dirs.includes('default')
  if (!hasDefault) dirs.unshift('default')
  return dirs.map(name => ({
    name,
    active: name === active,
    dbPath: name === 'default' && !existsSync(path.join(PROFILES_DIR, 'default'))
      ? DEFAULT_DB
      : getProfileDbPath(name),
    exists: existsSync(
      name === 'default' && !existsSync(path.join(PROFILES_DIR, 'default'))
        ? DEFAULT_DB
        : getProfileDbPath(name)
    ),
  }))
}

export function createProfile(name, cloneFrom = null) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!safe) throw new Error('Nome de perfil inválido')
  const profileDir = path.join(PROFILES_DIR, safe)
  if (existsSync(profileDir)) throw new Error(`Perfil "${safe}" já existe`)
  mkdirSync(profileDir, { recursive: true })
  const targetDb = path.join(profileDir, 'memory.db')
  if (cloneFrom) {
    const srcPath = cloneFrom === 'default'
      ? DEFAULT_DB
      : getProfileDbPath(cloneFrom)
    if (!existsSync(srcPath)) throw new Error(`Perfil fonte "${cloneFrom}" não encontrado`)
    copyFileSync(srcPath, targetDb)
    logger.info({ profile: safe, cloneFrom }, 'perfil criado por clone')
  } else {
    logger.info({ profile: safe }, 'perfil criado (banco vazio — será inicializado no primeiro uso)')
  }
  return { name: safe, dbPath: targetDb, cloned: !!cloneFrom }
}

export function getSwitchInstructions(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const dbPath = safe === 'default' ? DEFAULT_DB : getProfileDbPath(safe)
  return {
    profile: safe,
    dbPath,
    instructions: [
      `Para ativar o perfil "${safe}", reinicie o Orion com a variável:`,
      `  ORION_PROFILE=${safe} pm2 restart orion`,
      `Ou via .env: adicione ORION_PROFILE=${safe} e reinicie.`,
      `O DB_PATH calculado será: ${dbPath}`,
    ],
    envVar: `ORION_PROFILE=${safe}`,
  }
}
