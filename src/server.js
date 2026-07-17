import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import { createRequire } from 'module'
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync, readdirSync, openSync, readSync, fstatSync, closeSync, appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
const _require = createRequire(import.meta.url)
const XLSX = _require('xlsx')
import { execa } from 'execa'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import cron from 'node-cron'
import { getDb } from './db/index.js'
import { router as evolutionRouter } from './gateway/evolution.js'
import { login, authMiddleware, requireOwner, bootstrapOwner, getUser } from './auth.js'
import { listUsers, createUser, updateUser, resetPassword, changeOwnPassword, getUserById, getAuditLog, insertAuditLog, emitAuditEntry, onAuditEntry, getTimesheet, listTasks, createTask, updateTask, deleteTask, getUserPermissions, setUserPermissions, getBudget, setBudget } from './users/manager.js'
import { initCronJobs, listJobs, pauseJob, resumeJob, deleteJob, getJobOutput, getJobById, triggerJob, createJob, parseScheduleAdvanced, scanPromptForInjection } from './cron/manager.js'
import { BLUEPRINTS, getBlueprintById, fillBlueprint } from './cron/blueprints.js'
import { runPhase2 } from './cron/phase2.js'
import { runPhase3 } from './cron/phase3.js'
import { runPhase4 } from './cron/phase4.js'
import { runPhase5 } from './cron/phase5.js'
import { runPhase6 } from './cron/phase6.js'
import { runPhase7 } from './cron/phase7.js'
import { warmup } from './memory/embeddings.js'
import { feedbackMemory, restoreMemory, retrieveByTag, retrieveByCategory, retrieveForEntities, rebuildMemoryBank, backfillEmbeddings, retrieveByComposedEntities, probe, related, reason, onMemoryWrite, saveMemory, applyObservation, getRecentDrifts, getCategorySummary, getNarrativeSummary, getMemoriesInPeriod, listPendingContradictions, getResolutionStats, resolveContradiction, saveCausalLink, listCausalLinks, getCauses, getEffects, multiHopQuery, traceCausalChain, reasonCounterfactual, runDeduplication, sendNextDedupQuestion, resolveDedupVote, listDedupQueue, getMemoryStateAt, compareSnapshots, listSnapshotSessions, pruneOldSnapshots } from './memory/index.js'
import { listCronSuggestions, activateSuggestion, suggestCronJobs } from './cron/cron-suggester.js'
import { getBrainGraph, listBrainFiles, readBrainFile, getBrainRoots, getBrainSkills } from './api/brain.js'
import { getMechanismStats, getHealthRadar, retrievalDebug, traceMemory, listRecentMemoriesForTrace, saveImprovement, listImprovements, updateImprovement } from './api/academia.js'
import { emitBrain, onBrainEvent, getRecentEvents } from './brain-events.js'
import { getMemoryQualityMetrics } from './api/quality-scorer.js'
import { recommendSkills, suggestSkillsForMessage, getTopSkills } from './agent/skill-recommender.js'
import { refreshAllCategorySummaries } from './memory/tiered-summarizer.js'
import { getTemporalIndexStats } from './memory/temporal-index.js'
import { execFile, execSync } from 'child_process'
import { initSessionIndex, listSessions, getSession, renameSession, hideSession, showSession, openSession, closeSessionPin, addSseClient, removeSseClient, getActiveSessions, hardDeleteSession, clearAttention, getLastRoleLive, getSessionPid } from './sessions/indexer.js'
import { fetchClaudeUsage } from './api/usage.js'
import { contextHandler } from './api/context.js'
import { delegate, orchestrate } from './agent/delegate.js'
import { listActiveSessions } from './sessions/registry.js'
import { parseSession, parseSessionTimeline, tailParseTimeline, readNewLines, parseLineItems } from './sessions/reader.js'
import { sendToSession, isSending, createNewSession } from './sessions/sender.js'
import { createAndExecuteMission, listMissions, getMission, resumeRunningMissions } from './agent/mission.js'
import { createOrchestration, getOrchestration, listOrchestrations, resumeRunningOrchestrations, subscribeOrch, unsubscribeOrch } from './agent/orchestrator-loop.js'
import { addOrionClient, removeOrionClient, emitOrionEvent, setSilentMode, isSilentMode } from './api/orion-stream.js'
import { runOrion } from './agent/orion.js'
import { createApproval, answerApproval, listPendingApprovals } from './api/approvals.js'
import { listAutonomousActions, undoAutonomousAction, logAutonomousAction } from './api/autonomous-log.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(cookieParser())

// Favicon ⚡ (raio em gradiente) — antes do auth para carregar sem login e furar o cache do Hermes
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M18.5 3.5 L8 18.5 h6 l-2.5 10 L24 13 h-6.2 z" fill="#fff"/></svg>`
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(FAVICON_SVG)
})

app.use(authMiddleware)

// ── Enriquece req.user com display_name/avatar_color do banco ────────────────
app.use((req, res, next) => {
  if (!req.user) return next()
  try {
    const u = getDb().prepare('SELECT display_name, avatar_color FROM users WHERE id = ?').get(req.user.id)
    if (u) { req.user.display_name = u.display_name; req.user.avatar_color = u.avatar_color }
  } catch {}
  next()
})

// ── Audit log — registra toda request autenticada ─────────────────────────────
const AUDIT_SKIP = ['/favicon', '/health', '/api/claude-sessions/stream', '/api/orion/stream', '/api/brain/stream']
app.use((req, res, next) => {
  if (!req.user) return next()
  if (AUDIT_SKIP.some(p => req.path.startsWith(p))) return next()
  const start = Date.now()
  res.on('finish', () => {
    let body = null
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
      const safe = { ...req.body }
      if (safe.password) safe.password = '***'
      if (safe.current)  safe.current  = '***'
      body = JSON.stringify(safe).slice(0, 300)
    }
    const entry = {
      user_id: req.user.id, username: req.user.username,
      method: req.method, path: req.path,
      ip: req.ip || req.socket?.remoteAddress,
      status_code: res.statusCode, duration_ms: Date.now() - start,
      body_summary: body,
    }
    insertAuditLog(entry)
    emitAuditEntry({ ...entry, created_at: Math.floor(Date.now() / 1000) })
  })
  next()
})

// ── Proteção por prefixo (owner-only) ────────────────────────────────────────
// Colaboradores não têm acesso a: memória pessoal, Claude Code sessions,
// cron, missions, context, brain, kanban, whatsapp, token-usage.
const OWNER_PREFIXES = [
  '/api/memories', '/api/context', '/api/brain', '/api/cron',
  '/api/mission', '/api/orchestrat', '/api/kanban',
  '/api/whatsapp', '/api/approval', '/api/autonomous',
  '/api/token-usage', '/api/claude-usage',
  '/api/academia', '/api/dedup', '/api/snapshot',
  '/api/skills', '/api/recommendations',
]
app.use(OWNER_PREFIXES, requireOwner)
// Claude sessions: collaborators podem ver apenas as próprias (user_id match).
// Owner vê tudo — tratado nas rotas individualmente via req.user.role.

// ── Rotas de plataforma fechadas por padrão (lapidação 2026-07-09) ────────────
// exec/fs/computer-use/lsp/profiles/checkpoints/acp: superfície experimental sem
// consumidor conhecido — shell/filesystem/desktop não devem ficar expostos à toa.
// Reabrir: ORION_PLATFORM_ROUTES=on no ambiente do pm2.
const PLATFORM_PREFIXES = ['/api/exec', '/api/fs', '/api/computer-use', '/api/lsp', '/api/profiles', '/api/checkpoints', '/api/acp', '/v1']
app.use(PLATFORM_PREFIXES, (req, res, next) => {
  if (process.env.ORION_PLATFORM_ROUTES === 'on') return next()
  res.status(403).json({ error: 'rota de plataforma desativada (ORION_PLATFORM_ROUTES=on para habilitar)' })
})

const loginHtml    = readFileSync(join(__dirname, 'ui/login.html'), 'utf8')
let adminHtml = ''; try { adminHtml = readFileSync(join(__dirname, 'ui/admin.html'), 'utf8') } catch {}
const dashHtml     = readFileSync(join(__dirname, 'ui/dashboard.html'), 'utf8')
const sessionsHtml = readFileSync(join(__dirname, 'ui/sessions.html'), 'utf8')
const chatHtml     = readFileSync(join(__dirname, 'ui/chat.html'), 'utf8')
const panelHtml    = readFileSync(join(__dirname, 'ui/panel.html'), 'utf8')
const brainHtml    = readFileSync(join(__dirname, 'ui/brain.html'), 'utf8')
const academiaHtml = readFileSync(join(__dirname, 'ui/academia.html'), 'utf8')
const automacoesHtml = readFileSync(join(__dirname, 'ui/automacoes.html'), 'utf8')

