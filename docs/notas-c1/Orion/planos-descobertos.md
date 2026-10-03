> ⚠️ **Nota (jun/2026):** a migração terminou — existe um único **Orion** (NÃO há "Orion 2"/v2). Menções a v1/v2/orion2 abaixo são **histórico** do projeto.

# Planos Descobertos nos Projetos

> Inventário de todos os planos (.md) encontrados nos projetos — o que existe, onde está, status.

---

## 🔍 SALIM — Monitor de Tokens (IMPLEMENTADO no Hermes)

**O que é:** Sub-agente que monitora uso de tokens do Claude sem Playwright — via API direta.

**Endpoint:**
```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth_token>
anthropic-beta: oauth-2025-04-20
```

**Token:** `/config/.claude/.credentials.json` (campo `access_token`)

**Retorna:**
```json
{
  "five_hour":  { "utilization": 0.81, "resets_at": "..." },  // sessão atual (5h)
  "seven_day":  { "utilization": 0.23, "resets_at": "..." },  // semana (7d)
  "seven_day_opus":   { "utilization": ... },
  "seven_day_sonnet": { "utilization": ... }
}
```

**Implementação Python (completa):** `/config/workspace/hermes/agent/account_usage.py`
→ função `_fetch_anthropic_account_usage()`

**Para usar no Orion (Node.js):**
```javascript
import { readFileSync } from 'fs'

async function getClaudeUsage() {
  const creds = JSON.parse(readFileSync('/config/.claude/.credentials.json', 'utf8'))
  const token = creds?.access_token ?? creds?.claudeAiOauth?.accessToken
  if (!token) return null

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
    }
  })
  return res.ok ? res.json() : null
}
```

**Descoberto em:** `/config/workspace/docs/superpowers/plans/2026-06-20-hermes-bayerl.md` (seção "Descoberta importante — Monitor de tokens")

---

## 🤖 Orion Orquestrador (PARCIALMENTE IMPLEMENTADO)

**Plano:** `/config/.claude/plans/breezy-swimming-creek.md`

**O que faz:** Orion recebe `/multi [tarefa]`, divide em subtarefas, roda workers `claude -p` em paralelo, sintetiza resultado.

**Status:** `src/agent/orchestrator.js` criado, `/multi` wired em `evolution.js`. Falta testar.

---

## 📅 Brandspace Supervisor (NÃO IMPLEMENTADO)

**Plano:** `/config/workspace/brandspace/docs/superpowers/plans/2026-06-12-supervisor.md`

**O que faz:** Agendador de mensagens WhatsApp com janela de horário aleatória (ex: 08:00–08:30) + AI pre-check que pula o envio se o contato já respondeu.

**Stack:** Supabase + pg_cron + Edge Function + Evolution API

---

## 🎓 Academix (PARCIALMENTE IMPLEMENTADO)

**Plano:** `/config/workspace/brandspace/docs/superpowers/plans/2026-06-20-academix.md`

**O que faz:** Ingere cursos (YouTube/Hotmart), transcreve com Whisper, cria RAG consultável via Einstein.

**Obs:** O plano usa OpenAI Whisper API — mas temos `faster-whisper` local gratuito em `/config/workspace/orion2/src/gateway/whisper_transcribe.py`.

**Worker:** `/config/workspace/academix-worker/`

---

## 🏦 ABCPrimeCred Sistema Completo (EM PROGRESSO)

**Plano:** `/config/workspace/abcprimecred/.claude/memory-bank/main/plans/main-2026-06-19-abcprimecred-full-system.md`

**O que faz:** 4 apps (portal público + SaaS corretores + admin + scraper), monorepo, Supabase backend.

---

## 🔌 Hermes OpenAI API Server (NÃO IMPLEMENTADO)

**Plano:** `/config/workspace/hermes/.plans/openai-api-server.md`

**O que faz:** Expõe o Hermes como endpoint OpenAI-compatível (`/v1/chat/completions` com SSE), permitindo conectar qualquer frontend (Open WebUI, LobeChat, etc.).

---

## 🌊 Hermes Streaming (NÃO IMPLEMENTADO)

**Plano:** `/config/workspace/hermes/.plans/streaming-support.md`

**O que faz:** Streaming token-por-token nas respostas do LLM, feature-flagged, degradação graciosa.
