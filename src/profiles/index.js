import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createLogger } from '../logger.js'

const logger = createLogger('profiles')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const PROFILES_DIR = path.join(DATA_DIR, 'profiles')
const DEFAULT_DB = path.join(DATA_DIR, 'memory.db')

function ensureProfilesDir() { if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true }) }

export function getActiveProfile() { return process.env.ORION_PROFILE ?? 'default' }
export function getProfileDbPath(name) { return path.join(PROFILES_DIR, name.replace(/[^a-zA-Z0-9_-]/g, '_'), 'memory.db') }

export function listProfiles() {
  ensureProfilesDir()
  const active = getActiveProfile()
  const dirs = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR).filter(f => statSync(path.join(PROFILES_DIR, f)).isDirectory()) : []
  if (!dirs.includes('default')) dirs.unshift('default')
  return dirs.map(name => ({
    name, active: name === active,
    dbPath: name === 'default' && !existsSync(path.join(PROFILES_DIR, 'default')) ? DEFAULT_DB : getProfileDbPath(name),
    exists: existsSync(name === 'default' && !existsSync(path.join(PROFILES_DIR, 'default')) ? DEFAULT_DB : getProfileDbPath(name)),
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
    const srcPath = cloneFrom === 'default' ? DEFAULT_DB : getProfileDbPath(cloneFrom)
    if (!existsSync(srcPath)) throw new Error(`Perfil fonte "${cloneFrom}" não encontrado`)
    copyFileSync(srcPath, targetDb)
    logger.info({ profile: safe, cloneFrom }, 'perfil criado por clone')
  } else {
    logger.info({ profile: safe }, 'perfil criado (banco vazio)')
  }
  return { name: safe, dbPath: targetDb, cloned: !!cloneFrom }
}

export function getSwitchInstructions(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const dbPath = safe === 'default' ? DEFAULT_DB : getProfileDbPath(safe)
  return {
    profile: safe, dbPath,
    instructions: [`Para ativar o perfil "${safe}", reinicie o Orion com:`, `  ORION_PROFILE=${safe} pm2 restart orion`, `DB_PATH calculado: ${dbPath}`],
    envVar: `ORION_PROFILE=${safe}`,
  }
}
