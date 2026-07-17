import crypto from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getDb } from './db/index.js'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRET_PATH = join(__dirname, '../data/.auth_secret')
let SECRET = ''
try { SECRET = readFileSync(SECRET_PATH, 'utf8').trim() } catch {}
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex')
  try { writeFileSync(SECRET_PATH, SECRET, { mode: 0o600 }) } catch {}
}

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('hex')

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':')
  if (!salt || !hash) return false
  try {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash))
  } catch { return false }
}

export function bootstrapOwner() {
  const db = getDb()
  const { c } = db.prepare('SELECT COUNT(*) as c FROM users').get()
  if (c > 0) return
  const initialPassword = process.env.OWNER_INITIAL_PASSWORD || 'changeMe!'
  const hash = hashPassword(initialPassword)
  const ownerUser = process.env.OWNER_USERNAME || 'admin'
  const ownerName = process.env.OWNER_DISPLAY_NAME || 'Admin'
  db.prepare(`INSERT INTO users (username, display_name, role, password_hash, avatar_color)
    VALUES (?, ?, 'owner', ?, ?)`).run(ownerUser, ownerName, hash, '#6366f1')
  console.log(`[auth] Usuário owner "${ownerUser}" criado. Altere a senha após o primeiro login.`)
}

export function login(username, password) {
  const db = getDb()
  const user = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1').get(username, username)
  if (!user) return null
  if (!verifyPassword(password, user.password_hash)) return null
  db.prepare('UPDATE users SET last_login_at = unixepoch() WHERE id = ?').run(user.id)
  const payload = `${user.id}.${user.username}.${user.role}.${Date.now()}`
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name,
      avatar_color: user.avatar_color,
    },
  }
}

export function getUser(req) {
  const cookie = req.cookies?.orion_auth
  if (!cookie) return null
  const dot = cookie.lastIndexOf('.')
  if (dot < 1) return null
  const b64 = cookie.slice(0, dot)
  const sig  = cookie.slice(dot + 1)
  let payload
  try { payload = Buffer.from(b64, 'base64url').toString('utf8') } catch { return null }
  const expected = sign(payload)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  const parts = payload.split('.')
  if (parts.length < 4) return null
  const [userId, username, role, ts] = parts
  if (!ts || Date.now() - Number(ts) > TTL_MS) return null
  return { id: Number(userId), username, role }
}

export function authMiddleware(req, res, next) {
  const bypass = ['/login', '/webhook', '/health', '/favicon']
  if (bypass.some(p => req.path.startsWith(p))) return next()
  const user = getUser(req)
  if (user) {
    req.user = user
    return next()
  }
  res.redirect('/login')
}

export function requireOwner(req, res, next) {
  if (req.user?.role === 'owner') return next()
  if (req.accepts('html')) return res.status(403).send('<h2>403 — Acesso exclusivo do proprietário</h2>')
  res.status(403).json({ error: 'Acesso restrito ao proprietário.' })
}