// ── Sidebar canônico (fonte única, injetado em todas as páginas) ──────────────
// Ícones flat (Lucide-style, stroke) — dentro de quadradinhos arredondados
const _svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`
const ICONS = {
  home:_svg('<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>'),
  chat:_svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  brain:_svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  cap:_svg('<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5"/>'),
  layout:_svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>'),
  folder:_svg('<path d="M4 4h6l2 2h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>'),
  book:_svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  zap:_svg('<path d="M13 2 3 14h8l-1 8 10-12h-8z"/>'),
  fileText:_svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>'),
  globe:_svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  whats:_svg('<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/>'),
  db:_svg('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  trend:_svg('<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>'),
  compass:_svg('<circle cx="12" cy="12" r="9"/><path d="M16 8l-2.5 5.5L8 16l2.5-5.5z"/>'),
  blocks:_svg('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  file:_svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  checks:_svg('<path d="M3 6l2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3M11 6h10M11 13h10M11 20h10"/>'),
  code:_svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9l3 3-3 3M13 15h3"/>'),
  clock:_svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  logout:_svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  panel:_svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'),
  rocket:_svg('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),
  agent:_svg('<circle cx="12" cy="8" r="4"/><path d="M12 14c-6 0-8 3-8 5v1h16v-1c0-2-2-5-8-5z"/><path d="M17 6a5 5 0 0 1 0 7"/><path d="M19 4a8 8 0 0 1 0 11"/>'),
  shield:_svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  users:_svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
}
const SIDEBAR_CSS = `
.sidebar{width:var(--sb-w,236px);flex-shrink:0;background:var(--side,#0d0d14);border-right:1px solid var(--line,#1e1e2e);display:flex;flex-direction:column;height:100vh;position:sticky;top:0;z-index:50;transition:width .18s ease;view-transition-name:sidebar}
#sb-resize-handle{position:absolute;top:0;right:-4px;width:8px;height:100%;cursor:col-resize;z-index:100;background:transparent}
#sb-resize-handle:hover::after,#sb-resize-handle.dragging::after{content:'';position:absolute;left:3px;top:0;width:2px;height:100%;background:rgba(99,102,241,.5);border-radius:2px}
.sidebar-brand{padding:16px 14px 12px;border-bottom:1px solid var(--line,#1e1e2e);display:flex;align-items:center;gap:10px}
.sidebar .brand-icon{width:34px;height:34px;border-radius:10px;flex-shrink:0;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:17px}
.sidebar .brand-txt{flex:1;min-width:0}
.sidebar .brand-name{font-size:15px;font-weight:700;color:#fff;line-height:1}
.sidebar .brand-sub{font-size:11px;color:#6b7280;margin-top:2px}
.sidebar .sb-toggle{flex-shrink:0;width:28px;height:28px;border-radius:8px;border:1px solid #23233a;background:#15151f;color:#6b7280;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .12s}
.sidebar .sb-toggle:hover{color:#e5e7eb;border-color:#33334d}
.sidebar .sb-toggle svg{width:15px;height:15px}
.sidebar-nav{padding:10px 8px;display:flex;flex-direction:column;gap:2px;overflow-x:hidden}
.sidebar .nav-section-label{font-size:10px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.06em;padding:10px 10px 4px;white-space:nowrap}
.sidebar .nav-item{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:9px;text-decoration:none;color:#9ca3af;font-size:13px;font-weight:500;transition:background .12s,color .12s;cursor:pointer;border:none;background:none;width:100%;text-align:left;white-space:nowrap;overflow:hidden}
.sidebar .nav-item:hover{background:#1a1a2e;color:#e5e7eb}
.sidebar .nav-item.active{background:#1a1a2e;color:#c7d2fe}
.sidebar .nav-item .ic{width:30px;height:30px;flex-shrink:0;border-radius:9px;border:1px solid #23233a;background:#13131d;display:flex;align-items:center;justify-content:center;color:#9ca3af;transition:all .12s}
.sidebar .nav-item .ic svg{width:15px;height:15px}
.sidebar .nav-item:hover .ic{border-color:#33334d;color:#e5e7eb}
.sidebar .nav-item.active .ic{border-color:#4f46e5;background:#1e1e3a;color:#a5b4fc}
.sidebar .nav-item .lbl{overflow:hidden;text-overflow:ellipsis}
.sidebar-bottom{padding:8px;border-top:1px solid var(--line,#1e1e2e);flex-shrink:0}
/* recolhido */
.sidebar.collapsed{width:64px}
.sidebar.collapsed .brand-txt,.sidebar.collapsed .nav-item .lbl,.sidebar.collapsed .nav-section-label,.sidebar.collapsed .sb-section{display:none}
.sidebar.collapsed .nav-item{justify-content:center;padding:6px 0}
.sidebar.collapsed .sidebar-brand{justify-content:center;padding:16px 0 12px}
.sidebar.collapsed .sb-toggle{position:absolute;top:14px;right:8px;width:22px;height:22px}
.sidebar.collapsed .brand-icon{margin:0}
/* ── mode panels ── */
#sb-menu{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#26263a transparent}
#sb-menu::-webkit-scrollbar{width:4px}
#sb-menu::-webkit-scrollbar-thumb{background:#26263a;border-radius:3px}
#sb-sessions{display:none;flex:1;min-height:0;flex-direction:column;padding:10px 10px}
#sb-files{display:none;flex:1;min-height:0;flex-direction:column;padding:6px 8px}
#sbMain.sess-mode #sb-menu{display:none}
#sbMain.sess-mode #sb-sessions{display:flex}
#sbMain.sess-mode.collapsed{width:var(--sb-w,236px)}
#sbMain.files-mode #sb-menu{display:none}
#sbMain.files-mode #sb-files{display:flex}
#sbMain.files-mode.collapsed{width:var(--sb-w,236px)}
/* back button */
.sb-back{display:flex;align-items:center;gap:8px;background:none;border:none;color:#6b7280;padding:4px 6px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500;width:100%;text-align:left;margin-bottom:10px;transition:color .12s}
.sb-back:hover{color:#c7d2fe}
.sb-back svg{width:14px;height:14px;flex-shrink:0}
.ft-actions{display:flex;align-items:center;gap:3px;margin-bottom:8px;padding:0 2px}
.ft-act{display:flex;align-items:center;justify-content:center;width:30px;height:30px;background:none;border:none;border-radius:7px;color:#7c8597;cursor:pointer;transition:background .12s,color .12s,transform .08s}
.ft-act:hover{background:rgba(255,255,255,.06);color:#c7d2fe}
.ft-act:active{transform:scale(.9)}
.ft-act:focus-visible{outline:2px solid rgba(99,102,241,.6);outline-offset:1px}
.ft-act svg{width:15px;height:15px}
.ft-act-sep{flex:1}
/* nova sessão button */
.sb-new-sess{width:100%;background:linear-gradient(135deg,rgba(99,102,241,.18),rgba(139,92,246,.12));border:1px solid rgba(99,102,241,.3);color:#a5b4fc;border-radius:10px;padding:9px 13px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;margin-bottom:10px;transition:all .18s}
.sb-new-sess:hover{background:linear-gradient(135deg,rgba(99,102,241,.28),rgba(139,92,246,.2));border-color:rgba(99,102,241,.5);color:#c7d2fe}
.sb-new-sess svg{flex-shrink:0;width:15px;height:15px}
/* search */
.sb-search{width:100%;background:rgba(255,255,255,.04);border:1px solid #1e1e2e;border-radius:9px;padding:7px 11px;color:#e5e7eb;font-size:12.5px;outline:none;margin-bottom:10px;box-sizing:border-box;transition:border-color .15s}
.sb-search::placeholder{color:#374151}
.sb-search:focus{border-color:rgba(99,102,241,.5)}
/* session list */
.sb-sess-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;scrollbar-width:thin;scrollbar-color:#26263a transparent}
.sb-sess-list::-webkit-scrollbar{width:4px}.sb-sess-list::-webkit-scrollbar-thumb{background:#26263a;border-radius:3px}
.sb-sess-grp{font-size:10px;font-weight:700;color:#2d2d45;text-transform:uppercase;letter-spacing:.1em;padding:12px 6px 5px;display:flex;align-items:center;gap:6px}
.sb-sess-grp-cnt{font-size:10px;color:#2d2d45;font-weight:500;letter-spacing:0}
.sb-sess{display:flex;align-items:center;padding:0 4px;border-radius:9px;text-decoration:none;color:#6b7280;font-size:12.5px;white-space:nowrap;overflow:hidden;transition:background .12s,color .12s;position:relative;min-height:34px}
.sb-sess:hover{background:rgba(255,255,255,.05);color:#c4c4d4}
.sb-sess:hover .sb-x{opacity:1}
.sb-sess.active{background:rgba(99,102,241,.12);color:#c7d2fe}
.sb-sess-t{overflow:hidden;text-overflow:ellipsis;flex:1;padding:8px 4px 8px 0;line-height:1.4}
.sb-x{flex-shrink:0;opacity:0;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:opacity .12s,background .12s,color .12s;color:#4b5563;margin-right:2px}
.sb-x:hover{background:rgba(239,68,68,.15);color:#f87171}
.sb-x svg{width:12px;height:12px;pointer-events:none}
.sb-trash{flex-shrink:0;opacity:0;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:opacity .15s,background .12s,color .12s;color:#374151;margin-right:1px;border:none;background:none;cursor:pointer;padding:0}
.sb-trash:hover{background:rgba(239,68,68,.15);color:#f87171}
.sb-trash svg{width:13px;height:13px;pointer-events:none;stroke-width:1.8}
.sb-sess:hover .sb-trash{opacity:1}
.sb-sess-empty{color:#2d2d45;font-size:12px;padding:10px 6px}
.sb-badge{flex-shrink:0;font-size:9px;font-weight:700;letter-spacing:.06em;color:#374151;background:#13131d;border:1px solid #1e1e2e;border-radius:4px;padding:1px 4px;margin-right:3px;white-space:nowrap;max-width:72px;overflow:hidden;text-overflow:ellipsis}
.sb-sess.active .sb-badge{color:#4f46e5;border-color:#312e81;background:#1a1a3a}
.sb-div{height:1px;background:#1a1a2e;margin:4px 6px}
.sb-trash-hdr{display:flex;align-items:center;gap:6px;padding:10px 8px 5px;font-size:10px;font-weight:700;color:#2d2d45;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;user-select:none;transition:color .12s;border-top:1px solid #13131d;margin-top:4px}
.sb-trash-hdr:hover{color:#4b5563}
.sb-trash-hdr svg{width:11px;height:11px;flex-shrink:0}
.sb-trash-hdr .sb-chev{margin-left:auto;width:10px;height:10px;transition:transform .15s}
.sb-trash-hdr.open .sb-chev{transform:rotate(180deg)}
.sb-hdel svg{stroke:#6b7280}
.sb-hdel:hover{background:rgba(239,68,68,.2)!important}
.sb-hdel:hover svg{stroke:#f87171}
/* ── file tree ── */
.ft-search{width:100%;background:rgba(255,255,255,.04);border:1px solid #1e1e2e;border-radius:8px;padding:6px 10px;color:#e5e7eb;font-size:12px;outline:none;margin-bottom:6px;box-sizing:border-box;transition:border-color .15s}
.ft-search::placeholder{color:#374151}
.ft-search:focus{border-color:rgba(99,102,241,.5)}
.ft-tree{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#26263a transparent;font-size:12px}
.ft-tree::-webkit-scrollbar{width:4px}.ft-tree::-webkit-scrollbar-thumb{background:#26263a;border-radius:3px}
.ft-row{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:6px;cursor:pointer;color:#9ca3af;user-select:none;transition:background .1s,color .1s;white-space:nowrap;overflow:hidden}
.ft-row:hover{background:rgba(255,255,255,.05);color:#e5e7eb}
.ft-row.active{background:rgba(99,102,241,.15);color:#c7d2fe}
.ft-row.ft-dir{color:#c7d2fe;font-weight:500}
.ft-row .ft-chevron{width:12px;flex-shrink:0;color:#4b5563;transition:transform .12s}
.ft-row.open .ft-chevron{transform:rotate(90deg)}
.ft-row .ft-icon{width:14px;flex-shrink:0;opacity:.7}
.ft-row .ft-name{overflow:hidden;text-overflow:ellipsis;flex:1}
.ft-children{padding-left:14px}
.ft-children.hidden{display:none}
/* ── dot status (lista completa de sessões) ── */
.sb-dot{width:6px;height:6px;border-radius:50%;background:#252538;flex-shrink:0;margin:0 8px 0 4px;transition:background .2s}
@keyframes sb-live-pulse{0%,100%{box-shadow:0 0 3px 1px rgba(34,197,94,.45);opacity:1}50%{box-shadow:0 0 9px 3px rgba(34,197,94,.9);opacity:.65}}
.sb-dot.live{background:#22c55e;animation:sb-live-pulse 1.6s ease-in-out infinite}
.sb-dot.done{background:#f97316;box-shadow:0 0 7px rgba(249,115,22,.7);animation:sb-done-pulse 2s ease-in-out infinite}
@keyframes sb-done-pulse{0%,100%{box-shadow:0 0 5px 1px rgba(249,115,22,.5)}50%{box-shadow:0 0 11px 3px rgba(249,115,22,.9)}}
.sb-dot.idle{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,.5)}
/* ── avatar mini do último ator por sessão ── */
.sb-actor-av{flex-shrink:0;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:#fff;margin-right:4px;opacity:.7;transition:opacity .12s;cursor:default}
.sb-sess:hover .sb-actor-av{opacity:1}
/* ── ícone de visibilidade da sessão ── */
.sb-vis-ic{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:3px;opacity:0;transition:opacity .12s;cursor:pointer;color:#6366f1}
.sb-sess:hover .sb-vis-ic{opacity:.6}
.sb-vis-ic:hover{opacity:1!important}
.sb-vis-prv{color:#6b7280}
.sess-team .sb-vis-ic{opacity:.5}
.sess-team .sb-vis-ic:hover{opacity:1}
/* ── mobile overlay ── */
#sb-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.52);z-index:199}
#sb-overlay.show{display:block}
#mob-ham{display:none;position:fixed;top:12px;left:12px;z-index:198;width:36px;height:36px;border-radius:9px;border:1px solid #23233a;background:#111118;color:#9ca3af;cursor:pointer;font-size:20px;align-items:center;justify-content:center;padding:0;line-height:1}
#mob-ham:hover{color:#e5e7eb}
@media(max-width:768px){
  #mob-ham{display:flex}
  .sidebar{position:fixed!important;left:0;top:0;bottom:0;z-index:200;width:min(82vw,300px)!important;transform:translateX(-110%);transition:transform .22s cubic-bezier(.4,0,.2,1),box-shadow .22s}
  .sidebar.mob-open{transform:translateX(0)!important;box-shadow:6px 0 32px rgba(0,0,0,.7)}
  .sidebar.collapsed{width:min(82vw,300px)!important}
  /* trava o "samba" lateral no mobile: sem scroll/overscroll horizontal */
  html,body{overflow-x:hidden!important;overscroll-behavior:none;max-width:100%}
  .main,.page,.content,.view{overflow-x:hidden;overscroll-behavior-x:none}
}
/* ── menu de contexto da lixeira ── */
.sb-dots-menu{background:#1a1a2e;border:1px solid #2d2d45;border-radius:9px;padding:4px;min-width:180px;box-shadow:0 6px 24px rgba(0,0,0,.55)}
.sb-dots-menu button{display:flex;align-items:center;gap:7px;width:100%;background:none;border:none;color:#9ca3af;padding:7px 10px;border-radius:6px;font-size:12.5px;cursor:pointer;text-align:left;white-space:nowrap}
.sb-dots-menu button svg{flex-shrink:0;opacity:.7}
.sb-dots-menu button:hover{background:rgba(255,255,255,.07);color:#e5e7eb}
.sb-dots-menu button.danger:hover{background:rgba(239,68,68,.15);color:#f87171}
.sb-dots-menu button.danger:hover svg{opacity:1}
.sb-hdots{opacity:0!important}
.sb-sess:hover .sb-hdots{opacity:1!important}
/* ── painel de configurações ── */
.sb-cfg-panel{display:none;padding:8px;border-top:1px solid var(--line,#1e1e2e)}
.sb-cfg-panel.open{display:block}
.sb-cfg-row{display:flex;align-items:center;justify-content:space-between;padding:8px 6px;font-size:12.5px;color:#9ca3af}
.sb-cfg-row .lbl{display:flex;align-items:center;gap:8px}
.sb-cfg-row .lbl svg{width:14px;height:14px;opacity:.6}
.sb-switch{position:relative;width:36px;height:20px;flex-shrink:0;cursor:pointer}
.sb-switch input{opacity:0;width:0;height:0;position:absolute}
.sb-switch-track{position:absolute;inset:0;background:#252538;border-radius:20px;transition:background .2s}
.sb-switch input:checked+.sb-switch-track{background:#6366f1}
.sb-switch-thumb{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .2s;pointer-events:none}
.sb-switch input:checked~.sb-switch-thumb{transform:translateX(16px)}
/* ══════════════════════════════════════════════════
   LIGHT MODE — design system estético (aurora gradient)
   Princípio: tudo flutua sobre gradiente via sombra, sem borders duras
   ══════════════════════════════════════════════════ */
body.light-mode{
  background:linear-gradient(145deg,#c2d9ee 0%,#eaebe4 50%,#f2d5c4 100%) fixed!important;
  color:#1a1a2e!important;
  --bg:transparent;--side:rgba(255,255,255,.82);--panel:#fff;--panel2:#f5f6f8;
  --line:rgba(0,0,0,.07);--txt:#1a1a2e;--mut:#7c8ca0;--accent:#6366f1;--accent2:#8b5cf6}
/* ── sidebar ── */
body.light-mode .sidebar{
  background:rgba(255,255,255,.82)!important;
  border-color:transparent!important;
  box-shadow:2px 0 24px rgba(0,0,0,.08)!important;
  backdrop-filter:blur(20px)!important}
body.light-mode .sidebar-brand{border-color:rgba(0,0,0,.07)!important}
body.light-mode .sidebar .brand-name{color:#1a1a2e!important}
body.light-mode .sidebar .brand-sub{color:#7c8ca0!important}
body.light-mode .sidebar .sb-toggle{background:rgba(0,0,0,.06)!important;border-color:rgba(0,0,0,.1)!important;color:#7c8ca0!important}
body.light-mode .sidebar .sb-toggle:hover{background:rgba(0,0,0,.1)!important;color:#1a1a2e!important;border-color:rgba(0,0,0,.15)!important}
body.light-mode .sidebar-bottom{border-color:rgba(0,0,0,.07)!important}
body.light-mode .sb-section-hdr{color:#b0bac8!important}
body.light-mode .sidebar .nav-item{color:#5a6880!important}
body.light-mode .sidebar .nav-item:hover{background:rgba(0,0,0,.05)!important;color:#1a1a2e!important}
body.light-mode .sidebar .nav-item.active{background:rgba(99,102,241,.1)!important;color:#4338ca!important}
body.light-mode .sidebar .nav-item .ic{background:rgba(255,255,255,.7)!important;border-color:rgba(0,0,0,.08)!important;color:#7c8ca0!important}
body.light-mode .sidebar .nav-item:hover .ic{border-color:rgba(99,102,241,.3)!important;color:#6366f1!important}
body.light-mode .sidebar .nav-item.active .ic{background:rgba(99,102,241,.12)!important;border-color:rgba(99,102,241,.3)!important;color:#6366f1!important}
body.light-mode .sb-sess{color:#5a6880!important;border-radius:8px!important}
body.light-mode .sb-sess:hover{background:rgba(0,0,0,.05)!important;color:#1a1a2e!important}
body.light-mode .sb-sess.active{background:rgba(99,102,241,.1)!important;color:#4338ca!important}
body.light-mode .sb-badge{background:rgba(0,0,0,.07)!important;border:none!important;color:#7c8ca0!important}
body.light-mode .sb-sess.active .sb-badge{background:rgba(99,102,241,.15)!important;color:#6366f1!important}
body.light-mode .sb-dot{background:#c5d0de!important}
body.light-mode .sb-dots-menu{background:#fff!important;border:none!important;box-shadow:0 8px 32px rgba(0,0,0,.14)!important}
body.light-mode .sb-dots-menu button{color:#5a6880!important}
body.light-mode .sb-dots-menu button:hover{background:#f5f6f8!important;color:#1a1a2e!important}
body.light-mode .sb-trash-hdr{border-color:rgba(0,0,0,.07)!important;color:#b0bac8!important}
body.light-mode .sb-user-chip:hover{background:rgba(0,0,0,.05)!important}
body.light-mode .sb-user-name{color:#1a1a2e!important}
body.light-mode .sb-cfg-panel{border-color:rgba(0,0,0,.07)}
body.light-mode .sb-cfg-row{color:#7c8ca0}
body.light-mode .sb-switch-track{background:#c5d0de}
/* ── main areas ── */
body.light-mode .main{background:transparent!important;color:#1a1a2e!important}
body.light-mode .page{background:transparent!important;color:#1a1a2e!important}
body.light-mode .content{background:transparent!important;color:#1a1a2e!important}
/* ── topbars — glassmorphism ── */
body.light-mode .topbar{
  background:rgba(255,255,255,.75)!important;
  backdrop-filter:blur(16px)!important;
  border-color:rgba(0,0,0,.06)!important}
body.light-mode .page-title{color:#1a1a2e!important;font-weight:700!important}
body.light-mode .topbar-sub{color:#7c8ca0!important}
/* ── statsbar — flutuante ── */
body.light-mode .statsbar{
  background:rgba(255,255,255,.65)!important;
  backdrop-filter:blur(12px)!important;
  border-color:rgba(0,0,0,.05)!important}
body.light-mode .stat-updated{color:#b0bac8!important}
/* ── stat chips — pill refinado ── */
body.light-mode .stat-active{background:rgba(34,197,94,.1)!important;border-color:rgba(34,197,94,.22)!important}
body.light-mode .stat-finished{background:rgba(249,115,22,.09)!important;border-color:rgba(249,115,22,.22)!important}
body.light-mode .stat-waiting{background:rgba(245,158,11,.08)!important;border-color:rgba(245,158,11,.2)!important}
body.light-mode .stat-paused{background:rgba(0,0,0,.05)!important;border-color:rgba(0,0,0,.1)!important;color:#7c8ca0!important}
body.light-mode .stat-trash{background:rgba(0,0,0,.04)!important;border-color:rgba(0,0,0,.08)!important;color:#b0bac8!important}
/* ── section headers ── */
body.light-mode .sec-line{background:rgba(0,0,0,.08)!important}
body.light-mode .sec-count{background:rgba(255,255,255,.7)!important;border:none!important;box-shadow:0 1px 4px rgba(0,0,0,.08)!important;color:#7c8ca0!important}
body.light-mode .sec-label{color:#1a1a2e!important}
/* ── search ── */
body.light-mode .search-wrap input{
  background:rgba(255,255,255,.9)!important;border:none!important;
  box-shadow:0 2px 12px rgba(0,0,0,.09)!important;color:#1a1a2e!important}
body.light-mode .search-wrap input::placeholder{color:#b0bac8!important}
body.light-mode .search-wrap input:focus{box-shadow:0 2px 12px rgba(99,102,241,.2)!important}
body.light-mode .search-icon{color:#b0bac8!important}
body.light-mode .trash-toggle{
  background:rgba(255,255,255,.8)!important;border:none!important;
  box-shadow:0 1px 6px rgba(0,0,0,.08)!important;color:#7c8ca0!important}
body.light-mode .trash-toggle:hover{color:#6366f1!important;box-shadow:0 2px 12px rgba(99,102,241,.15)!important}
body.light-mode .trash-toggle.active{color:#6366f1!important;background:rgba(99,102,241,.1)!important}
/* ── session cards — sem border, só sombra ── */
body.light-mode .card{
  background:#fff!important;border:none!important;
  box-shadow:0 2px 16px rgba(0,0,0,.07)!important}
body.light-mode .card:hover{
  background:#fff!important;border:none!important;transform:translateY(-2px)!important;
  box-shadow:0 8px 32px rgba(0,0,0,.11)!important}
body.light-mode .card-title{color:#1a1a2e!important;font-weight:600!important}
body.light-mode .card-preview{color:#7c8ca0!important}
body.light-mode .card-msgs{color:#b0bac8!important}
body.light-mode .card-time{color:#b0bac8!important}
body.light-mode .card-badge{background:rgba(0,0,0,.06)!important;border:none!important;color:#7c8ca0!important}
body.light-mode .cb-box{border-color:#c5d0de!important}
body.light-mode .bulk-bar{background:rgba(255,255,255,.92)!important;border:none!important;box-shadow:0 8px 40px rgba(0,0,0,.14)!important;backdrop-filter:blur(12px)!important}
body.light-mode .bulk-cnt{color:#6366f1!important}
body.light-mode .bulk-btn{background:rgba(0,0,0,.05)!important;border:none!important;color:#7c8ca0!important}
body.light-mode .bulk-btn:hover{background:rgba(0,0,0,.09)!important;color:#1a1a2e!important}
body.light-mode .bulk-sep{background:rgba(0,0,0,.1)!important}
body.light-mode .bulk-cancel{color:#b0bac8!important}
/* ── dashboard panels ── */
body.light-mode .stat{background:#fff!important;border:none!important;box-shadow:0 2px 16px rgba(0,0,0,.07)!important}
body.light-mode .stat-value{color:#1a1a2e!important}
body.light-mode .stat-sub{color:#7c8ca0!important}
body.light-mode .section{background:transparent!important;border:none!important;box-shadow:none!important}
body.light-mode .section h2{color:#b0bac8!important}
body.light-mode .msg{background:#f5f6f8!important}
body.light-mode .msg-content{color:#374151!important}
body.light-mode .msg-time{color:#b0bac8!important}
body.light-mode .msg-role.user{color:#6366f1!important}
body.light-mode .msg-role.assistant{color:#059669!important}
body.light-mode .empty{color:#b0bac8!important}
body.light-mode .box{background:#fff!important;border:none!important;box-shadow:0 2px 16px rgba(0,0,0,.07)!important}
body.light-mode .box-h{border-color:rgba(0,0,0,.07)!important;color:#7c8ca0!important}
body.light-mode table th{border-color:rgba(0,0,0,.07)!important;color:#7c8ca0!important}
body.light-mode table td{border-color:rgba(0,0,0,.05)!important;color:#374151!important}
body.light-mode table tr:hover td{background:rgba(0,0,0,.02)!important}
body.light-mode .btn{background:rgba(255,255,255,.9)!important;border:none!important;box-shadow:0 1px 8px rgba(0,0,0,.09)!important;color:#5a6880!important}
body.light-mode .btn:hover{box-shadow:0 4px 16px rgba(99,102,241,.2)!important;color:#6366f1!important}
body.light-mode .btn.solid{background:#6366f1!important;color:#fff!important;box-shadow:0 4px 16px rgba(99,102,241,.35)!important}
body.light-mode .search{background:rgba(255,255,255,.9)!important;border:none!important;box-shadow:0 1px 8px rgba(0,0,0,.08)!important;color:#1a1a2e!important}
body.light-mode .search:focus{box-shadow:0 1px 8px rgba(99,102,241,.2)!important}
body.light-mode .tile{background:#fff!important;border:none!important;box-shadow:0 2px 14px rgba(0,0,0,.07)!important}
body.light-mode .tile:hover{box-shadow:0 6px 24px rgba(0,0,0,.1)!important}
body.light-mode .ct-card{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .p-card{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .proj{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .lc{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .pbar{background:rgba(0,0,0,.08)!important}
body.light-mode .ct-bar{background:rgba(0,0,0,.07)!important}
body.light-mode .chip{background:rgba(0,0,0,.07)!important;border:none!important;color:#7c8ca0!important}
body.light-mode .pill{background:rgba(0,0,0,.06)!important}
body.light-mode .alertbar{background:rgba(245,158,11,.08)!important;border-color:rgba(245,158,11,.25)!important}
body.light-mode .p-content{background:transparent!important}
body.light-mode .usage-item .u-bar{background:rgba(0,0,0,.1)!important}
body.light-mode .usage-item .u-pct{color:#1a1a2e!important}
/* ── automações ── */
body.light-mode .job{background:#fff!important;border:none!important;box-shadow:0 2px 16px rgba(0,0,0,.07)!important}
body.light-mode .modal{background:#fff!important;border:none!important;box-shadow:0 20px 70px rgba(0,0,0,.14)!important}
body.light-mode .fi{background:#f5f6f8!important;border:1px solid rgba(0,0,0,.08)!important;color:#1a1a2e!important}
body.light-mode .fi:focus{border-color:#6366f1!important}
body.light-mode .overlay{background:rgba(15,23,42,.45)!important;backdrop-filter:blur(4px)!important}
body.light-mode .x:hover{background:rgba(0,0,0,.06)!important;color:#1a1a2e!important}
body.light-mode .abtn{border-color:rgba(0,0,0,.1)!important;color:#7c8ca0!important}
body.light-mode .abtn:hover{border-color:#6366f1!important;color:#6366f1!important;background:rgba(99,102,241,.07)!important}
body.light-mode .badge.deliver{background:rgba(0,0,0,.06)!important;border:none!important;color:#7c8ca0!important}
body.light-mode .health{background:#fff!important;border:none!important;box-shadow:0 1px 8px rgba(0,0,0,.08)!important}
/* ── admin / colaboradores ── */
body.light-mode .collab-card{background:#fff!important;border:none!important;box-shadow:0 2px 16px rgba(0,0,0,.07)!important}
body.light-mode .stat-mini{background:rgba(0,0,0,.05)!important}
body.light-mode .budget-bar-track{background:rgba(0,0,0,.09)!important}
body.light-mode .dstat{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .panel{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .panel-full{background:#fff!important;border:none!important;box-shadow:0 2px 12px rgba(0,0,0,.06)!important}
body.light-mode .bar-track{background:rgba(0,0,0,.09)!important}
body.light-mode .assessment-box{background:#f5f6f8!important;border:none!important;color:#374151!important}
body.light-mode .task-item{background:rgba(255,255,255,.8)!important;border:none!important;box-shadow:0 1px 6px rgba(0,0,0,.07)!important}
body.light-mode .task-add-row input{background:#f5f6f8!important;border:1px solid rgba(0,0,0,.09)!important;color:#1a1a2e!important}
body.light-mode .sess-item:hover{background:rgba(0,0,0,.04)!important}
body.light-mode .btn-primary{background:#6366f1!important;color:#fff!important}
body.light-mode .btn-danger{background:none!important;border:1px solid rgba(239,68,68,.25)!important;color:#dc2626!important}
body.light-mode .btn-success{background:#dcfce7!important;color:#16a34a!important;border:none!important}
body.light-mode .GET{background:#f0fdf4!important;color:#16a34a!important}
body.light-mode .POST{background:#eef2ff!important;color:#6366f1!important}
body.light-mode .PATCH,.light-mode .PUT{background:#fefce8!important;color:#ca8a04!important}
body.light-mode .DELETE{background:#fef2f2!important;color:#dc2626!important}
/* ── chat — header (usa <header> não .topbar) ── */
body.light-mode header{background:rgba(255,255,255,.82)!important;border-color:rgba(0,0,0,.07)!important;backdrop-filter:blur(16px)!important}
body.light-mode .session-title{color:#1a1a2e!important}
body.light-mode .session-id{color:#7c8ca0!important}
body.light-mode .back{color:#7c8ca0!important}
body.light-mode .back:hover{background:rgba(0,0,0,.06)!important;color:#1a1a2e!important}
body.light-mode .btn-rename{color:#b0bac8!important}
body.light-mode .btn-rename:hover{color:#7c8ca0!important;background:rgba(0,0,0,.05)!important}
body.light-mode .btn-view{border-color:rgba(0,0,0,.1)!important;color:#7c8ca0!important;background:rgba(255,255,255,.7)!important}
body.light-mode .btn-view:hover{color:#1a1a2e!important}
body.light-mode .btn-view.clean-on{border-color:#6366f1!important;color:#6366f1!important;background:rgba(99,102,241,.08)!important}
/* ── chat page ── */
body.light-mode .tl-more{background:rgba(255,255,255,.8)!important;border:none!important;box-shadow:0 1px 6px rgba(0,0,0,.08)!important;color:#7c8ca0!important}
body.light-mode .tl-more:hover{background:rgba(99,102,241,.08)!important;color:#6366f1!important}
body.light-mode .plus-menu{background:#fff!important;border:none!important;box-shadow:0 8px 32px rgba(0,0,0,.12)!important}
body.light-mode .plus-opt{color:#5a6880!important}
body.light-mode .plus-opt:hover{background:#f5f6f8!important;color:#1a1a2e!important}
body.light-mode .attach-chip{background:rgba(99,102,241,.09)!important;border:none!important;color:#6366f1!important}
body.light-mode #new-sess-box{background:#fff!important;border:none!important;box-shadow:0 20px 60px rgba(0,0,0,.12)!important}
body.light-mode #new-sess-msg{background:#f5f6f8!important;border:1px solid rgba(0,0,0,.09)!important;color:#1a1a2e!important}
body.light-mode .btn-ns-cancel{background:#f5f6f8!important;color:#7c8ca0!important;border:none!important}
body.light-mode .btn-ns-cancel:hover{background:rgba(0,0,0,.08)!important;color:#1a1a2e!important}
/* ── dashboard — topbar e subnav ── */
body.light-mode .subnav{
  background:rgba(255,255,255,.72)!important;backdrop-filter:blur(14px)!important;
  border-bottom:1px solid rgba(0,0,0,.06)!important}
body.light-mode .subnav a{
  background:rgba(255,255,255,.8)!important;border:none!important;
  box-shadow:0 1px 6px rgba(0,0,0,.08)!important;color:#7c8ca0!important}
body.light-mode .subnav a:hover{
  color:#fff!important;background:linear-gradient(135deg,#6366f1,#8b5cf6)!important;
  box-shadow:0 4px 16px rgba(99,102,241,.35)!important}
body.light-mode .subnav a.active{
  color:#fff!important;background:linear-gradient(135deg,#6366f1,#8b5cf6)!important;
  box-shadow:0 4px 16px rgba(99,102,241,.35)!important}
body.light-mode .topbar-title{
  background:linear-gradient(92deg,#312e81,#6366f1 55%,#8b5cf6)!important;
  -webkit-background-clip:text!important;background-clip:text!important;-webkit-text-fill-color:transparent!important}
body.light-mode .hsec-h{color:#0f172a!important;border-color:rgba(0,0,0,.08)!important}
body.light-mode .oc-topbar{background:rgba(255,255,255,.8)!important;border-color:rgba(0,0,0,.07)!important;backdrop-filter:blur(12px)!important}
/* ── chat — timeline e mensagens ── */
body.light-mode .tl-item::before{background:rgba(0,0,0,.1)!important}
body.light-mode .tl-item .dot{border-color:transparent!important}
body.light-mode .tl-user{
  background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(139,92,246,.07))!important;
  border:none!important;color:#3730a3!important}
body.light-mode .tl-say{color:#1e293b!important}
body.light-mode .tl-say h1,body.light-mode .tl-say h2,body.light-mode .tl-say h3,body.light-mode .tl-say h4{color:#0f172a!important}
body.light-mode .tl-say strong{color:#0f172a!important}
body.light-mode .tl-say em{color:#475569!important}
body.light-mode .tl-say a{color:#6366f1!important}
body.light-mode .tl-say code{background:#f1f5f9!important;border-color:#e2e8f0!important;color:#6366f1!important}
body.light-mode .tl-say pre{background:#f8fafc!important;border-color:#e2e8f0!important}
body.light-mode .tl-say pre code{color:#374151!important}
body.light-mode .tl-say blockquote{border-color:#6366f1!important;color:#64748b!important}
body.light-mode .tl-say td,body.light-mode .tl-say th{border-color:#e2e8f0!important}
body.light-mode .tl-say hr{border-color:#e2e8f0!important}
body.light-mode .tl-io{background:rgba(255,255,255,.85)!important;border:none!important;box-shadow:0 1px 8px rgba(0,0,0,.08)!important}
body.light-mode .tl-io .io-tag{background:#f1f5f9!important;border-color:rgba(0,0,0,.07)!important;color:#94a3b8!important}
body.light-mode .tl-io pre{color:#374151!important;background:transparent!important}
body.light-mode .tl-io pre.out{color:#64748b!important}
body.light-mode .tl-fold{color:#94a3b8!important}
body.light-mode .tl-fold:hover{background:#f1f5f9!important;color:#6366f1!important}
body.light-mode .tl-item.tool .tt-name{color:#1e293b!important}
/* chat — input / composer */
body.light-mode .composer{background:#fff!important;border-color:#e2e8f0!important}
body.light-mode .composer-inner{background:#f8fafc!important;border-color:#e2e8f0!important}
body.light-mode .composer-inner:focus-within{border-color:#6366f1!important;box-shadow:0 0 0 3px rgba(99,102,241,.1)!important}
body.light-mode .composer-divider{background:#e2e8f0!important}
body.light-mode .composer-meta{color:#94a3b8!important}
body.light-mode #input{color:#1e293b!important}
body.light-mode #input::placeholder{color:#94a3b8!important}
body.light-mode .comp-btn{color:#94a3b8!important}
body.light-mode .comp-btn:hover{background:rgba(0,0,0,.05)!important;color:#475569!important}
body.light-mode #plus-btn{color:#94a3b8!important}
/* bubble (dashboard preview) */
body.light-mode .bubble.md h1,body.light-mode .bubble.md h2{color:#0f172a!important}
body.light-mode .bubble.md h3{color:#1e293b!important}
body.light-mode .bubble.md strong{color:#0f172a!important}
body.light-mode .bubble.md em{color:#475569!important}
body.light-mode .bubble.md a{color:#6366f1!important}
body.light-mode .bubble.md code{background:#f1f5f9!important;border-color:#e2e8f0!important;color:#6366f1!important}
body.light-mode .bubble.md pre{background:#f8fafc!important;border-color:#e2e8f0!important}
body.light-mode .bubble.md pre code{color:#374151!important}
body.light-mode .bubble.md td,body.light-mode .bubble.md th{border-color:#e2e8f0!important}
body.light-mode .bubble.md hr{border-color:#e2e8f0!important}
`
const navItem = (href, iconKey, label, active, blank = false) =>
  `<a href="${href}" class="nav-item${href === active ? ' active' : ''}" title="${label}"${blank ? ' target="_blank"' : ''}><span class="ic">${ICONS[iconKey] || ''}</span><span class="lbl">${label}</span></a>`

function renderSidebar(active, user = {}) {
  const isSess = active === '/sessions' || (active && active.startsWith('/sessions/'))
  const isOwner = user.role === 'owner'
  const avatarColor = user.avatar_color || '#6366f1'
  const displayName = user.display_name || user.username || ''
  const userInitial = displayName.charAt(0).toUpperCase() || '?'
  const adminLink = isOwner
    ? `${navItem('/admin', 'shield', 'Admin', active)}
        ${navItem('/colaboradores', 'users', 'Colaboradores', active)}`
    : ''
  const ownerLinks = isOwner ? `
        ${navItem('/brain', 'brain', 'Cérebro (ao vivo)', active)}
        ${navItem('/academia', 'cap', 'Academia da Memória', active)}
        <div class="nav-section-label" style="margin-top:6px">Documentação</div>
        ${navItem('/d/doc-visao', 'compass', 'Visão &amp; Estratégia', active)}
        ${navItem('/d/doc-arquitetura', 'blocks', 'Arquitetura', active)}
        ${navItem('/d/doc-claudemds', 'file', 'CLAUDE.md', active)}
        ${navItem('/d/doc-progresso', 'checks', 'Progresso', active)}
        <div class="nav-section-label" style="margin-top:6px">Sistema</div>
        ${navItem('/api/memories', 'code', 'Memórias (API)', active, true)}
        ${navItem('/automacoes', 'clock', 'Automações', active)}
        ${adminLink}` : `
        ${adminLink}`
  return `<script>if(localStorage.getItem('orion_theme')==='light')document.body.classList.add('light-mode')<\/script>
<style>${SIDEBAR_CSS}
.sb-user-chip{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background .15s;text-decoration:none;color:inherit}
.sb-user-chip:hover{background:rgba(255,255,255,.05)}
.sb-avatar{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}
.sb-user-info{min-width:0;flex:1}
.sb-user-name{font-size:12px;font-weight:600;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-user-role{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
</style>
  <div id="sb-overlay"></div>
  <button id="mob-ham" aria-label="Menu">☰</button>
  <aside class="sidebar${isSess ? ' sess-mode' : ''}" id="sbMain" style="transition:none">
    <div class="sidebar-brand">
      <div class="brand-icon">⚡</div>
      <div class="brand-txt"><div class="brand-name">Orion</div><div class="brand-sub">agente autônomo</div></div>
      <button class="sb-toggle" onclick="sbToggle()" title="Recolher menu">${ICONS.panel}</button>
    </div>
    <div id="sb-menu">
      <nav class="sidebar-nav">
        <div class="nav-section-label">Principal</div>
        ${navItem('/', 'home', 'Dashboard', active)}
        ${isOwner ? navItem('/d/agent', 'agent', 'Orion', active) : ''}
        <a href="/sessions" class="nav-item${active==='/sessions'||active?.startsWith('/sessions/')?' active':''}" title="Sessões Claude"><span class="ic">${ICONS.chat||''}</span><span class="lbl">Sessões Claude</span></a>
        <a href="#" class="nav-item" title="Arquivos" onclick="return sbFiles(event)"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span><span class="lbl">Arquivos</span></a>
        ${ownerLinks}
      </nav>
      <div class="sidebar-bottom">
        <a href="/admin/profile" class="sb-user-chip" title="Meu perfil">
          <div class="sb-avatar" style="background:${avatarColor}">${userInitial}</div>
          <div class="sb-user-info">
            <div class="sb-user-name">${displayName}</div>
            <div class="sb-user-role">${user.role === 'owner' ? 'Adm' : 'colaborador'}</div>
          </div>
        </a>
        <button class="nav-item" onclick="sbToggleCfg()" title="Configurações"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span><span class="lbl">Configurações</span></button>
        <div class="sb-cfg-panel" id="sb-cfg-panel">
          <div class="sb-cfg-row">
            <span class="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>Modo claro</span>
            <label class="sb-switch" title="Alternar modo claro/escuro">
              <input type="checkbox" id="sb-theme-toggle" onchange="sbToggleTheme(this.checked)">
              <span class="sb-switch-track"></span>
              <span class="sb-switch-thumb"></span>
            </label>
          </div>
        </div>
        <a href="/logout" class="nav-item" title="Sair"><span class="ic">${ICONS.logout||''}</span><span class="lbl">Sair</span></a>
      </div>
      <script>
      (function(){
        const isLight=localStorage.getItem('orion_theme')==='light'
        if(isLight){ document.body.classList.add('light-mode') }
        const cb=document.getElementById('sb-theme-toggle')
        if(cb) cb.checked=isLight
      })()
      window.sbToggleCfg=function(){
        const p=document.getElementById('sb-cfg-panel')
        if(p) p.classList.toggle('open')
      }
      window.sbToggleTheme=function(isLight){
        document.body.classList.toggle('light-mode',isLight)
        localStorage.setItem('orion_theme',isLight?'light':'dark')
      }
      </script>
    </div>
    <div id="sb-sessions">
      <button class="sb-back" onclick="sbBackMenu()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M15 18l-6-6 6-6"/></svg>
        Menu principal
      </button>
      <button class="sb-new-sess" onclick="sbNewSession()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><path d="M12 5v14M5 12h14"/></svg>
        Nova sessão
      </button>
      <input id="sb-sess-search" class="sb-search" placeholder="Buscar sessão…" oninput="sbFilter(this.value)">
      <div id="sb-sess-list" class="sb-sess-list"><div class="sb-sess-empty">Carregando…</div></div>
    </div>
    <div id="sb-files">
      <button class="sb-back" onclick="sbBackMenu()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M15 18l-6-6 6-6"/></svg>
        Menu principal
      </button>
      <div class="ft-actions">
        <button class="ft-act" title="Novo arquivo" aria-label="Novo arquivo" onclick="ftNewFile()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg></button>
        <button class="ft-act" title="Nova pasta" aria-label="Nova pasta" onclick="ftNewFolder()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg></button>
        <span class="ft-act-sep"></span>
        <button class="ft-act" title="Atualizar" aria-label="Atualizar lista de arquivos" onclick="ftRefresh()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        <button class="ft-act" title="Recolher todas as pastas" aria-label="Recolher todas as pastas" onclick="ftCollapseAll()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
      </div>
      <input class="ft-search" id="ft-search" placeholder="Filtrar arquivos…" oninput="ftFilter(this.value)">
      <div class="ft-tree" id="ft-tree"><div style="padding:8px;color:#4b5563;font-size:12px">Carregando…</div></div>
    </div>
    <div id="sb-resize-handle"></div>
  </aside>
  <script src="/static/sidebar.js"></script>`
}
const injectSidebar = (html, active, user = {}) => html.replace('<!--SIDEBAR-->', renderSidebar(active, user))
const injectAll = (html, active, user = {}) =>
  html.replace('<!--SIDEBAR-->', renderSidebar(active, user)).replace('<!--TABS-->', '')

// Barra de abas estilo navegador (sessões + arquivos) — client-side via localStorage
const TABBAR_BLOCK = `
<style>
#orion-tabs{display:flex;align-items:center;gap:2px;background:#0a0a0f;border-bottom:1px solid #1e1e2e;padding:6px 10px 0;overflow-x:auto;flex-shrink:0;position:relative;scrollbar-width:none}
#orion-tabs::-webkit-scrollbar{display:none}
#orion-tabs .otab{display:flex;align-items:center;gap:6px;max-width:210px;padding:7px 10px;border:1px solid #1e1e2e;border-bottom:none;border-radius:9px 9px 0 0;background:#0d0d14;color:#9ca3af;font-size:12.5px;cursor:pointer;white-space:nowrap;flex-shrink:0;margin-bottom:-1px}
#orion-tabs .otab:hover{background:#13131d;color:#e5e7eb}
#orion-tabs .otab.active{background:#111118;color:#fff;border-color:#2a2a40}
#orion-tabs .otab.file-tab{border-top-color:#2d3748}
#orion-tabs .otab.file-tab.active{border-top-color:#4a5568}
#orion-tabs .otab-icon{font-size:11px;flex-shrink:0;opacity:.7}
#orion-tabs .otab-title{overflow:hidden;text-overflow:ellipsis;max-width:150px}
#orion-tabs .otab-x{color:#4b5563;font-size:16px;line-height:1;border-radius:4px;padding:0 3px}
#orion-tabs .otab-x:hover{background:#2a2a40;color:#fca5a5}
#orion-tabs .otab-add{background:#13131d;border:1px solid #1e1e2e;color:#9ca3af;width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:18px;flex-shrink:0;margin:0 0 5px 4px;display:flex;align-items:center;justify-content:center}
#orion-tabs .otab-add:hover{background:#1a1a2e;color:#e5e7eb}
#orion-tabs .otab-menu{display:none;position:absolute;top:calc(100% - 2px);left:10px;z-index:200;background:#111118;border:1px solid #1e1e2e;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.55);max-height:400px;overflow-y:auto;min-width:300px;padding:5px}
#orion-tabs .otab-menu.show{display:block}
#orion-tabs .otab-mi{padding:8px 11px;border-radius:7px;font-size:13px;color:#cbd5e1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#orion-tabs .otab-mi:hover{background:#1a1a2e}
</style>
<div id="orion-tabs"></div>
<script>
(function(){
  const KEY='orionTabs2'
  const curSessId = location.pathname.indexOf('/sessions/')===0 ? location.pathname.split('/').pop() : null
  // Tab: { type:'session'|'file', id?, title?, path?, name? }
  let tabs=[]; try{ tabs=JSON.parse(localStorage.getItem(KEY)||'[]') }catch(e){}
  // Auto-adicionar sessão atual às abas
  if(curSessId && !tabs.find(t=>t.type==='session'&&t.id===curSessId)){
    tabs.push({type:'session',id:curSessId,title:curSessId.slice(0,8)})
  }
  const save=()=>localStorage.setItem(KEY,JSON.stringify(tabs))
  const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  save()

  function tabIcon(t){
    if(t.type==='session') return '💬'
    const ext=(t.name||'').split('.').pop().toLowerCase()
    if(['js','ts','jsx','tsx','mjs'].includes(ext)) return '📄'
    if(['json','yaml','yml'].includes(ext)) return '📋'
    if(['md','mdx'].includes(ext)) return '📝'
    if(['html','css','scss'].includes(ext)) return '🎨'
    if(['py','sh'].includes(ext)) return '⚙️'
    return '📄'
  }
  function isActive(t){
    if(t.type==='session') return t.id===curSessId
    return false // arquivo: sem URL, não pode ser "ativo" via URL
  }

  function render(){
    const bar=document.getElementById('orion-tabs'); if(!bar) return
    bar.innerHTML = tabs.map(t=>{
      const active=isActive(t)
      const cls='otab'+(active?' active':'')+(t.type==='file'?' file-tab':'')
      const key=t.type==='session'?t.id:t.path
      return '<div class="'+cls+'" data-key="'+esc(key||'')+'" data-type="'+t.type+'" title="'+(t.type==='session'?esc(t.title):esc(t.path||t.name||''))+'"><span class="otab-icon">'+tabIcon(t)+'</span><span class="otab-title">'+esc(t.type==='session'?t.title:(t.name||t.path||''))+'</span><span class="otab-x" data-close="'+esc(key||'')+'">×</span></div>'
    }).join('')
      + '<button class="otab-add" id="otabAdd" title="Abrir outra sessão">+</button><div class="otab-menu" id="otabMenu"></div>'
    bar.querySelectorAll('.otab').forEach(el=>{
      el.addEventListener('click',e=>{
        if(e.target.dataset.close) return
        const t=tabs.find(x=>(x.type==='session'?x.id:x.path)===el.dataset.key)
        if(!t) return
        if(t.type==='session'){ location.href='/sessions/'+t.id }
        else if(t.type==='file'){ window.ftOpenFile && window.ftOpenFile(t.path, t.name) }
      })
    })
    bar.querySelectorAll('.otab-x').forEach(el=>{ el.addEventListener('click',e=>{ e.stopPropagation(); closeTab(el.dataset.close) }) })
    document.getElementById('otabAdd').addEventListener('click',toggleMenu)
  }

  function closeTab(key){
    const t=tabs.find(x=>(x.type==='session'?x.id:x.path)===key)
    tabs=tabs.filter(x=>(x.type==='session'?x.id:x.path)!==key); save()
    if(t&&t.type==='session'&&t.id===curSessId){
      const next=tabs.find(x=>x.type==='session')
      location.href = next ? '/sessions/'+next.id : '/sessions'
    } else render()
  }

  async function toggleMenu(){
    const menu=document.getElementById('otabMenu')
    if(menu.classList.contains('show')){ menu.classList.remove('show'); return }
    menu.innerHTML='<div class="otab-mi" style="color:#6b7280">Carregando…</div>'; menu.classList.add('show')
    try{
      const d=await fetch('/api/claude-sessions?limit=80').then(r=>r.json())
      const ss=(d.sessions||[]).filter(s=>!s.hidden)
      menu.innerHTML = ss.map(s=>{ const title=s.custom_title||s.ai_title||s.first_user_msg||s.id.slice(0,8); return '<div class="otab-mi" data-open="'+s.id+'">💬 '+esc(title)+'</div>' }).join('') || '<div class="otab-mi" style="color:#6b7280">nenhuma sessão</div>'
      menu.querySelectorAll('.otab-mi').forEach(el=>{ el.addEventListener('click',()=>{ if(el.dataset.open) location.href='/sessions/'+el.dataset.open }) })
    }catch(e){ menu.innerHTML='<div class="otab-mi">erro ao carregar</div>' }
  }

  window.orionSetTabTitle=function(title){
    const t=tabs.find(x=>x.type==='session'&&x.id===curSessId)
    if(t&&title){ t.title=title; save(); render() }
  }
  // Abrir arquivo como aba (chamado pelo ftOpenFile do sidebar)
  window.orionOpenFiletab=async function(path, name){
    if(!tabs.find(t=>t.type==='file'&&t.path===path)){
      tabs.push({type:'file',path,name}); save()
    }
    render()
    // Buscar conteúdo e abrir editor
    const res=await fetch('/api/fs/read?path='+encodeURIComponent(path)).then(r=>r.json()).catch(e=>({error:e.message}))
    if(res.error){ alert(res.error); return }
    window.ftShowEditor && window.ftShowEditor(path, name, res.content)
  }
  document.addEventListener('click',e=>{ const m=document.getElementById('otabMenu'),a=document.getElementById('otabAdd'); if(m&&!m.contains(e.target)&&e.target!==a) m.classList.remove('show') })
  render()
})()
</script>`
const injectTabs = (html) => html.replace('<!--TABS-->', TABBAR_BLOCK)

const PANEL_TOKEN   = process.env.PANEL_TOKEN ?? ''
const PANEL_API_URL = process.env.PANEL_API_URL ?? 'http://172.18.0.1:9099'
const PANEL_JSON_DIR = '/config/workspace/pages/orion'

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.send(loginHtml.replace('{{errorClass}}', '').replace('{{errorMsg}}', ''))
})

app.post('/login', (req, res) => {
  const { username, password } = req.body
  const result = login(username, password)
  if (!result) {
    res.send(loginHtml.replace('{{errorClass}}', 'show').replace('{{errorMsg}}', 'Usuário ou senha incorretos'))
    return
  }
  res.cookie('orion_auth', result.token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 })
  res.redirect('/')
})

app.get('/api/me', (req, res) => {
  const db = getDb()
  const user = db.prepare('SELECT id, username, display_name, role, avatar_color, last_login_at FROM users WHERE id = ?').get(req.user.id)
  res.json({ user: user || req.user })
})

app.post('/api/me/password', (req, res) => {
  const { current, newPassword } = req.body
  try {
    changeOwnPassword(req.user.id, current, newPassword)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/logout', (req, res) => {
  res.clearCookie('orion_auth')
  res.redirect('/login')
})

// ── Static assets ─────────────────────────────────────────────────────────────
app.get('/static/sidebar.js', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.sendFile(join(__dirname, 'ui/sidebar.js'))
})

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send(injectAll(dashHtml, '/', req.user)))
// Página antiga de Fluxo de Memória foi substituída pela Academia
app.get('/d/doc-memoria', (req, res) => res.redirect('/academia'))
// Deep-link das views do painel: /d/<view> serve o mesmo dashboard; o cliente ativa a view pela URL (F5-safe)
app.get('/d/:view', (req, res) => res.send(injectAll(dashHtml, '/', req.user)))

// ── Health (sem auth) ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'orion', version: '2.0.0' })
})

// ── Evolution webhook (sem auth) ──────────────────────────────────────────────

app.use('/webhook', evolutionRouter)

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/sessions', (req, res) => {
  const db = getDb()
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY last_active DESC LIMIT 50').all()
  res.json({ sessions })
})

app.get('/api/memories', (req, res) => {
  const db = getDb()
  const { type, tag, category, limit = 50 } = req.query

  // Melhoria 3: filtro por tag ou categoria
  if (tag) {
    const memories = retrieveByTag(tag, +limit)
    return res.json({ memories, total: memories.length })
  }
  if (category) {
    const memories = retrieveByCategory(category, +limit)
    return res.json({ memories, total: memories.length })
  }

  const memories = type
    ? db.prepare('SELECT * FROM memories WHERE type = ? AND archived = 0 ORDER BY created_at DESC LIMIT ?').all(type, +limit)
    : db.prepare('SELECT * FROM memories WHERE archived = 0 ORDER BY created_at DESC LIMIT ?').all(+limit)
  const total = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0' + (type ? ' AND type = ?' : '')).get(...(type ? [type] : [])).n
  res.json({ memories, total })
})

// Melhoria 1: Feedback loop de confiança
app.post('/api/memory/:id/feedback', (req, res) => {
  const { helpful } = req.body
  if (helpful === undefined) return res.status(400).json({ error: 'helpful (bool) required' })
  const result = feedbackMemory(req.params.id, !!helpful)
  if (!result) return res.status(404).json({ error: 'memory not found' })
  res.json({ ok: true, ...result })
})

// Melhoria 2: Restore de memória arquivada
app.post('/api/memory/:id/restore', (req, res) => {
  restoreMemory(req.params.id)
  res.json({ ok: true })
})

// Melhoria 4: Multi-entity retrieval (BM25)
app.get('/api/memories/entities', (req, res) => {
  const { names, limit = 8 } = req.query
  if (!names) return res.status(400).json({ error: 'names query param required (comma-separated)' })
  const entityNames = names.split(',').map(n => n.trim()).filter(Boolean)
  const memories = retrieveForEntities(entityNames, +limit)
  res.json({ memories, total: memories.length })
})

// HRR: Multi-entity retrieval via superposição vetorial
app.get('/api/memories/entities-composed', async (req, res) => {
  const { names, limit = 8 } = req.query
  if (!names) return res.status(400).json({ error: 'names required (comma-separated)' })
  const entityNames = names.split(',').map(n => n.trim()).filter(Boolean)
  const memories = await retrieveByComposedEntities(entityNames, +limit)
  res.json({ memories, total: memories.length })
})

// HRR: probe(entity) — fatos SOBRE uma entidade
app.get('/api/memories/probe', async (req, res) => {
  const { entity, limit = 8 } = req.query
  if (!entity) return res.status(400).json({ error: 'entity required' })
  const memories = await probe(entity, +limit)
  res.json({ memories, total: memories.length })
})

// HRR: related(entity) — entidades estruturalmente conectadas
app.get('/api/memories/related', async (req, res) => {
  const { entity, limit = 8 } = req.query
  if (!entity) return res.status(400).json({ error: 'entity required' })
  const memories = await related(entity, +limit)
  res.json({ memories, total: memories.length })
})

// HRR: reason([A,B]) — AND semântico de múltiplas entidades
app.get('/api/memories/reason', async (req, res) => {
  const { entities, limit = 8 } = req.query
  if (!entities) return res.status(400).json({ error: 'entities required (comma-separated)' })
  const names = entities.split(',').map(n => n.trim()).filter(Boolean)
  const memories = await reason(names, +limit)
  res.json({ memories, total: memories.length })
})

// Batch memory ops — salva múltiplas memórias atomicamente
app.post('/api/memories/batch', (req, res) => {
  const { memories: items } = req.body
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'memories array required' })
  if (items.length > 50) return res.status(400).json({ error: 'max 50 per batch' })

  const db = getDb()
  const saved = []
  const failed = []

  // Executa em transação — tudo ou nada
  db.transaction(() => {
    for (const item of items) {
      try {
        if (!item.content || String(item.content).length < 5) throw new Error('content required')
        const id = saveMemory({
          content: item.content,
          type: item.type ?? 'raw',
          source: item.source ?? 'batch-api',
          confidence: item.confidence ?? 0.5,
          category: item.category ?? 'general',
          tags: item.tags ?? [],
        })
        saved.push({ id, content: item.content.slice(0, 60) })
      } catch (e) {
        failed.push({ content: (item.content ?? '').slice(0, 60), error: e.message })
      }
    }
  })()

  res.json({ saved: saved.length, failed: failed.length, saved_ids: saved, errors: failed })
})

// Quality Score
app.get('/api/memory/quality-metrics', (req, res) => {
  res.json(getMemoryQualityMetrics())
})

// Melhoria 5: Memory banks
app.get('/api/memory-banks', (req, res) => {
  const db = getDb()
  const banks = db.prepare('SELECT * FROM memory_banks ORDER BY sample_count DESC').all()
  res.json({ banks })
})

// Melhoria 8: Estatísticas de memória
app.get('/api/memory/stats', (req, res) => {
  const db = getDb()

  const total = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get().n
  const archivedCount = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 1').get().n

  const byTypeRows = db.prepare('SELECT type, COUNT(*) AS c FROM memories WHERE archived = 0 GROUP BY type').all()
  const by_type = {}
  for (const r of byTypeRows) by_type[r.type] = r.c

  const byCatRows = db.prepare('SELECT category, COUNT(*) AS c FROM memories WHERE archived = 0 GROUP BY category').all()
  const by_category = {}
  for (const r of byCatRows) by_category[r.category] = r.c

  const helpfulCount = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE helpful_votes > 0 AND archived = 0').get().n
  const unhelpfulCount = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE unhelpful_votes > 0 AND archived = 0').get().n

  const contradictionsCount = db.prepare(`
    SELECT COUNT(*) AS n FROM memories
    WHERE archived = 0 AND json_extract(metadata, '$.contradiction_with') IS NOT NULL
  `).get().n

  const banks = db.prepare('SELECT category FROM memory_banks').all().map(b => b.category)

  // Cobertura vetorial
  let vecCoverage = 0
  try {
    const totalActive = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get().n
    const withVec = db.prepare(`
      SELECT COUNT(*) AS n FROM memories m
      JOIN vec_memories v ON m.rowid = v.memory_rowid
      WHERE m.archived = 0
    `).get().n
    vecCoverage = totalActive > 0 ? Math.round((withVec / totalActive) * 100) / 100 : 0
  } catch {}

  res.json({
    total,
    by_type,
    by_category,
    archived: archivedCount,
    with_feedback: { helpful: helpfulCount, unhelpful: unhelpfulCount },
    contradictions_detected: contradictionsCount,
    banks,
    vec_coverage: vecCoverage,
  })
})

app.get('/api/messages', (req, res) => {
  const db = getDb()
  const { limit = 20 } = req.query
  const messages = db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?').all(+limit)
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
  res.json({ messages, total })
})

app.get('/api/cron', (req, res) => {
  res.json({ jobs: listJobs() })
})

// Rotas estáticas ANTES de /:id para evitar captura por param
app.get('/api/cron/blueprints', (req, res) => {
  res.json({ blueprints: BLUEPRINTS.map(b => ({ id: b.id, name: b.name, description: b.description, category: b.category, scheduleLabel: b.scheduleLabel, slots: b.slots })) })
})

app.get('/api/cron/health', (req, res) => {
  const HEARTBEAT = '/config/workspace/orion/data/cron-heartbeat'
  let lastBeat = null, ageSeconds = null
  try {
    if (existsSync(HEARTBEAT)) {
      lastBeat = parseInt(readFileSync(HEARTBEAT, 'utf8'), 10)
      ageSeconds = Math.floor(Date.now() / 1000) - lastBeat
    }
  } catch {}
  res.json({ healthy: ageSeconds !== null && ageSeconds < 300, lastBeat, ageSeconds, jobs: listJobs().length })
})

app.post('/api/cron', (req, res) => {
  try {
    const { name, description, schedule, taskPrompt, script, noAgent, model,
            contextFrom, skipIfRecent, repeatN, deliver, workdir, targetSession } = req.body
    if (!schedule || !taskPrompt) return res.status(400).json({ error: 'schedule e taskPrompt obrigatórios' })
    const id = createJob({
      name: name ?? taskPrompt.slice(0, 50), description, schedule, taskPrompt,
      script, noAgent, model, contextFrom: contextFrom ?? [],
      skipIfRecent, repeatN, deliver: deliver ?? 'whatsapp', workdir, targetSession,
      createdBy: 'api',
    })
    res.json({ ok: true, id })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/cron/:id/pause', (req, res) => {
  try {
    pauseJob(req.params.id, req.body?.reason ?? null)
    res.json({ ok: true })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/cron/:id/resume', (req, res) => {
  try {
    resumeJob(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.delete('/api/cron/:id', (req, res) => {
  try {
    deleteJob(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/cron/:id/run', async (req, res) => {
  try {
    const job = getJobById(req.params.id)
    if (!job) return res.status(404).json({ error: 'Job não encontrado' })
    res.json({ ok: true, message: 'Disparando job...' })
    triggerJob(req.params.id).catch(err => logger.error({ err, jobId: req.params.id }, 'trigger manual falhou'))
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.get('/api/cron/:id', (req, res) => {
  const job = getJobById(req.params.id)
  if (!job) return res.status(404).json({ error: 'Não encontrado' })
  res.json({ job })
})

app.get('/api/cron/:id/output', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100)
  res.json({ output: getJobOutput(req.params.id, limit) })
})


app.get('/api/wa/status', async (req, res) => {
  try {
    const r = await fetch(
      `${process.env.EVOLUTION_API_URL}/instance/connectionState/${process.env.EVOLUTION_INSTANCE}`,
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    )
    const state = await r.json()
    const status = state?.instance?.state ?? state?.state ?? 'unknown'

    if (status === 'open') {
      res.json({ status: 'open', number: state?.instance?.profilePictureUrl ? process.env.WHATSAPP_OWNER_JID : '' })
      return
    }

    // Tentar pegar QR
    const qRes = await fetch(
      `${process.env.EVOLUTION_API_URL}/instance/connect/${process.env.EVOLUTION_INSTANCE}`,
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    )
    const qData = await qRes.json()
    res.json({ status, qr: qData.base64 ?? null })
  } catch (e) {
    res.json({ status: 'error', error: e.message })
  }
})

// ── CLAUDE.md files ───────────────────────────────────────────────────────────

const ALLOWED_CLAUDE_MDS = {
  global:        '/config/.claude/CLAUDE.md',
  workspace:     '/config/workspace/CLAUDE.md',
  brandspace:    '/config/workspace/brandspace/CLAUDE.md',
  trackingmachine: '/config/workspace/trackingmachine/CLAUDE.md',
  ralab:         '/config/workspace/ralab/CLAUDE.md',
  fisioexpert:   '/config/workspace/fisioexpert/CLAUDE.md',
  abcprime:      '/config/workspace/abcprime/CLAUDE.md',
  orion:         '/config/workspace/orion/CLAUDE.md',
}

app.get('/api/claudemd', (req, res) => {
  const key = req.query.key
  const path = ALLOWED_CLAUDE_MDS[key]
  if (!path) return res.status(400).json({ error: 'chave inválida' })
  try {
    const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
    res.json({ key, path, content, exists: existsSync(path) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/claudemd', (req, res) => {
  const { key, content } = req.body
  const path = ALLOWED_CLAUDE_MDS[key]
  if (!path) return res.status(400).json({ error: 'chave inválida' })
  try {
    writeFileSync(path, content, 'utf8')
    res.json({ ok: true, path })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/claudemd/list', (req, res) => {
  const list = Object.entries(ALLOWED_CLAUDE_MDS).map(([key, path]) => ({
    key,
    path,
    exists: existsSync(path),
    size: existsSync(path) ? readFileSync(path, 'utf8').length : 0,
  }))
  res.json({ files: list })
})

// ── Context Pipeline ──────────────────────────────────────────────────────────

app.get('/api/context', contextHandler)

// ── Delegate ──────────────────────────────────────────────────────────────────

app.post('/api/delegate', async (req, res) => {
  const { goal, role = 'executor', project = null, sessionName = null, context = '' } = req.body
  if (!goal) return res.status(400).json({ error: 'goal required' })
  try {
    const result = await delegate({ goal, role, project, sessionName, context })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/orchestrate-v2', async (req, res) => {
  const { message, project = null } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })
  try {
    const result = await orchestrate(message, { project })
    res.json({ result: result ?? 'Falhou', ok: !!result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/registry', (req, res) => {
  try {
    const sessions = listActiveSessions()
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Métricas (séries temporais por container/pm2/servidor) ──────────────────
const METRICS_DB = '/config/workspace/pages/orion/metrics.db'
function _openMetrics() { const D = _require('better-sqlite3'); return new D(METRICS_DB, { readonly: true, fileMustExist: true }) }

app.get('/api/metrics/entities', (req, res) => {
  try {
    const db = _openMetrics()
    const since = Math.floor(Date.now() / 1000) - 7200
    const rows = db.prepare('SELECT DISTINCT kind, name FROM metrics WHERE ts >= ? ORDER BY kind, name').all(since)
    db.close()
    const out = { server: [], container: [], pm2: [] }
    for (const r of rows) { if (out[r.kind] && !out[r.kind].includes(r.name)) out[r.kind].push(r.name) }
    res.json(out)
  } catch (e) { res.json({ server: [], container: [], pm2: [] }) }
})

app.get('/api/metrics', (req, res) => {
  try {
    const kind = req.query.kind || 'container'
    const name = req.query.name || ''
    const metric = ['cpu', 'mem_mb', 'mem_pct', 'swap_pct', 'disk_pct'].includes(req.query.metric) ? req.query.metric : 'cpu'
    const RANGES = { '1h': [3600, 60], '1d': [86400, 300], '1w': [604800, 3600], '1mo': [2592000, 3600] }
    const [win, bucket] = RANGES[req.query.range] || RANGES['1d']
    const now = Math.floor(Date.now() / 1000)
    const db = _openMetrics()
    const rows = db.prepare(
      `SELECT (ts/${bucket})*${bucket} AS t, ROUND(AVG(${metric}),1) AS v
       FROM metrics WHERE kind=? AND name=? AND ts>=? AND ${metric} IS NOT NULL
       GROUP BY t ORDER BY t`
    ).all(kind, name, now - win)
    db.close()
    res.json({ kind, name, metric, range: req.query.range || '1d', points: rows })
  } catch (e) { res.json({ points: [], error: String(e.message || e) }) }
})

// ── Painel (panel.bayerl.cloud migrado) ───────────────────────────────────────

app.get('/panel', (req, res) => res.send(panelHtml))

// Serve os JSON estáticos gerados pelos coletores
app.get('/orion/:file(stats\\.json|knowledge\\.json|history\\.json|disk\\.json)', (req, res) => {
  try {
    const data = readFileSync(join(PANEL_JSON_DIR, req.params.file), 'utf8')
    res.setHeader('Content-Type', 'application/json')
    res.send(data)
  } catch {
    res.status(404).json({ error: 'not found' })
  }
})

// Proxy para panel-api.py no host (porta 9099) — injeta token automaticamente
app.all('/panel/api/', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString()
    const url = `${PANEL_API_URL}/?${qs}`
    const r = await fetch(url, {
      method: req.method,
      headers: { 'X-Panel-Token': PANEL_TOKEN, 'Content-Type': 'application/json' },
    })
    const json = await r.json()
    res.json(json)
  } catch (e) {
    res.status(502).json({ ok: false, out: e.message })
  }
})

// ── Sessões Claude Code ───────────────────────────────────────────────────────

app.get('/sessions', (req, res) => res.send(injectAll(sessionsHtml, '/sessions', req.user)))
app.get('/sessions/:id', async (req, res) => {
  const id = req.params.id
  let baseHtml = chatHtml
  try {
    const session = getSession(id)
    if (session) {
      const size = statSync(session.path).size
      const cached = _htmlRespCache.get(id)
      if (cached && cached.size === size) {
        // Hit: HTML já construído para este tamanho de arquivo — direto para sidebar
        baseHtml = cached.baseHtml
      } else {
        // Miss: parse pela cauda (rápido mesmo para 55MB+)
        const timeline = await getCachedTimeline(id, session.path)
        const partial = getCachedPartial(id)
        const total = timeline.length
        const sliced = total > 60 ? timeline.slice(-60) : timeline
        let active = false
        try { active = getActiveSessions().has(id) } catch {}
        const data = { session, timeline: sliced, total, active, partial }
        const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>')
        baseHtml = chatHtml.replace('</head>', `<script>window.__INITIAL_DATA__=${json}</script></head>`)
        _htmlRespCache.set(id, { baseHtml, size })
        if (_htmlRespCache.size > 50) _htmlRespCache.delete(_htmlRespCache.keys().next().value)
      }
    }
  } catch {}
  try { clearAttention(id) } catch {}
  res.set('Cache-Control', 'no-store, must-revalidate')
  res.send(injectAll(baseHtml, '/sessions/'+id, req.user))
})

app.get('/api/claude-usage', async (req, res) => {
  const data = await fetchClaudeUsage()
  if (!data) return res.status(503).json({ error: 'unavailable' })
  res.json(data)
})

app.get('/api/claude-sessions', (req, res) => {
  const { limit, search, showDeleted, showHidden } = req.query
  res.json({ sessions: listSessions({
    limit: +(limit ?? 200),
    search: search ?? '',
    showDeleted: showDeleted === 'true',
    showHidden: showHidden === 'true',
  }) })
})

app.get('/api/claude-sessions/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  addSseClient('__list__', res)
  const ka = setInterval(() => res.write(':ka\n\n'), 20000)
  req.on('close', () => { clearInterval(ka); removeSseClient('__list__', res) })
})

// Cache de timeline por sessão com parse INCREMENTAL.
// Usa tailParseTimeline (lê só a cauda do arquivo) para evitar travar em arquivos de 55MB+.
const _tlCache = new Map()
// Cache de resposta HTML: evita re-parse + JSON.stringify quando arquivo não mudou
// Chave: sessionId → { baseHtml, size }  (baseHtml = chatHtml+inline, sem sidebar)
const _htmlRespCache = new Map()
async function getCachedTimeline(id, path) {
  const size = statSync(path).size
  const c = _tlCache.get(id)
  if (c && c.size === size) return c.timeline           // sem mudança
  if (c && size > c.size) {                             // arquivo cresceu → só novas linhas
    try {
      const { lines } = await readNewLines(path, c.size)
      const newItems = lines.flatMap(l => parseLineItems(l))
      const updated = [...c.timeline, ...newItems]
      _tlCache.set(id, { size, timeline: updated, partial: c.partial })
      if (_tlCache.size > 20) _tlCache.delete(_tlCache.keys().next().value)
      return updated
    } catch {}
  }
  // Parse pela CAUDA (últimas 600KB) — funciona para arquivos de 55MB+ em <100ms
  const { timeline, partial } = await tailParseTimeline(path, 80)
  _tlCache.set(id, { size, timeline, partial })
  if (_tlCache.size > 20) _tlCache.delete(_tlCache.keys().next().value)
  return timeline
}
function getCachedPartial(id) { return _tlCache.get(id)?.partial ?? false }

app.get('/api/claude-sessions/:id', async (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'not found' })
  let timeline = [], partial = false
  try {
    if (req.query.full) {
      // ?full=1 → parse completo (para "carregar histórico anterior")
      const result = await parseSessionTimeline(session.path)
      timeline = result.timeline
    } else {
      timeline = await getCachedTimeline(req.params.id, session.path)
      partial = getCachedPartial(req.params.id)
    }
  } catch {}
  const total = timeline.length
  const tail = req.query.full ? null : parseInt(req.query.tail || '60', 10)
  const sliced = (tail && total > tail) ? timeline.slice(-tail) : timeline
  let active = false
  try { active = getActiveSessions().has(req.params.id) } catch {}
  res.json({ session, timeline: sliced, total, active, partial })
})

// Status leve (ativo?) — usado pelo viewer p/ a animação "pensando" ao vivo
// Soma os output_tokens do TURNO atual (do ultimo user message real pra ca) — igual ao plugin.
function getTurnTokens(filepath) {
  try {
    const fd = openSync(filepath, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - 400000)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      let total = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        let o; try { o = JSON.parse(lines[i]) } catch { continue }
        if (o.type === 'user') {
          const cc = o.message?.content
          const toolOnly = Array.isArray(cc) && cc.length && cc.every(x => x?.type === 'tool_result')
          if (!toolOnly) break
        }
        const ot = o.message?.usage?.output_tokens
        if (typeof ot === 'number') total += ot
      }
      return total
    } finally { closeSync(fd) }
  } catch { return 0 }
}

// Soma todos os tokens da sessão inteira (input + output) — mais rápido com filtro por linha
function getSessionTokenStats(filepath) {
  const stats = { input: 0, output: 0 }
  try {
    const content = readFileSync(filepath, 'utf8')
    for (const line of content.split('\n')) {
      if (!line.includes('"output_tokens"')) continue
      try {
        const u = JSON.parse(line)?.message?.usage
        if (u) { stats.input += u.input_tokens || 0; stats.output += u.output_tokens || 0 }
      } catch {}
    }
  } catch {}
  return { ...stats, total: stats.input + stats.output }
}

// Cache para daily stats (5 min TTL)
let _dailyCache = null, _dailyCacheAt = 0
async function buildDailyTokenStats(days = 14) {
  if (_dailyCache && Date.now() - _dailyCacheAt < 300_000) return _dailyCache
  const now = Date.now()
  const cutoff = now - days * 86400_000
  const by_date = {}
  try {
    const SESSIONS_DIR = '/config/.claude/projects/-config-workspace'
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))
    for (const f of files) {
      const fp = join(SESSIONS_DIR, f)
      try {
        if (statSync(fp).mtimeMs < cutoff) continue
        const content = readFileSync(fp, 'utf8')
        for (const line of content.split('\n')) {
          if (!line.includes('"output_tokens"')) continue
          try {
            const obj = JSON.parse(line)
            const ts = obj.timestamp; if (!ts) continue
            const date = ts.slice(0, 10)
            if (new Date(date).getTime() < cutoff) continue
            const u = obj.message?.usage; if (!u) continue
            if (!by_date[date]) by_date[date] = { date, input: 0, output: 0 }
            by_date[date].input += u.input_tokens || 0
            by_date[date].output += u.output_tokens || 0
          } catch {}
        }
      } catch {}
    }
  } catch {}
  const result = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400_000)
    const date = d.toISOString().slice(0, 10)
    const r = by_date[date] || { date, input: 0, output: 0 }
    result.push({ ...r, total: r.input + r.output })
  }
  _dailyCache = result; _dailyCacheAt = Date.now()
  return result
}

app.get('/api/claude-sessions/:id/token-stats', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'not found' })
  res.json(getSessionTokenStats(session.path))
})

app.get('/api/token-usage/daily', async (req, res) => {
  const days = Math.min(30, Math.max(7, parseInt(req.query.days || '14', 10)))
  res.json(await buildDailyTokenStats(days))
})

// Lê o último modelo usado numa sessão (tail do JSONL, evita ler o arquivo todo)
function getSessionLastModel(filepath) {
  try {
    const fd = openSync(filepath, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - 200_000)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i])
          const m = o.message?.model
          if (m && typeof m === 'string') return m
        } catch {}
      }
    } finally { closeSync(fd) }
  } catch {}
  return null
}

app.get('/api/claude-sessions/:id/active', (req, res) => {
  let active = false, waiting = false, tokens = 0, model = null
  try {
    active = getActiveSessions().has(req.params.id)
    const s = getSession(req.params.id)
    if (active && s) {
      const liveRole = getLastRoleLive(s.path)
      let effectiveRole = liveRole
      // Se último entry é 'assistant' mas processo tem filhos → tool em execução (ex: npx tsc)
      if (effectiveRole === 'assistant') {
        const pid = getSessionPid(req.params.id)
        if (pid) {
          try {
            const bashCount = execSync(`pgrep -P ${pid} 2>/dev/null | xargs -r -I{} ps -p {} -o comm= 2>/dev/null | grep -c bash || true`, { encoding: 'utf8', timeout: 800 })
            if (parseInt(bashCount.trim()) > 0) effectiveRole = 'user'
          } catch {}
        }
      }
      waiting = effectiveRole === 'assistant'
      if (!waiting) try { tokens = getTurnTokens(s.path) } catch {}
    }
    if (s?.path) try { model = getSessionLastModel(s.path) } catch {}
  } catch {}
  res.json({ active, waiting, tokens, model })
})

app.get('/api/claude-sessions/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  addSseClient(req.params.id, res)
  const ka = setInterval(() => res.write(':ka\n\n'), 20000)
  req.on('close', () => { clearInterval(ka); removeSseClient(req.params.id, res) })
})

app.post('/api/claude-sessions/:id/send', async (req, res) => {
  const { id } = req.params
  const { message, model } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })
  if (isSending(id)) return res.status(409).json({ error: 'busy' })

  res.json({ ok: true, queued: true })

  // Verifica se esta sessão pertence ao canal Orion (web chat ou WhatsApp)
  // Se sim, espelha mensagem+resposta no SSE do Orion web chat (reflexão bidirecional)
  const orionSession = getDb().prepare(
    `SELECT id FROM sessions WHERE claude_session_id = ? AND channel IN ('whatsapp','chat_ui') LIMIT 1`
  ).get(id)

  if (orionSession) {
    emitOrionEvent('user_message', { content: message, source: 'code_session', ts: Date.now() })
    emitOrionEvent('typing', { on: true })
  }

  sendToSession(id, message, model)
    .then(reply => {
      if (orionSession && reply) {
        emitOrionEvent('assistant_message', { content: reply, ts: Date.now() })
      }
    })
    .catch(err => {
      console.error('[sessions] send error:', err.message)
    })
    .finally(() => {
      if (orionSession) emitOrionEvent('typing', { on: false })
    })
})

// Criar nova sessão (sem --resume: gera UUID próprio e retorna imediatamente)
app.post('/api/claude-sessions', (req, res) => {
  const { message, model } = req.body || {}
  if (!message?.trim()) return res.status(400).json({ error: 'message required' })
  const id = createNewSession(message.trim(), model || null)
  res.json({ ok: true, id })
})

// Upload de arquivo do computador → salva em /tmp/orion-uploads/ e retorna path
const UPLOAD_DIR = '/tmp/orion-uploads'
app.post('/api/upload-file', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  try {
    mkdirSync(UPLOAD_DIR, { recursive: true })
    const origName = req.headers['x-filename'] || 'upload'
    const safeName = origName.replace(/[^a-zA-Z0-9._-]/g, '_')

    // Excel → converte para CSV/texto legível pelo Claude
    if (/\.(xlsx|xls|ods)$/i.test(origName)) {
      const wb = XLSX.read(req.body, { type: 'buffer' })
      const lines = []
      for (const sheetName of wb.SheetNames) {
        lines.push(`=== Planilha: ${sheetName} ===`)
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName])
        lines.push(csv)
      }
      const textContent = lines.join('\n')
      const txtName = safeName.replace(/\.(xlsx|xls|ods)$/i, '.txt')
      const txtPath = join(UPLOAD_DIR, `${Date.now()}-${txtName}`)
      writeFileSync(txtPath, textContent, 'utf8')
      return res.json({ ok: true, path: txtPath, name: origName, converted: 'excel→csv' })
    }

    const path = join(UPLOAD_DIR, `${Date.now()}-${safeName}`)
    writeFileSync(path, req.body)
    res.json({ ok: true, path, name: origName })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Upload de imagem (base64 JSON) → salva em data/uploads/, retorna URL
const MEDIA_DIR = join(__dirname, '../data/uploads')
mkdirSync(MEDIA_DIR, { recursive: true })

app.get('/uploads/:file', (req, res) => {
  const file = (req.params.file || '').replace(/[^a-zA-Z0-9._-]/g, '')
  if (!file) return res.status(400).end()
  const fp = join(MEDIA_DIR, file)
  if (!existsSync(fp)) return res.status(404).end()
  res.sendFile(fp)
})

app.post('/api/upload-image', (req, res) => {
  try {
    const { data } = req.body
    if (!data || !data.startsWith('data:image/')) return res.status(400).json({ error: 'invalid image' })
    const match = data.match(/^data:image\/([a-z+]+);base64,(.+)$/s)
    if (!match) return res.status(400).json({ error: 'bad format' })
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1].slice(0, 5)
    const buf = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
    const name = `${randomUUID()}.${ext}`
    writeFileSync(join(MEDIA_DIR, name), buf)
    res.json({ ok: true, url: `/uploads/${name}` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Avatar do usuário dono
const AVATAR_META = join(__dirname, '../data/user_avatar.json')
app.get('/api/settings/avatar', (req, res) => {
  if (!existsSync(AVATAR_META)) return res.json({ url: null })
  try { res.json(JSON.parse(readFileSync(AVATAR_META, 'utf8'))) } catch { res.json({ url: null }) }
})
app.post('/api/settings/avatar', (req, res) => {
  try {
    const { data } = req.body
    if (!data || !data.startsWith('data:image/')) return res.status(400).json({ error: 'invalid image' })
    const match = data.match(/^data:image\/([a-z+]+);base64,(.+)$/s)
    if (!match) return res.status(400).json({ error: 'bad format' })
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1].slice(0, 5)
    const buf = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
    const name = `user_avatar.${ext}`
    // remove avatar antigo com ext diferente
    for (const f of ['jpg','jpeg','png','gif','webp']) try { unlinkSync(join(MEDIA_DIR, `user_avatar.${f}`)) } catch {}
    writeFileSync(join(MEDIA_DIR, name), buf)
    const url = `/uploads/${name}`
    writeFileSync(AVATAR_META, JSON.stringify({ url }))
    res.json({ ok: true, url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Transcrição de áudio do microfone (reusa o whisper local, igual o WhatsApp)
app.post('/api/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'sem áudio' })
    const tmp = `/tmp/orion-voice-${Date.now()}-${Math.floor(Math.random()*1e6)}.webm`
    writeFileSync(tmp, req.body)
    try {
      const { stdout } = await execa('python3', ['/config/workspace/orion/src/gateway/whisper_transcribe.py', tmp], { timeout: 120_000 })
      res.json({ text: (stdout || '').trim() })
    } finally { try { unlinkSync(tmp) } catch {} }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/claude-sessions/:id/title', (req, res) => {
  const { title } = req.body
  if (!title) return res.status(400).json({ error: 'title required' })
  renameSession(req.params.id, title)
  res.json({ ok: true })
})

app.patch('/api/claude-sessions/:id/hide', (req, res) => {
  hideSession(req.params.id)
  res.json({ ok: true })
})

app.delete('/api/claude-sessions/:id', (req, res) => {
  hardDeleteSession(req.params.id)
  res.json({ ok: true })
})

app.patch('/api/claude-sessions/:id/show', (req, res) => {
  showSession(req.params.id)
  res.json({ ok: true })
})

app.put('/api/claude-sessions/:id/draft', (req, res) => {
  const { text = '', files = '[]' } = req.body
  getDb().prepare('UPDATE claude_sessions SET draft_text=?, draft_files=? WHERE id=?')
    .run(text || null, files || '[]', req.params.id)
  res.json({ ok: true })
})

app.put('/api/claude-sessions/:id/open', (req, res) => {
  openSession(req.params.id)
  // Registra quem abriu (last_actor) para mostrar avatar na lista
  try {
    const uid = req.user?.id || null
    if (uid) getDb().prepare(
      'UPDATE claude_sessions SET last_actor=?, last_actor_at=unixepoch() WHERE id=?'
    ).run(uid, req.params.id)
  } catch {}
  res.json({ ok: true })
})

app.delete('/api/claude-sessions/:id/open', (req, res) => {
  closeSessionPin(req.params.id)
  res.json({ ok: true })
})

// Visibilidade da sessão: personal | team
app.patch('/api/claude-sessions/:id/visibility', (req, res) => {
  const { visibility } = req.body
  if (!['personal','team'].includes(visibility)) return res.status(400).json({ error: 'invalid visibility' })
  try {
    getDb().prepare('UPDATE claude_sessions SET visibility=? WHERE id=?').run(visibility, req.params.id)
    res.json({ ok: true, visibility })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Fork conversation: copia o JSONL até a linha N, cria nova sessão
app.post('/api/claude-sessions/:id/fork', (req, res) => {
  try {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    const lines = readFileSync(session.path, 'utf8').split('\n').filter(Boolean)
    // beforeTs: timestamp ISO da entrada; beforeIndex: fallback numérico
    const { beforeTs, beforeIndex } = req.body
    let cutLine = lines.length
    if (beforeTs) {
      for (let i = 0; i < lines.length; i++) {
        try { if (JSON.parse(lines[i]).timestamp === beforeTs) { cutLine = i; break } } catch {}
      }
    } else if (beforeIndex != null) {
      let cnt = 0
      for (let i = 0; i < lines.length; i++) {
        try { const o = JSON.parse(lines[i]); if (o.type==='user'||o.type==='assistant') { if (cnt++>=beforeIndex){cutLine=i;break} } } catch {}
      }
    }
    const sliced = lines.slice(0, cutLine)

    const newId = randomUUID()
    const SESSIONS_DIR = '/config/.claude/projects/-config-workspace'
    const newPath = join(SESSIONS_DIR, `${newId}.jsonl`)
    writeFileSync(newPath, sliced.join('\n') + '\n', 'utf8')

    const db = getDb()
    const srcTitle = session.custom_title || session.ai_title || 'Fork'
    db.prepare(`
      INSERT INTO claude_sessions (id, path, cwd, custom_title, ai_title, last_modified, message_count, first_user_msg)
      VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?)
    `).run(newId, newPath, session.cwd, `Fork: ${srcTitle}`, null,
           sliced.length, session.first_user_msg)

    res.json({ ok: true, newId, title: `Fork: ${srcTitle}` })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Rewind code: git restore no cwd da sessão (reverte arquivos não commitados)
app.post('/api/claude-sessions/:id/rewind', (req, res) => {
  try {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    const cwd = session.cwd || '/config/workspace'
    // Verifica se é repo git
    try { execSync(`git -C "${cwd}" rev-parse --git-dir`, { stdio: 'ignore' }) } catch {
      return res.status(400).json({ error: 'not a git repository' })
    }
    const status = execSync(`git -C "${cwd}" status --porcelain`, { encoding: 'utf8' }).trim()
    if (!status) return res.json({ ok: true, msg: 'nothing to rewind' })
    // Stash + restore
    execSync(`git -C "${cwd}" stash push -m "orion-rewind-${Date.now()}"`, { encoding: 'utf8' })
    res.json({ ok: true, msg: 'code rewound (stashed)', stash: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Round 4: 17 novos endpoints ───────────────────────────────────────────────

// Item 6: Bayesian belief update
app.post('/api/memories/:id/observe', (req, res) => {
  const { observation, reason: whyReason } = req.body
  if (!observation) return res.status(400).json({ error: 'observation required' })
  try {
    const result = applyObservation(req.params.id, observation, { reason: whyReason })
    if (!result) return res.status(404).json({ error: 'memory not found or unknown observation' })
    res.json({ ok: true, ...result })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Item 7: Semantic drift log
app.get('/api/memories/drift-log', (req, res) => {
  const limit = Math.min(+(req.query.limit ?? 20), 100)
  res.json({ drifts: getRecentDrifts(limit) })
})

// Item 4: Tiered summarization — get category summary
app.get('/api/memories/summary/:category', (req, res) => {
  const summary = getCategorySummary(req.params.category)
  const narrative = getNarrativeSummary(req.params.category)
  res.json({ category: req.params.category, summary, narrative })
})

// Item 4: Refresh all category summaries manually
app.post('/api/memories/summaries/refresh', async (req, res) => {
  try {
    const computed = await refreshAllCategorySummaries()
    res.json({ ok: true, computed })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Item 10: Temporal index stats
app.get('/api/memories/temporal/stats', (req, res) => {
  res.json(getTemporalIndexStats())
})

// Item 10: Memories in time period
app.get('/api/memories/temporal/period', (req, res) => {
  const from = parseInt(req.query.from ?? '0')
  const to   = parseInt(req.query.to ?? String(Math.floor(Date.now() / 1000)))
  const limit = Math.min(+(req.query.limit ?? 20), 100)
  res.json({ memories: getMemoriesInPeriod(from, to, limit) })
})

// Item 2: Contradiction resolution queue
app.get('/api/memories/contradictions/pending', (req, res) => {
  res.json({ pending: listPendingContradictions(), stats: getResolutionStats() })
})

app.post('/api/memories/contradictions/:id/resolve', (req, res) => {
  const { resolution, corrected_content } = req.body
  if (!resolution) return res.status(400).json({ error: 'resolution required (a|b|both_wrong|both_right)' })
  const ok = resolveContradiction(req.params.id, resolution, corrected_content)
  res.json({ ok })
})

// Item 13: Causal graph
app.get('/api/memories/causal', (req, res) => {
  const limit = Math.min(+(req.query.limit ?? 50), 200)
  res.json({ links: listCausalLinks(limit) })
})

app.post('/api/memories/causal', (req, res) => {
  const { cause, effect, confidence } = req.body
  if (!cause || !effect) return res.status(400).json({ error: 'cause and effect required' })
  const ok = saveCausalLink({ cause, effect, confidence: confidence ?? 0.6 })
  res.json({ ok })
})

app.get('/api/memories/causal/causes', (req, res) => {
  const { effect, limit } = req.query
  if (!effect) return res.status(400).json({ error: 'effect required' })
  res.json({ causes: getCauses(effect, +(limit ?? 10)) })
})

app.get('/api/memories/causal/effects', (req, res) => {
  const { cause, limit } = req.query
  if (!cause) return res.status(400).json({ error: 'cause required' })
  res.json({ effects: getEffects(cause, +(limit ?? 10)) })
})

// Item 14: Multi-hop QA
app.post('/api/memories/multihop', async (req, res) => {
  const { question } = req.body
  if (!question) return res.status(400).json({ error: 'question required' })
  try {
    const result = await multiHopQuery(question)
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Round 5 endpoints ─────────────────────────────────────────────────────────

// ── Brain (mapa visual + observabilidade ao vivo) ─────────────────────────────
app.get('/brain', (req, res) => res.send(injectAll(brainHtml, '/brain', req.user)))
app.get('/academia', (req, res) => res.send(injectAll(academiaHtml, '/academia', req.user)))
app.get('/automacoes', (req, res) => res.send(injectAll(automacoesHtml, '/automacoes', req.user)))

// ── Admin (owner only) ────────────────────────────────────────────────────────
app.get('/admin', requireOwner, (req, res) => res.send(injectAll(adminHtml, '/admin', req.user)))
app.get('/admin/profile', (req, res) => res.send(injectAll(adminHtml, '/admin/profile', req.user)))

// ── Colaboradores (owner only) ────────────────────────────────────────────────
let colaboradoresHtml = ''; try { colaboradoresHtml = readFileSync(join(__dirname, 'ui/colaboradores.html'), 'utf8') } catch {}
app.get('/colaboradores', requireOwner, (req, res) => res.send(injectAll(colaboradoresHtml, '/colaboradores', req.user)))

// ── Comparação entre colaboradores (deve vir ANTES de /:id) ──────────────────
app.get('/api/colaboradores/compare', requireOwner, (req, res) => {
  const db = getDb()
  const ids = String(req.query.ids||'').split(',').map(Number).filter(Boolean)
  if (ids.length < 2) return res.status(400).json({ error: 'Informe ao menos 2 ids' })
  const since = Math.floor(Date.now() / 1000) - 30 * 86400
  const data = ids.map(id => {
    const u    = db.prepare(`SELECT id, username, display_name, avatar_color FROM users WHERE id=?`).get(id)
    if (!u) return null
    const reqs = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE user_id=? AND created_at>?`).get(id, since)
    const msgs = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(input_tokens),0) it, COALESCE(SUM(output_tokens),0) ot FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.user_id=? AND m.created_at>? AND m.role='assistant'`).get(id, since)
    const daily= db.prepare(`SELECT date(created_at,'unixepoch','localtime') d, COUNT(*) c FROM audit_log WHERE user_id=? AND created_at>? GROUP BY d ORDER BY d`).all(id, since)
    return { user: u, requests_30d: reqs.c, messages_30d: msgs.c, tokens_in: msgs.it, tokens_out: msgs.ot, daily }
  }).filter(Boolean)
  res.json({ compare: data })
})

app.get('/api/colaboradores', requireOwner, (req, res) => {
  const db = getDb()
  const users = db.prepare(`SELECT id, username, display_name, avatar_color, role, is_active, notes, last_assessment, last_assessment_at, token_budget_monthly, tokens_this_month FROM users WHERE role='collaborator'`).all()
  const enriched = users.map(u => {
    const al = db.prepare(`SELECT COUNT(*) c, MAX(created_at) last_at FROM audit_log WHERE user_id=?`).get(u.id)
    const sess = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE user_id=?`).get(u.id)
    const msgs = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(input_tokens),0) it, COALESCE(SUM(output_tokens),0) ot FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.user_id=? AND m.role='assistant'`).get(u.id)
    const topPages = db.prepare(`SELECT path, COUNT(*) c FROM audit_log WHERE user_id=? AND method='GET' GROUP BY path ORDER BY c DESC LIMIT 5`).all(u.id)
    return { ...u, total_requests: al.c, last_active: al.last_at, sessions_count: sess.c, messages_count: msgs.c, input_tokens: msgs.it, output_tokens: msgs.ot, top_pages: topPages }
  })
  res.json({ colaboradores: enriched })
})

app.get('/api/colaboradores/:id', requireOwner, (req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const user = db.prepare(`SELECT id, username, display_name, avatar_color, role, is_active, notes, created_at, last_login_at, last_assessment, last_assessment_at FROM users WHERE id=? AND role='collaborator'`).get(id)
  if (!user) return res.status(404).json({ error: 'não encontrado' })
  const activity7d = db.prepare(`SELECT date(created_at,'unixepoch','localtime') d, COUNT(*) c, method FROM audit_log WHERE user_id=? AND created_at > unixepoch()-604800 GROUP BY d,method ORDER BY d`).all(id)
  const hourMap    = db.prepare(`SELECT strftime('%H',created_at,'unixepoch','localtime') h, COUNT(*) c FROM audit_log WHERE user_id=? GROUP BY h`).all(id)
  const dayMap     = db.prepare(`SELECT strftime('%w',created_at,'unixepoch','localtime') d, COUNT(*) c FROM audit_log WHERE user_id=? GROUP BY d`).all(id)
  const topPages   = db.prepare(`SELECT path, COUNT(*) c FROM audit_log WHERE user_id=? AND method='GET' GROUP BY path ORDER BY c DESC LIMIT 10`).all(id)
  const recentLogs = db.prepare(`SELECT * FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).all(id)
  const sessions   = db.prepare(`SELECT s.id, s.title, s.message_count, s.created_at, s.last_active, (SELECT content FROM messages WHERE session_id=s.id AND role='user' LIMIT 1) first_msg FROM sessions s WHERE s.user_id=? ORDER BY s.last_active DESC LIMIT 20`).all(id)
  const tokensByDay= db.prepare(`SELECT date(m.created_at,'unixepoch','localtime') d, COALESCE(SUM(m.input_tokens),0) it, COALESCE(SUM(m.output_tokens),0) ot FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.user_id=? AND m.role='assistant' GROUP BY d ORDER BY d DESC LIMIT 14`).all(id)
  res.json({ user, activity7d, hourMap, dayMap, topPages, recentLogs, sessions, tokensByDay })
})

app.post('/api/colaboradores/:id/assessment', requireOwner, async (req, res) => {
  const db = getDb()
  const id = Number(req.params.id)
  const user = db.prepare('SELECT * FROM users WHERE id=? AND role=?').get(id, 'collaborator')
  if (!user) return res.status(404).json({ error: 'não encontrado' })
  const topPages  = db.prepare(`SELECT path, COUNT(*) c FROM audit_log WHERE user_id=? GROUP BY path ORDER BY c DESC LIMIT 8`).all(id)
  const totalReqs = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE user_id=?`).get(id).c
  const sessCount = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE user_id=?`).get(id).c
  const msgCount  = db.prepare(`SELECT COUNT(*) c FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.user_id=? AND m.role='user'`).get(id).c
  const lastActive= db.prepare(`SELECT MAX(created_at) t FROM audit_log WHERE user_id=?`).get(id).t
  const prompt = `Você é o Orion, sistema de inteligência pessoal de Danilo Bayerl. Avalie o colaborador "${user.display_name || user.username}" baseado nos dados abaixo.

Dados de atividade:
- Total de requests: ${totalReqs}
- Sessões de chat: ${sessCount}
- Mensagens enviadas: ${msgCount}
- Última atividade: ${lastActive ? new Date(lastActive * 1000).toLocaleString('pt-BR') : 'nunca'}
- Páginas mais visitadas: ${topPages.map(p => `${p.path} (${p.c}x)`).join(', ')}

Escreva uma avaliação direta e honesta em 3-4 parágrafos curtos:
1. Perfil de trabalho (o que parece estar fazendo)
2. Pontos positivos observados
3. Áreas de atenção ou sugestões
4. Resumo executivo em 1 frase

Seja específico, direto, sem elogios genéricos. Tom de advisor profissional.`
  try {
    const { execa } = await import('execa')
    const { stdout } = await execa('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'text'], { timeout: 60_000 })
    db.prepare('UPDATE users SET last_assessment=?, last_assessment_at=unixepoch() WHERE id=?').run(stdout.trim(), id)
    res.json({ assessment: stdout.trim() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Spy view — SSE de atividade ao vivo por colaborador ──────────────────────
app.get('/api/colaboradores/:id/spy', requireOwner, (req, res) => {
  const userId = Number(req.params.id)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`)
  const unsub = onAuditEntry(entry => {
    if (entry.user_id !== userId) return
    res.write(`data: ${JSON.stringify({ type: 'activity', ...entry })}\n\n`)
  })
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { unsub(); clearInterval(ping) })
})

// ── Timesheet ─────────────────────────────────────────────────────────────────
app.get('/api/colaboradores/:id/timesheet', requireOwner, (req, res) => {
  const userId = Number(req.params.id)
  const days   = Math.min(Number(req.query.days) || 30, 90)
  try { res.json({ timesheet: getTimesheet(userId, days) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get('/api/colaboradores/:id/tasks', requireOwner, (req, res) => {
  try { res.json({ tasks: listTasks(Number(req.params.id)) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/colaboradores/:id/tasks', requireOwner, (req, res) => {
  try {
    const id = createTask(Number(req.params.id), { ...req.body, created_by: req.user.id })
    res.json({ ok: true, id })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.patch('/api/colaboradores/:id/tasks/:tid', requireOwner, (req, res) => {
  try { updateTask(Number(req.params.tid), req.body); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

app.delete('/api/colaboradores/:id/tasks/:tid', requireOwner, (req, res) => {
  try { deleteTask(Number(req.params.tid)); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Permissões por colaborador ────────────────────────────────────────────────
app.get('/api/colaboradores/:id/permissions', requireOwner, (req, res) => {
  try { res.json({ permissions: getUserPermissions(Number(req.params.id)) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.put('/api/colaboradores/:id/permissions', requireOwner, (req, res) => {
  try { setUserPermissions(Number(req.params.id), req.body.permissions || {}); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// ── Budget de tokens ──────────────────────────────────────────────────────────
app.get('/api/colaboradores/:id/budget', requireOwner, (req, res) => {
  try { res.json(getBudget(Number(req.params.id)) || {}) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.put('/api/colaboradores/:id/budget', requireOwner, (req, res) => {
  try { setBudget(Number(req.params.id), req.body.monthly_tokens); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

app.get('/api/admin/users', requireOwner, (req, res) => {
  res.json({ users: listUsers() })
})

app.post('/api/admin/users', requireOwner, (req, res) => {
  try {
    const id = createUser(req.body)
    res.json({ ok: true, id })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.patch('/api/admin/users/:id', requireOwner, (req, res) => {
  const id = Number(req.params.id)
  // Não deixa desativar o próprio owner
  if (!id || id === req.user.id && req.body.is_active === false) {
    return res.status(400).json({ error: 'Não é possível se auto-desativar.' })
  }
  try { updateUser(id, req.body); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/admin/users/:id/reset-password', requireOwner, (req, res) => {
  const { newPassword } = req.body
  try { resetPassword(Number(req.params.id), newPassword); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

app.get('/api/admin/activity', requireOwner, (req, res) => {
  const userId = req.query.userId ? Number(req.query.userId) : undefined
  const limit  = Math.min(Number(req.query.limit) || 200, 500)
  const offset = Number(req.query.offset) || 0
  const since  = req.query.since ? Number(req.query.since) : undefined
  res.json({ logs: getAuditLog({ userId, limit, offset, since }) })
})

// SSE — stream ao vivo de atividade
app.get('/api/admin/activity/stream', requireOwner, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write('data: {"type":"connected"}\n\n')
  const unsub = onAuditEntry(entry => {
    res.write(`data: ${JSON.stringify({ type: 'entry', entry })}\n\n`)
  })
  req.on('close', unsub)
})

// ── Academia API (cockpit de arquitetura) ─────────────────────────────────────
app.get('/api/academia/stats',   (req, res) => res.json(getMechanismStats()))
app.get('/api/academia/health',  (req, res) => res.json(getHealthRadar()))
app.get('/api/academia/retrieval-debug', (req, res) => res.json(retrievalDebug(req.query.q ?? '', Math.min(+(req.query.limit ?? 12), 25))))
app.get('/api/academia/trace',   (req, res) => res.json(req.query.id ? traceMemory(req.query.id) : { recent: listRecentMemoriesForTrace() }))
app.get('/api/academia/improvements', (req, res) => res.json({ items: listImprovements() }))
app.post('/api/academia/improvements', (req, res) => res.json(saveImprovement(req.body ?? {})))
app.patch('/api/academia/improvements/:id', (req, res) => res.json(updateImprovement(req.params.id, req.body?.status ?? 'feito')))

app.get('/api/brain/graph', (req, res) => {
  res.json(getBrainGraph({ maxNodes: Math.min(+(req.query.max ?? 120), 300) }))
})

app.get('/api/brain/roots', (req, res) => res.json({ roots: getBrainRoots() }))

app.get('/api/brain/files', (req, res) => {
  res.json(listBrainFiles(req.query.root ?? 'motor', req.query.dir ?? ''))
})

app.get('/api/brain/file', (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path required' })
  res.json(readBrainFile(req.query.root ?? 'motor', req.query.path))
})

app.get('/api/brain/skills', (req, res) => res.json(getBrainSkills()))

// SSE — stream de atividade do cérebro ao vivo
app.get('/api/brain/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`retry: 3000\n\n`)

  // Hidrata com eventos recentes
  for (const evt of getRecentEvents(60)) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`)
  }

  const unsub = onBrainEvent(evt => {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`) } catch {}
  })

  const ka = setInterval(() => { try { res.write(`: ka\n\n`) } catch {} }, 25_000)

  req.on('close', () => { clearInterval(ka); unsub() })
})

// U2: Counterfactual reasoning sobre o grafo causal
app.get('/api/memories/counterfactual', (req, res) => {
  const { cause } = req.query
  if (!cause) return res.status(400).json({ error: 'cause required' })
  res.json(reasonCounterfactual(cause))
})
app.get('/api/memories/causal-chain', (req, res) => {
  const { cause } = req.query
  if (!cause) return res.status(400).json({ error: 'cause required' })
  res.json({ chain: traceCausalChain(cause) })
})

// U3: Deduplicação fuzzy
app.post('/api/memories/dedup/run', async (req, res) => {
  try { res.json(await runDeduplication(req.body ?? {})) }
  catch (err) { res.status(500).json({ error: err.message }) }
})
app.get('/api/memories/dedup/queue', (req, res) => {
  res.json({ queue: listDedupQueue(+(req.query.limit ?? 20)) })
})
app.post('/api/memories/dedup/vote', (req, res) => {
  const { queueId, vote } = req.body
  if (!queueId || !vote) return res.status(400).json({ error: 'queueId and vote required' })
  res.json(resolveDedupVote(queueId, vote))
})

// U5: Time-travel memory snapshots
app.get('/api/memories/snapshot/sessions', (req, res) => {
  res.json({ sessions: listSnapshotSessions(+(req.query.limit ?? 20)) })
})
app.get('/api/memories/snapshot/state', (req, res) => {
  const { memoryId, epoch } = req.query
  if (!memoryId) return res.status(400).json({ error: 'memoryId required' })
  const ep = epoch ? +epoch : Math.floor(Date.now() / 1000)
  res.json(getMemoryStateAt(memoryId, ep) ?? { error: 'no snapshot found' })
})
app.get('/api/memories/snapshot/compare', (req, res) => {
  const { from, to } = req.query
  if (!from || !to) return res.status(400).json({ error: 'from and to epochs required' })
  res.json(compareSnapshots(+from, +to))
})

// (skills/synthesize e skills/critic removidos em 2026-07-09 — módulos no attic/, nunca usados)

// H5: Cron suggestions
app.get('/api/cron/suggestions', (req, res) => {
  res.json({ suggestions: listCronSuggestions(+(req.query.limit ?? 10)) })
})
app.post('/api/cron/suggestions/activate', (req, res) => {
  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  res.json(activateSuggestion(name))
})

// (consensus routing removido em 2026-07-09 — attic/, nunca usado)

// Item 8: SQL-like memory queries (whitelist de campos para segurança)
app.get('/api/memories/query', (req, res) => {
  const { category, type, min_confidence, source_tool, limit, order_by } = req.query
  try {
    const db = getDb()
    const clauses = ['archived = 0']
    const params = []

    if (category)       { clauses.push('category = ?');      params.push(category) }
    if (type)           { clauses.push('type = ?');           params.push(type) }
    if (min_confidence) { clauses.push('confidence >= ?');    params.push(parseFloat(min_confidence)) }
    if (source_tool)    { clauses.push('source_tool = ?');    params.push(source_tool) }

    const allowedOrder = ['confidence', 'created_at', 'last_accessed', 'access_count']
    const orderCol = allowedOrder.includes(order_by) ? order_by : 'created_at'
    const n = Math.min(+(limit ?? 20), 200)

    const rows = db.prepare(`
      SELECT id, type, content, category, confidence, source_tool, access_count, created_at
      FROM memories
      WHERE ${clauses.join(' AND ')}
      ORDER BY ${orderCol} DESC
      LIMIT ?
    `).all(...params, n)

    res.json({ memories: rows, count: rows.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// (skill bundles removidos em 2026-07-09 — attic/, nunca usados)

// Item 16: Skill recommendation
app.get('/api/skills/recommend', (req, res) => {
  const { skill, message, limit } = req.query
  const n = Math.min(+(limit ?? 5), 20)
  if (skill) {
    res.json({ recommendations: recommendSkills(skill, [], n) })
  } else if (message) {
    res.json({ recommendations: suggestSkillsForMessage(message, n) })
  } else {
    res.json({ top: getTopSkills(n) })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 8088
// Bridge: toda escrita de memória vira evento de atividade do cérebro + SSE chat
onMemoryWrite(evt => {
  try {
    emitBrain('memory', {
      text: String(evt.content ?? '').slice(0, 90),
      category: evt.category,
      confidence: evt.confidence,
      memType: evt.type,
      sourceTool: evt.sourceTool,
    })
  } catch {}
  try {
    emitOrionEvent('memory_saved', {
      content: String(evt.content ?? '').slice(0, 120),
      type: evt.type,
      ts: Date.now(),
    })
  } catch {}
  // Saves autônomos (extração, review, merge) → inbox de decisões com undo
  if (['haiku-extraction', 'background-review', 'phase3-merge'].includes(evt.sourceTool)) {
    try {
      logAutonomousAction({
        kind: 'memory_saved',
        description: `Memória salva: ${String(evt.content ?? '').slice(0, 110)}`,
        undoKind: 'archive_memory',
        undoData: { memoryId: evt.id },
      })
    } catch {}
  }
})

// Wrappers que emitem evento de início de fase para a timeline ao vivo
const phaseWrap = (name, fn) => async () => {
  emitBrain('phase', { text: `${name} iniciada` })
  try { return await fn() } catch (e) { console.error(`[${name}]`, e.message) }
}

// ── Traduções PT-BR para todas as skills conhecidas ────────────────────────────
const SKILL_DESC_PTBR = {
  // builtin
  '/code-review':                  'Revisar código da branch com múltiplos agentes',
  '/init':                         'Inicializar ou atualizar o CLAUDE.md do projeto',
  '/help':                         'Ajuda e lista de todos os comandos disponíveis',
  // custom
  '/desligarprojeto':              'Desliga o dev server de preview de um projeto (libera RAM)',
  '/desligartodososprojetos':      'Desliga todos os dev servers de preview',
  '/find-skills':                  'Descobrir e instalar skills disponíveis para o agente',
  '/ligartodososprojetos':         'Liga os dev servers de preview de todos os projetos',
  '/memory list':                  'Listar todas as memórias por branch',
  '/memory recall':                'Recuperar memórias relevantes para a tarefa atual',
  '/memory save':                  'Salvar uma memória importante para uso futuro',
  '/rebase':                       'Rebase da branch sobre o trunk resolvendo conflitos',
  '/riper execute':                'Executar plano aprovado (protocolo RIPER — EXECUTE)',
  '/riper innovate':               'Gerar ideias criativas antes de planejar (INNOVATE)',
  '/riper plan':                   'Planejar implementação detalhada (PLAN)',
  '/riper research':               'Pesquisar e analisar antes de agir (RESEARCH)',
  '/riper review':                 'Revisar trabalho concluído (REVIEW)',
  '/riper strict':                 'Modo estrito: bloqueia execução sem aprovação explícita',
  '/riper workflow':               'Ver o fluxo completo do protocolo RIPER',
  '/rodarprojeto':                 'Liga o preview ao vivo de um projeto em <proj>.bayerl.cloud',
  '/saasmaster':                   'Construir um SaaS completo de forma autônoma, do research ao deploy',
  '/siteexpress':                  'Criar e publicar landing pages estáticas em pages.bayerl.cloud',
  // superpowers
  '/brainstorming':                'Explorar intenção e design antes de implementar qualquer feature',
  '/dispatching-parallel-agents':  'Distribuir 2+ tarefas independentes em subagentes paralelos',
  '/executing-plans':              'Executar um plano de implementação com checkpoints de revisão',
  '/finishing-a-development-branch':'Concluir desenvolvimento: apresentar opções de merge, PR ou limpeza',
  '/receiving-code-review':        'Processar feedback de code review com rigor técnico',
  '/requesting-code-review':       'Verificar trabalho antes de commitar ou criar PR',
  '/subagent-driven-development':  'Executar planos com subagentes independentes na sessão atual',
  '/systematic-debugging':         'Debugar qualquer bug ou falha de teste de forma sistemática',
  '/test-driven-development':      'Implementar features com TDD: testes antes do código',
  '/using-git-worktrees':          'Isolar workspace com git worktree antes de implementar',
  '/verification-before-completion':'Confirmar que o trabalho está correto antes de entregar',
  '/writing-plans':                'Criar um plano detalhado de implementação antes de codar',
  '/writing-skills':               'Criar ou editar skills personalizadas para o agente',
  // caveman
  '/caveman':                      'Ativar modo de comunicação ultra-comprimido (~75% menos tokens)',
  '/caveman-commit':               'Gerar mensagem de commit comprimida no padrão Conventional Commits',
  '/caveman-compress':             'Comprimir arquivos de memória (CLAUDE.md, notas) para economizar tokens',
  '/caveman-help':                 'Referência rápida: todos os modos, skills e comandos do caveman',
  '/caveman-review':               'Code review ultra-comprimido: uma linha por achado com severidade',
  '/caveman-stats':                'Ver uso real de tokens e economia estimada na sessão atual',
  '/cavecrew':                     'Guia de delegação para subagentes caveman (quando usar cada um)',
  '/cavecrew-builder':             'Subagente cirúrgico: edições de 1-2 arquivos, recusa escopo maior',
  '/cavecrew-investigator':        'Subagente de busca read-only: localiza código com output comprimido',
  '/cavecrew-reviewer':            'Subagente de review: uma linha por achado com emoji de severidade',
  // ui-ux
  '/ui-ux-pro-max':               'Design UI/UX completo: 50+ estilos, 161 paletas, 57 pares de fontes',
  '/ckm:design':                   'Design completo: logo, identidade visual, banners, ícones e fotos sociais',
  '/ckm:banner-design':            'Banners para redes sociais, anúncios e web em 22 estilos',
  '/ckm:brand':                    'Identidade de marca, voz, mensagens e guia de estilo',
  '/ckm:design-system':            'Tokens de design, specs de componentes e slides estratégicos',
  '/ckm:slides':                   'Criar apresentações HTML estratégicas com Chart.js e layout responsivo',
  '/ckm:ui-styling':               'Estilização UI com shadcn/ui, Tailwind CSS e componentes acessíveis',
  // obsidian
  '/defuddle':                     'Extrair conteúdo limpo de páginas web removendo navegação e lixo',
  '/json-canvas':                  'Criar e editar arquivos Canvas do Obsidian (.canvas)',
  '/obsidian-bases':               'Criar views de banco de dados no Obsidian (.base files)',
  '/obsidian-cli':                 'Interagir com vaults do Obsidian via CLI',
  '/obsidian-markdown':            'Criar markdown Obsidian: wikilinks, callouts, embeds',
  // claude-mem
  '/babysit':                      'Monitorar PR/review cycle até pronto para merge',
  '/claude-code-plugin-release':   'Versionamento semântico e release automático de plugins Claude Code',
  '/design-is':                    'Auditar design contra os 10 princípios de Dieter Rams',
  '/do':                           'Executar um plano de implementação em fases com subagentes',
  '/how-it-works':                 'Explicar como o claude-mem captura e injeta memórias entre sessões',
  '/knowledge-agent':              'Construir e consultar base de conhecimento a partir de observações',
  '/learn-codebase':               'Ler todos os arquivos fonte para aprender um projeto novo',
  '/make-plan':                    'Criar plano detalhado por fases antes de implementar',
  '/mem-search':                   'Buscar na memória persistente entre sessões do claude-mem',
  '/oh-my-issues':                 'Agrupar backlog de issues por causa raiz e criar planos consolidados',
  '/pathfinder':                   'Mapear codebase em fluxogramas e propor arquitetura unificada',
  '/smart-explore':                'Busca estrutural de código com AST (tree-sitter) — economiza tokens',
  '/standup':                      'Comparar mudanças entre branches/worktrees e consolidar um plano',
  '/timeline-report':              'Gerar relatório narrativo da história completa do projeto',
  '/weekly-digests':               'Gerar diário semanal narrativo do histórico do projeto',
  '/wowerpoint':                   'Transformar documento em apresentação kawaii estilo NotebookLM (PDF)',
}

// ── Slash commands — varredura completa (commands + todos os plugins) ──────────
app.get('/api/slash-commands', (req, res) => {
  const seen = new Set()
  const cmds = []
  function add(name, desc, group, type) {
    if (!name || seen.has(name)) return
    seen.add(name)
    const ptbr = SKILL_DESC_PTBR[name]
    // auto-detecta sub-comando se o nome tem espaço (ex: /riper execute)
    const resolvedType = type || (name.includes(' ') ? 'subcommand' : 'main')
    cmds.push({ name, desc: ptbr || (desc||'').replace(/^["']|["']$/g, '').trim(), group: group||'custom', type: resolvedType })
  }
  // built-ins Claude Code
  add('/code-review', '', 'builtin')
  add('/init', '', 'builtin')
  add('/help', '', 'builtin')

  // custom commands em /config/.claude/commands/
  try {
    const CMDS_DIR = '/config/.claude/commands'
    for (const e of readdirSync(CMDS_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // subcomandos: /riper execute, /memory list, etc.
        const subDir = CMDS_DIR + '/' + e.name
        try {
          for (const sub of readdirSync(subDir, { withFileTypes: true })) {
            if (!sub.isFile() || !sub.name.endsWith('.md')) continue
            const raw = readFileSync(subDir + '/' + sub.name, 'utf8')
            const m = raw.match(/^description:\s*(.+)/m)
            add('/' + e.name + ' ' + sub.name.replace(/\.md$/, ''), m?.[1], 'custom')
          }
        } catch {}
        continue
      }
      if (!e.name.endsWith('.md')) continue
      const raw = readFileSync(CMDS_DIR + '/' + e.name, 'utf8')
      const m = raw.match(/^description:\s*(.+)/m)
      add('/' + e.name.replace(/\.md$/, ''), m?.[1], 'custom')
    }
  } catch {}

  // plugins: varre todos os caches buscando frontmatter name: + description:
  const PLUGINS = '/config/.claude/plugins/cache'
  const PLUGIN_GROUPS = {
    'superpowers-dev': 'superpowers',
    'caveman': 'caveman',
    'ui-ux-pro-max-skill': 'ui-ux',
    'obsidian-skills': 'obsidian',
    'thedotmack': 'claude-mem',
  }
  const SKIP_SKILLS = new Set(['my-skill','skill-name','using-superpowers','PDF Processing','Bug Report','Bug report','Feature Request','Feature request','IDE / Platform Support Request'])
  const scanPluginDir = (dir, group, addFn) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const isAgentsDir = dir.endsWith('/agents')
    for (const e of entries) {
      if (e.isDirectory()) { scanPluginDir(dir+'/'+e.name, group, addFn); continue }
      if (!e.name.endsWith('.md')) continue
      try {
        const raw = readFileSync(dir+'/'+e.name, 'utf8')
        const nm = raw.match(/^name:\s*(.+)/m)
        const dm = raw.match(/^description:\s*(.+)/m)
        if (!nm) continue
        const skillName = nm[1].trim().replace(/^["']|["']$/g, '')
        if (skillName && !skillName.includes(' ') && !skillName.includes('[') && !SKIP_SKILLS.has(skillName)) {
          addFn('/' + skillName, dm?.[1], group, isAgentsDir ? 'subagent' : 'main')
        }
      } catch {}
    }
  }
  for (const [plugin, group] of Object.entries(PLUGIN_GROUPS)) {
    const base = PLUGINS + '/' + plugin
    if (existsSync(base)) scanPluginDir(base, group, add)
  }

  // ordenar alfabeticamente (builtin primeiro, depois o resto)
  cmds.sort((a, b) => {
    if (a.group === 'builtin' && b.group !== 'builtin') return -1
    if (a.group !== 'builtin' && b.group === 'builtin') return 1
    return a.name.localeCompare(b.name)
  })

  res.json({ commands: cmds })
})

// ── Filesystem API ────────────────────────────────────────────────────────────
const FS_ROOT = '/config/workspace'
const HIDDEN = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '__pycache__', '.DS_Store'])

function safePath(rel) {
  const abs = join(FS_ROOT, rel || '')
  if (!abs.startsWith(FS_ROOT)) throw new Error('forbidden')
  return abs
}

app.get('/api/fs/list', (req, res) => {
  try {
    const abs = safePath(req.query.path || '')
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter(e => !HIDDEN.has(e.name) && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: join(req.query.path || '', e.name).replace(/\\/g, '/'),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    res.json({ entries })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.get('/api/fs/read', (req, res) => {
  try {
    const abs = safePath(req.query.path)
    const st = statSync(abs)
    if (st.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'arquivo muito grande (>2MB)' })
    res.json({ content: readFileSync(abs, 'utf8'), path: req.query.path })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/fs/write', (req, res) => {
  try {
    const { path: rel, content } = req.body
    if (!rel) return res.status(400).json({ error: 'path required' })
    const abs = safePath(rel)
    writeFileSync(abs, content ?? '', 'utf8')
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// Cria um arquivo vazio ou uma pasta. kind: 'file' | 'dir'.
app.post('/api/fs/create', (req, res) => {
  try {
    const { dir = '', name = '', kind = 'file' } = req.body || {}
    const clean = String(name).trim()
    if (!clean || clean.includes('/') || clean.includes('\\') || clean.startsWith('.')) {
      return res.status(400).json({ error: 'nome inválido' })
    }
    const rel = join(dir || '', clean).replace(/\\/g, '/')
    const abs = safePath(rel)
    if (existsSync(abs)) return res.status(400).json({ error: 'já existe um item com esse nome' })
    if (kind === 'dir') mkdirSync(abs, { recursive: false })
    else writeFileSync(abs, '', { flag: 'wx' })
    res.json({ ok: true, path: rel, kind })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ── Insights — custo estimado e métricas de uso ───────────────────────────────

app.get('/api/insights', async (req, res) => {
  try {
    const { getInsights } = await import('./insights/index.js')
    const days = parseInt(req.query.days ?? '30', 10)
    res.json(getInsights(days))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Checkpoints — git shadow store ───────────────────────────────────────────

app.get('/api/checkpoints', async (req, res) => {
  try {
    const { listCheckpoints } = await import('./checkpoints/index.js')
    res.json({ checkpoints: await listCheckpoints() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/checkpoints', async (req, res) => {
  try {
    const { createCheckpoint } = await import('./checkpoints/index.js')
    const result = await createCheckpoint(req.body?.label ?? 'api')
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/checkpoints/:hash/restore', async (req, res) => {
  try {
    const { restoreCheckpoint } = await import('./checkpoints/index.js')
    const result = await restoreCheckpoint(req.params.hash)
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Kanban multi-agente ───────────────────────────────────────────────────────

app.post('/api/kanban/boards', async (req, res) => {
  const { createBoard } = await import('./kanban/index.js')
  try { res.json(createBoard(req.body?.name ?? `board-${Date.now()}`)) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.get('/api/kanban/boards/:name/status', async (req, res) => {
  const { getBoard, getBoardStatus } = await import('./kanban/index.js')
  const board = getBoard(req.params.name)
  if (!board) return res.status(404).json({ error: 'Board não encontrado' })
  res.json({ board: board.name, ...getBoardStatus(board.id) })
})

app.get('/api/kanban/boards/:name/tasks', async (req, res) => {
  const { getBoard, getBoardTasks } = await import('./kanban/index.js')
  const board = getBoard(req.params.name)
  if (!board) return res.status(404).json({ error: 'Board não encontrado' })
  res.json({ tasks: getBoardTasks(board.id) })
})

app.post('/api/kanban/boards/:name/tasks', async (req, res) => {
  const { getBoard, addTask } = await import('./kanban/index.js')
  const board = getBoard(req.params.name)
  if (!board) return res.status(404).json({ error: 'Board não encontrado' })
  try {
    const id = addTask(board.id, { title: req.body.title, description: req.body.description, priority: req.body.priority ?? 0, dependsOn: req.body.depends_on ?? [] })
    res.json({ id })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/kanban/boards/:name/dispatch', async (req, res) => {
  const { dispatch } = await import('./kanban/index.js')
  try {
    const result = await dispatch(req.params.name, req.body?.workers ?? 3)
    res.json(result)
  } catch (err) { res.status(400).json({ error: err.message }) }
})

// ── Curator de Skills ─────────────────────────────────────────────────────────

import('/config/workspace/orion/src/cron/curator.js') // pré-carrega o módulo
app.post('/api/curator/run', async (req, res) => {
  try {
    const { runCurator } = await import('./cron/curator.js')
    const result = await runCurator()
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// (Mixture of Agents removido em 2026-07-09 — attic/, nunca usado)

// ── Terminal multi-backend ────────────────────────────────────────────────────

app.post('/api/exec', async (req, res) => {
  try {
    const { execute, listBackends } = await import('./terminal/executor.js')
    const { cmd, backend, host, user, keyPath, cwd, timeout, env } = req.body
    if (!cmd) return res.status(400).json({ error: 'cmd obrigatório' })
    const result = await execute(cmd, { backend, host, user, keyPath, cwd, timeout, env })
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/exec/backends', async (req, res) => {
  const { listBackends } = await import('./terminal/executor.js')
  res.json({ backends: listBackends(), default: process.env.TERMINAL_BACKEND ?? 'local' })
})

// ── ACP Server (OpenAI-compatible — VS Code / JetBrains / Continue.dev) ──────

app.get('/v1/models', async (req, res) => {
  const { handleListModels } = await import('./acp/index.js')
  handleListModels(req, res)
})
app.get('/v1/models/:id', async (req, res) => {
  const { handleGetModel } = await import('./acp/index.js')
  handleGetModel(req, res)
})
app.post('/v1/chat/completions', async (req, res) => {
  const { handleChatCompletion } = await import('./acp/index.js')
  await handleChatCompletion(req, res)
})
// Alias sem auth para ferramentas que não passam cookie (path isento via basic_auth Caddy)
app.post('/api/acp/chat', async (req, res) => {
  const { handleChatCompletion } = await import('./acp/index.js')
  await handleChatCompletion(req, res)
})

// ── Profiles isolados ─────────────────────────────────────────────────────────

app.get('/api/profiles', async (req, res) => {
  const { listProfiles, getActiveProfile } = await import('./profiles/index.js')
  res.json({ profiles: listProfiles(), active: getActiveProfile() })
})
app.post('/api/profiles', async (req, res) => {
  try {
    const { createProfile } = await import('./profiles/index.js')
    const { name, cloneFrom } = req.body
    if (!name) return res.status(400).json({ error: 'name obrigatório' })
    const result = createProfile(name, cloneFrom ?? null)
    res.json(result)
  } catch (err) { res.status(400).json({ error: err.message }) }
})
app.get('/api/profiles/:name/switch', async (req, res) => {
  const { getSwitchInstructions } = await import('./profiles/index.js')
  res.json(getSwitchInstructions(req.params.name))
})

// ── LSP Client ────────────────────────────────────────────────────────────────

app.post('/api/lsp/action', async (req, res) => {
  try {
    const { getLspClient } = await import('./lsp/client.js')
    const { cmd = 'typescript-language-server', args = ['--stdio'], rootPath, action, uri, line = 0, character = 0 } = req.body
    if (!action || !uri) return res.status(400).json({ error: 'action e uri obrigatórios' })
    const client = getLspClient(cmd, args, rootPath)
    if (!client) return res.status(503).json({ error: 'LSP client não disponível' })
    let result
    if (action === 'hover')       result = await client.hover(uri, line, character)
    else if (action === 'definition') result = await client.definition(uri, line, character)
    else if (action === 'references') result = await client.references(uri, line, character)
    else if (action === 'open')   { await client.openFile(uri, req.body.text ?? '', req.body.languageId); result = { ok: true } }
    else return res.status(400).json({ error: `Ação desconhecida: ${action}` })
    res.json({ result })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.get('/api/lsp/clients', async (req, res) => {
  const { listLspClients } = await import('./lsp/client.js')
  res.json({ clients: listLspClients() })
})

// ── Computer Use ──────────────────────────────────────────────────────────────

app.get('/api/computer-use/status', async (req, res) => {
  const { getStatus } = await import('./computer-use/index.js')
  res.json(await getStatus())
})
app.get('/api/computer-use/screenshot', async (req, res) => {
  try {
    const { screenshot, isAvailable } = await import('./computer-use/index.js')
    if (!await isAvailable()) return res.status(503).json({ error: 'xdotool/scrot não instalados. No host: apt-get install -y xdotool scrot' })
    const data = await screenshot()
    if (req.query.format === 'base64') return res.json(data)
    res.setHeader('Content-Type', 'image/png')
    res.send(Buffer.from(data.base64, 'base64'))
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.post('/api/computer-use/action', async (req, res) => {
  try {
    const { runAction, isAvailable } = await import('./computer-use/index.js')
    if (!await isAvailable()) return res.status(503).json({ error: 'xdotool/scrot não instalados' })
    const result = await runAction(req.body)
    res.json({ ok: true, result: result ?? null })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Skill View (Tier 2 — conteúdo completo sob demanda) ──────────────────────

app.get('/api/skills/:name/view', (req, res) => {
  const db = getDb()
  const skill = db.prepare(`SELECT * FROM skills WHERE name = ? AND status != 'archived' LIMIT 1`).get(req.params.name)
  if (!skill) return res.status(404).json({ error: 'Skill não encontrada' })
  db.prepare(`UPDATE skills SET usage_count = usage_count + 1, last_used_at = unixepoch() WHERE id = ?`).run(skill.id)
  res.json({ skill })
})

// (trajectories/fine-tuning export removido em 2026-07-09 — attic/, nunca usado)

// ── Orchestrations — orquestrador autônomo em loop ────────────────────────────
app.post('/api/orchestrations', async (req, res) => {
  const { goal, source } = req.body
  if (!goal?.trim()) return res.status(400).json({ error: 'goal obrigatório' })
  try {
    const result = await createOrchestration(goal.trim(), { source: source ?? 'api' })
    res.json({ ok: true, ...result })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/orchestrations', (req, res) => {
  try {
    res.json(listOrchestrations(Number(req.query.limit) || 20))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/orchestrations/:id', (req, res) => {
  try {
    const o = getOrchestration(req.params.id)
    if (!o) return res.status(404).json({ error: 'não encontrada' })
    res.json(o)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/orchestrations/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const { id } = req.params
  subscribeOrch(id, res)

  // Send current state immediately
  const o = getOrchestration(id)
  if (o) res.write(`event: state\ndata: ${JSON.stringify({ status: o.status, steps_count: o.steps.length })}\n\n`)

  req.on('close', () => unsubscribeOrch(id, res))
})

// ── Missions — motor de tarefas autônomas de longa duração ───────────────────
app.post('/api/missions', async (req, res) => {
  const { goal, source } = req.body
  if (!goal?.trim()) return res.status(400).json({ error: 'goal obrigatório' })
  try {
    const result = await createAndExecuteMission(goal.trim(), { source: source ?? 'api' })
    res.json({ ok: true, ...result })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/missions', (req, res) => {
  try {
    const missions = listMissions(Number(req.query.limit) || 20)
    res.json(missions)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/missions/:id', async (req, res) => {
  try {
    const mission = getMission(req.params.id)
    if (!mission) return res.status(404).json({ error: 'Missão não encontrada' })
    const { getBoardTasks } = await import('./kanban/store.js')
    const tasks = mission.board_id ? getBoardTasks(mission.board_id) : []
    res.json({ ...mission, plan: JSON.parse(mission.plan ?? '[]'), tasks })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Orion Chat — web ↔ WhatsApp unificado ─────────────────────────────────────
// Estado de presença (heartbeat de aba ativa — se presente, não espelha no WA)
let _orionPresenceTs = 0
const _presenceWindowMs = 60_000

app.get('/api/orion/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  addOrionClient(res)
  res.write('event: connected\ndata: {}\n\n')
  const hb = setInterval(() => { try { res.write(':hb\n\n') } catch { clearInterval(hb) } }, 25_000)
  req.on('close', () => { clearInterval(hb); removeOrionClient(res) })
})

app.post('/api/orion/send', async (req, res) => {
  const { message } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'message required' })
  const text = message.trim()
  const jid = process.env.WHATSAPP_OWNER_JID
  res.json({ ok: true })  // respond immediately; processing is async
  emitOrionEvent('typing', { on: true })

  // Cronologia completa no WhatsApp: espelha a mensagem digitada na web
  // (prefixada pra distinguir; fromMe é filtrado no webhook, não cria loop)
  if (jid) {
    import('./gateway/evolution.js')
      .then(({ sendWhatsApp }) => sendWhatsApp(jid, `💻 *Chat UI:* ${text}`))
      .catch(() => {})
  }

  try {
    // sessionChannel:'whatsapp' → web e WhatsApp compartilham a MESMA sessão Claude (um cérebro só)
    const reply = await runOrion({ jid, message: text, channel: 'chat_ui', sessionChannel: 'whatsapp' })
    if (reply) {
      emitOrionEvent('assistant_message', { content: reply, ts: Date.now() })
      // Resposta sempre espelhada no WA — cronologia completa lá
      if (jid) {
        const { sendWhatsApp } = await import('./gateway/evolution.js')
        await sendWhatsApp(jid, reply).catch(() => {})
      }
    }
  } catch (e) {
    emitOrionEvent('assistant_message', { content: `❌ Erro: ${e.message}`, ts: Date.now() })
  } finally {
    emitOrionEvent('typing', { on: false })
  }
})

app.get('/api/orion/history', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 80), 200)
    const db = getDb()
    const jid = process.env.WHATSAPP_OWNER_JID
    const rows = db.prepare(`
      SELECT m.role, m.content, m.created_at, COALESCE(m.channel, s.channel) AS channel
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.jid = ? AND m.active = 1 AND s.channel IN ('whatsapp','chat_ui')
      ORDER BY m.created_at DESC LIMIT ?
    `).all(jid, limit)
    res.json({ messages: rows.reverse() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/orion/context-bar', (req, res) => {
  try {
    const db = getDb()
    const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 0 OR archived IS NULL").get()?.c ?? 0
    const orchRunning = db.prepare("SELECT COUNT(*) as c FROM orchestrations WHERE status = 'running'").get()?.c ?? 0
    res.json({
      memories: memCount,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      orchRunning,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/orion/presence', (req, res) => {
  _orionPresenceTs = Date.now()
  res.json({ ok: true })
})

app.post('/api/orion/silent', async (req, res) => {
  const silent = Boolean(req.body?.silent)
  setSilentMode(silent)
  let flushed = 0
  if (!silent) {
    // Saiu do modo silencioso → entrega o que ficou na fila
    try {
      const { flushSilentQueue } = await import('./gateway/evolution.js')
      flushed = await flushSilentQueue()
    } catch {}
  }
  res.json({ ok: true, silent, flushed })
})

// ── Aprovações bloqueantes (cross-surface) ────────────────────────────────────
app.get('/api/orion/approvals', (req, res) => {
  try { res.json({ approvals: listPendingApprovals() }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/orion/approvals', (req, res) => {
  const { question, context } = req.body
  if (!question?.trim()) return res.status(400).json({ error: 'question required' })
  try { res.json({ id: createApproval(question.trim(), { context, source: req.body.source || 'api' }) }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/orion/approvals/:id/answer', (req, res) => {
  const status = answerApproval(req.params.id, req.body?.answer ?? 'não', 'web')
  if (!status) return res.status(404).json({ error: 'aprovação não encontrada ou já respondida' })
  res.json({ ok: true, status })
})

// ── Inbox de decisões autônomas ───────────────────────────────────────────────
app.get('/api/orion/decisions', (req, res) => {
  try { res.json({ decisions: listAutonomousActions(Number(req.query.limit) || 30) }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/orion/decisions/:id/undo', (req, res) => {
  const r = undoAutonomousAction(Number(req.params.id))
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

// ── Saúde e outcomes (smoke test + taxas de sucesso) ──────────────────────────
app.get('/api/orion/smoke', async (req, res) => {
  const { getLastSmokeResult } = await import('./cron/smoke-test.js')
  res.json(getLastSmokeResult() || { ok: null, checks: [], at: null })
})

app.post('/api/orion/smoke/run', async (req, res) => {
  const { runSmokeTest } = await import('./cron/smoke-test.js')
  res.json(await runSmokeTest())
})

app.get('/api/orion/outcomes', (req, res) => {
  try {
    const db = getDb()
    const days = Math.min(Number(req.query.days) || 7, 90)
    const since = Math.floor(Date.now() / 1000) - days * 86400
    const orch = db.prepare(`
      SELECT SUM(status='done') ok, SUM(status='failed') fail, COUNT(*) total
      FROM orchestrations WHERE created_at > ? AND status != 'running'`).get(since)
    const miss = db.prepare(`
      SELECT SUM(status='done') ok, SUM(status='failed') fail, COUNT(*) total
      FROM missions WHERE created_at > ? AND status != 'running'`).get(since)
    const crons = db.prepare(`
      SELECT SUM(status='ok') ok, SUM(status!='ok') fail, COUNT(*) total
      FROM cron_output WHERE ran_at > ?`).get(since)
    res.json({ days, orchestrations: orch, missions: miss, crons })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Perguntas proativas → cards no chat ───────────────────────────────────────
app.get('/api/orion/proactive', (req, res) => {
  try {
    const rows = getDb().prepare(
      `SELECT id, question, category, created_at FROM proactive_questions WHERE answered = 0 ORDER BY created_at DESC LIMIT 5`
    ).all()
    res.json({ questions: rows })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/orion/proactive/:id/dismiss', (req, res) => {
  try {
    getDb().prepare(`UPDATE proactive_questions SET answered = 1, answered_at = unixepoch() WHERE id = ?`).run(Number(req.params.id))
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.listen(PORT, () => {
  getDb()
  bootstrapOwner()
  initCronJobs()
  emitBrain('info', { text: 'Orion v2 online' })

  // Consolidação automática
  cron.schedule('*/30 * * * *', phaseWrap('Phase2', runPhase2), { timezone: 'America/Sao_Paulo' })
  cron.schedule('0 */6 * * *',  phaseWrap('Phase3', runPhase3), { timezone: 'America/Sao_Paulo' })
  cron.schedule('0 0 * * *',   runPhase4,  { timezone: 'America/Sao_Paulo' })
  // Curator de skills — todo dia às 3h
  cron.schedule('0 3 * * *', () => {
    import('./cron/curator.js').then(({ runCurator }) => runCurator().catch(e => console.error('[curator] falhou:', e.message)))
  }, { timezone: 'America/Sao_Paulo' })
  // Smoke test diário — caminho crítico de ponta a ponta; falha → alerta WhatsApp
  cron.schedule('0 7 * * *', () => {
    import('./cron/smoke-test.js').then(({ runSmokeTest }) => runSmokeTest().catch(e => console.error('[smoke]', e.message)))
  }, { timezone: 'America/Sao_Paulo' })

  // Auditorias de memória — reativadas 2026-07-09 (baratas: ~20 Haiku/semana)
  cron.schedule('0 9 * * 0',  () => runPhase5().catch(e => console.error('[phase5]', e.message)), { timezone: 'America/Sao_Paulo' })
  cron.schedule('0 9 1 * *',  () => runPhase6().catch(e => console.error('[phase6]', e.message)), { timezone: 'America/Sao_Paulo' })
  // Desligados de propósito (2026-06-25, enxame de Haiku sem retorno):
  // phase7 mining, tier2 summaries, dedup mensal, snapshot-prune, cron-suggester.
  // consolidator/synthesizer/critic foram pro attic/ na lapidação de 2026-07-09.
  // cron.schedule('0 23 * * 0', () => runPhase7().catch(e => console.error('[phase7]', e.message)), { timezone: 'America/Sao_Paulo' })
  // cron.schedule('0 2 * * 5',  () => refreshAllCategorySummaries().catch(e => console.error('[tier2]', e.message)), { timezone: 'America/Sao_Paulo' })
  // cron.schedule('0 4 15 * *', async () => { try { await runDeduplication(); await sendNextDedupQuestion() } catch (e) { console.error('[dedup]', e.message) } }, { timezone: 'America/Sao_Paulo' })
  // cron.schedule('0 1 1 * *',  () => { try { pruneOldSnapshots(90) } catch {} }, { timezone: 'America/Sao_Paulo' })

  // Relatório semanal de colaboradores — sexta 17h
  cron.schedule('0 17 * * 5', () => {
    import('./cron/collab-reporter.js').then(({ runWeeklyReport }) => runWeeklyReport().catch(e => console.error('[collab-report]', e.message)))
  }, { timezone: 'America/Sao_Paulo' })
  // Verificação de inatividade — a cada 2h em horário comercial
  cron.schedule('0 8-18/2 * * 1-5', () => {
    import('./cron/collab-reporter.js').then(({ checkInactivity }) => checkInactivity().catch(e => console.error('[collab-inactivity]', e.message)))
  }, { timezone: 'America/Sao_Paulo' })
  // Budget check — a cada 3h
  cron.schedule('0 */3 * * *', () => {
    import('./cron/collab-reporter.js').then(({ checkBudgets }) => checkBudgets().catch(e => console.error('[collab-budget]', e.message)))
  }, { timezone: 'America/Sao_Paulo' })
  // Reset mensal de tokens — dia 1 às 0h
  cron.schedule('0 0 1 * *', () => {
    import('./cron/collab-reporter.js').then(({ resetMonthlyTokens }) => resetMonthlyTokens())
  }, { timezone: 'America/Sao_Paulo' })

  // Melhoria 7: Backfill de embeddings (uma vez por hora)
  cron.schedule('30 * * * *', () => backfillEmbeddings().catch(() => {}), { timezone: 'America/Sao_Paulo' })

  // Re-ingestão de conhecimento (vault + memory files + CLAUDE.md) — a cada hora
  const INGEST_SCRIPT = join(__dirname, '../scripts/ingest_knowledge.py')
  const runIngest = () => execFile('python3', [INGEST_SCRIPT], (err, stdout) => {
    if (err) console.error('[ingest] erro:', err.message)
    else console.log('[ingest]', stdout.trim().split('\n').at(-1))
  })
  cron.schedule('0 * * * *', runIngest, { timezone: 'America/Sao_Paulo' })

  // Pré-aquece o modelo de embeddings em background (não bloqueia o start)
  warmup().catch(() => {})

  // Indexa sessões Claude Code em background
  initSessionIndex().catch(e => console.error('[sessions] init error:', e.message))

  // Pré-aquece timeline + HTML das sessões abertas E top-20 mais recentes
  // Roda depois de 5s para não concorrer com o indexer na inicialização
  setTimeout(async () => {
    try {
      const db = (await import('./db/index.js')).getDb()
      // Sessões abertas + 20 mais recentes (união, sem duplicatas)
      const open = db.prepare(
        `SELECT id, path FROM claude_sessions WHERE deleted_at IS NULL AND hidden = 0
         ORDER BY CASE WHEN opened_at IS NOT NULL THEN 0 ELSE 1 END, last_modified DESC LIMIT 20`
      ).all()
      console.log(`[sessions] pré-aquecendo cache de ${open.length} sessões…`)
      for (const s of open) {
        try {
          const timeline = await getCachedTimeline(s.id, s.path)
          // Pré-builda o HTML também (elimina 2-3s na primeira visita)
          const size = statSync(s.path).size
          if (!_htmlRespCache.has(s.id) || _htmlRespCache.get(s.id).size !== size) {
            const session = getSession(s.id)
            const total = timeline.length
            const sliced = total > 60 ? timeline.slice(-60) : timeline
            const partial = getCachedPartial(s.id)
            const data = { session, timeline: sliced, total, active: false, partial }
            const json = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>')
            const baseHtml = chatHtml.replace('</head>', `<script>window.__INITIAL_DATA__=${json}</script></head>`)
            _htmlRespCache.set(s.id, { baseHtml, size })
          }
        } catch {}
      }
      console.log(`[sessions] cache de HTML aquecido para ${open.length} sessões`)
    } catch (e) { console.error('[sessions] warmup erro:', e.message) }
  }, 5000)

  // Retoma missões e orquestrações que estavam rodando antes do restart
  setTimeout(() => resumeRunningMissions(), 3000)
  setTimeout(() => resumeRunningOrchestrations(), 4000)

  console.log(`Orion v2 na porta ${PORT} — consolidação ativada`)
})
