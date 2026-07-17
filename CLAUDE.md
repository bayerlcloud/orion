# Orion — CLAUDE.md

> Agente autônomo pessoal do Danilo Bayerl. Agente autônomo Node.js sobre o `claude` CLI.
> Leia este arquivo inteiro antes de qualquer modificação no projeto.

---

## O que é e o que não é

Orion é a infra de IA pessoal do Danilo — não é um produto. É um agente autônomo que:
- Fala via WhatsApp (Evolution API) e via UI web
- Tem memória persistente híbrida (BM25 + vetorial + recência)
- Cria skills automaticamente a partir do uso
- Agenda cron jobs por linguagem natural
- Orquestra sub-agentes via sessões reais do Claude Code (visíveis no sidebar do plugin)

**Não é React.** O dashboard é HTML/Express puro (arquivos em `src/ui/`).
**Não usa SDK da Anthropic.** Usa `claude` CLI via `execa`.

---

## Stack técnica

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js ESM (`"type": "module"`) |
| Entry point | `src/server.js` |
| Framework HTTP | Express 4 |
| Agent engine | `claude` CLI via `execa` |
| Banco de dados | `better-sqlite3` + FTS5 + `sqlite-vec` |
| Embeddings | `@xenova/transformers` (all-MiniLM-L6-v2, 384 dims, local) |
| Logger | `pino` + `pino-pretty` |
| Cron | `node-cron` |
| WhatsApp | Evolution API (`evo.bayerl.cloud`) |
| MCP server | `@modelcontextprotocol/sdk` (stdio) |
| Transcrição de áudio | `faster-whisper` via Python script local |

**Dependências principais** (package.json):
```
@modelcontextprotocol/sdk ^1.0.0
@xenova/transformers ^2.17.2
better-sqlite3 ^9.4.3
execa ^9.3.0
express ^4.19.2
node-cron ^3.0.3
pino ^10.3.1
pino-pretty ^13.1.3
dotenv ^16.4.5
cookie-parser ^1.4.7
```
Opcional: `sqlite-vec ^0.1.6`

---

## PM2 e porta

- **Processo PM2:** `orion`
- **Porta:** `8088`
- **Subdomínio:** `orion.bayerl.cloud` (basic_auth: bayerl / Bayerl21!)
  - A rota `/webhook/evolution` é **isenta de basic_auth** no Caddy (senão a Evolution não consegue postar). É protegida pelo filtro de owner JID no app.
  - O subdomínio `orion2.bayerl.cloud` foi **descontinuado** em 2026-06-25 (migração: orion virou o `orion.bayerl.cloud` oficial; o v1 Node foi deletado).
- **Restart:** `pm2 restart orion`
- **Logs:** `pm2 logs orion` ou `tail -f /config/workspace/orion/logs/orion.log`
- **Dev:** `npm run dev` (node --watch, porta 8088)

> ⚠️ **Nunca editar o `/opt/stack/Caddyfile` com `sed -i`** — quebra o bind-mount (cria inode novo) e o container do Caddy continua lendo a versão velha. Editar com Python `open(p,'w').write(...)` (preserva inode) e depois `docker exec stack-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

---

## Variáveis de ambiente (.env)

```
PORT=8088
EVOLUTION_API_URL=https://evo.bayerl.cloud
EVOLUTION_API_KEY=<secret>
EVOLUTION_INSTANCE=DaniloIA
WHATSAPP_OWNER_JID=5511918460531@s.whatsapp.net
DB_PATH=./data/memory.db
ANTHROPIC_MODEL=claude-sonnet-4-6
PANEL_TOKEN=<secret>
PANEL_API_URL=http://172.18.0.1:9099
```

---

## Estrutura de src/

```
src/
├── server.js              # Entry point — Express app, rotas, cron bootstrap
├── auth.js                # Auth por cookie (bayerl/Bayerl21!, TTL 7d)
├── logger.js              # Pino logger (dev=pretty, prod=JSON em logs/)
│
├── agent/
│   ├── orion.js           # Loop principal: recebe msg → contexto → claude CLI → salva
│   ├── orchestrator.js    # Orchestrator v1 — workers isolados (CLAUDE_CODE_DISABLE_MCP=1)
│   ├── delegate.js        # Delegate v2 — sub-agentes com sessões nomeadas no sidebar
│   ├── prompt.js          # System prompt byte-estável (prefix cache). buildMemoryContext()
│   ├── skill-generator.js # Detecta se troca vira skill (heurística + Haiku). retrieveSkills()
│   └── user-profile.js    # Mantém data/user_profile.md. Extrai fatos novos via Haiku
│
├── api/
│   ├── context.js         # Pipeline de contexto 6 camadas: perfil+CLAUDE.md+vault+vault-proj+memories+skills
│   └── usage.js           # Uso da API Anthropic via /config/.claude/.credentials.json (cache 1min)
│
├── cron/
│   ├── manager.js         # CRUD cron jobs no SQLite, parseNaturalCron(), executa via claude CLI
│   ├── phase2.js          # 30min — dedup BM25, decay, promoção raw→episodic (sem LLM)
│   ├── phase3.js          # 6h — merge Haiku, contradições, promoção semantic→skill, escrita vault
│   └── phase4.js          # Meia-noite — arquivamento + relatório diário WhatsApp
│
├── db/
│   ├── index.js           # Singleton better-sqlite3: WAL, FK on, busy_timeout 5s, repair FTS5
│   └── schema.js          # Schema completo + seeds (6 projetos conhecidos)
│
├── gateway/
│   ├── evolution.js       # Webhook /webhook/evolution — filtra owner JID, áudio, /multi
│   └── whisper_transcribe.py  # Transcrição OGG → texto via faster-whisper local (modelo small)
│
├── mcp/
│   └── memory-server.js   # MCP stdio — 5 ferramentas para o Claude Code plugin
│
├── memory/
│   ├── index.js           # Retrieval híbrido BM25+recência+vetor. saveMemory/saveRelation/saveEntity
│   ├── compressor.js      # Comprime sessão quando >40 msgs (soft-delete active=0)
│   ├── embeddings.js      # Xenova/all-MiniLM-L6-v2 local, cache em data/models/, lazy load
│   ├── extraction.js      # Extração regex (FACT_PATTERNS + ENTITY_PATTERNS), sem LLM
│   └── vector.js          # sqlite-vec: tabela vec_memories (384 dims). saveVector/searchVectors
│
├── sessions/
│   ├── indexer.js         # Indexa JSONL de /config/.claude/projects/ no banco. fs.watch + poll 5s
│   ├── reader.js          # Parseia .jsonl: extrai user/assistant/summary, leitura incremental
│   ├── registry.js        # session_registry — sessões nomeadas para delegate. getOrCreate()
│   └── sender.js          # Envia msg para sessão via claude --resume. Mutex por sessionId
│
├── ui/
│   ├── dashboard.html     # Dashboard principal
│   ├── sessions.html      # Lista de sessões Claude Code
│   ├── chat.html          # Viewer de sessão com SSE
│   ├── login.html         # Login
│   ├── automacoes.html    # Automações (cron jobs) — rota /automacoes, consome /api/cron
│   └── panel.html         # Painel do servidor (fundido do panel.bayerl.cloud)
│
└── scripts/
    └── ingest_knowledge.py  # Ingesta vault + CLAUDE.md no SQLite (cron 1h)
```

---

## Banco de dados

**Arquivo:** `/config/workspace/orion/data/memory.db`
**Pragmas:** WAL mode, `wal_autocheckpoint=100`, `foreign_keys=ON`, `busy_timeout=5000`

### Tabelas

| Tabela | Descrição |
|---|---|
| `memories` | Core — id TEXT PK, type (raw\|episodic\|semantic\|skill), content, source, confidence REAL, access_count, last_accessed, metadata JSON |
| `memories_fts` | FTS5 virtual — BM25 sobre content. Mantida por triggers INSERT/UPDATE/DELETE |
| `entities` | Mem0-style — name, type (person\|project\|tool\|pet\|place\|concept\|credential), description, confidence |
| `relations` | Knowledge graph leve — subject, relation, object, confidence, source |
| `skills` | Padrões reutilizáveis — name UNIQUE, description, content, vault_path, usage_count |
| `cron_jobs` | Jobs agendados — schedule (cron expr), task_prompt, status (active\|paused\|deleted) |
| `sessions` | Sessões de chat — channel (whatsapp\|plugin\|chat_ui\|neo\|cron), jid, claude_session_id |
| `messages` | Mensagens — session_id FK, role (user\|assistant), content, active INTEGER DEFAULT 1 |
| `claude_sessions` | Index do filesystem — UUID do .jsonl, path, cwd, títulos, hidden |
| `session_registry` | Sessões nomeadas para delegate — name, role, claude_session_id, status |
| `projects` | Registry de projetos — slug UNIQUE, path, claude_md, dev_port, subdomain |
| `vec_memories` | Virtual sqlite-vec — memory_rowid PK, embedding float[384] |

**Cuidado com FTS5:** o `db/index.js` repara a tabela na inicialização. Se corromper manualmente, reiniciar o processo resolve.

---

## MCP server (memory-server.js)

**Arquivo:** `src/mcp/memory-server.js`
**Transporte:** stdio
**Nome:** `orion-memory`
**Iniciar:** `npm run mcp` ou `node src/mcp/memory-server.js`
**Configurado em:** `~/.claude.json` (key `orion-memory`)

### 5 ferramentas disponíveis

| Ferramenta | Uso |
|---|---|
| `orion_memory_context(message, limit=8)` | Memórias relevantes via BM25 — chamar ANTES de responder |
| `orion_memory_save(content, type=episodic)` | Salva fato novo no SQLite |
| `orion_memory_search(query, limit=10)` | Busca explícita de memórias |
| `orion_context(message, project?, limit=6)` | Contexto COMPLETO: perfil + CLAUDE.md + vault + memories + skills |
| `orion_delegate(goal, role?, project?, sessionName?, context?)` | Delega para sub-agente especializado (sessão visível no sidebar) |

**Roles disponíveis para delegate:** `researcher` | `coder` | `analyst` | `writer` | `executor`

---

## Flow do agente (src/agent/orion.js)

```
runOrion({ jid, message, channel })
  1. getOrCreateSession()              — busca/cria sessão no SQLite
  2. compressSessionIfNeeded()         — comprime se >40 msgs (Haiku)
  3. buildFullContext()                — 6 camadas de contexto em paralelo
  4. buildSessionsSnapshot()          — lista sessões Claude Code ativas
  5. augmentedMessage = msg + contexto + memória proativa + snapshot
  6. getOrCreate() no session_registry (canal whatsapp)
  7. execa('claude', [...flags])       — chama o claude CLI
  8. Parseia JSON output, salva claude_session_id
  9. saveMessage()                    — persiste user+assistant no SQLite
  10. generateSkillIfWorthy() + updateUserProfile()  — background
  11. processExchange()               — extração regex + entidades + Haiku (background)
```

### Flags do claude CLI (sempre)

```
--dangerously-skip-permissions
--output-format json
--resume <session_id>   (quando existe sessão)
--system-prompt <SYSTEM_PROMPT>  (nova sessão)
cwd: /config/workspace  (para aparecer no sidebar do plugin)
```

---

## Modelos usados

| Modelo | Uso |
|---|---|
| `claude-sonnet-4-6` (env ANTHROPIC_MODEL) | Respostas principais (WhatsApp, chat UI) |
| `claude-haiku-4-5-20251001` | Extração de fatos, compressão, geração de skills, planejamento de cron |
| `Xenova/all-MiniLM-L6-v2` | Embeddings locais (384 dims, cache em data/models/) |

**Regra:** Haiku para tudo que roda em background ou é barato. Sonnet só para resposta ao usuário.

---

## Cron de consolidação de memória

| Fase | Frequência | O que faz | LLM? |
|---|---|---|---|
| Fase 2 | 30min | Dedup BM25, decay confiança, promoção raw→episodic | Não |
| Fase 3 | 6h | Merge de clusters, contradições, promoção semantic→skill, escrita vault | Haiku |
| Fase 4 | Meia-noite | Arquivamento + relatório WhatsApp | Haiku |
| Ingest | 1h | `scripts/ingest_knowledge.py` — vault + CLAUDE.md → SQLite | Não |

---

## Pipeline de contexto (6 camadas)

Construído em `src/api/context.js → buildFullContext()`:

1. `user_profile` — `/config/workspace/orion/data/user_profile.md`
2. `CLAUDE.md do projeto` — detectado por slug na mensagem, lido da tabela `projects`
3. `Vault global` — sempre inclui `Global/Padroes de Qualidade.md` + `Global/Stack Tecnica.md`
4. `Vault do projeto` — todos `.md` da pasta do projeto em `/config/workspace/notes/`
5. `Memories` — `retrieveHybrid()`: BM25 + vetor + recência, score = 0.4×BM25 + 0.4×vec + 0.2×recência
6. `Skills` — `retrieveSkills()` via LIKE no SQLite

**Invariante crítico:** memória é sempre injetada no **user message** (via tag `<memory>`). NUNCA no system prompt — quebraria o prefix cache.

---

## Projetos conhecidos (tabela projects)

| Slug | Path | Porta dev | Vault |
|---|---|---|---|
| brandspace | /config/workspace/brandspace | 8080 | Brandspace/ |
| trackingmachine | /config/workspace/trackingmachine | 8081 | TrackingMachine/ |
| ralab | /config/workspace/ralab | 8082 | Ralab/ |
| fisioexpert | /config/workspace/fisioexpert | 8083 | FisioExpert/ |
| abcprime | /config/workspace/abcprime | 8084 | ABCPrimeCred/ |
| orion | /config/workspace/orion | 8088 | Orion/ |

---

## Auth e segurança

- **Credenciais:** `bayerl` / `Bayerl21!`
- **Cookie:** `orion_auth`, TTL 7 dias
- **Paths sem auth:** `/login`, `/webhook/evolution`, `/health`
- **Webhook Evolution:** aceita apenas `WHATSAPP_OWNER_JID` (5511918460531)

---

## Padrões de código — seguir sempre

### ES Modules
Tudo com `import`/`export`. Nunca `require()`. Nunca CommonJS.

### Logger
```javascript
import logger from '../logger.js'
logger.info({ key: value }, 'mensagem descritiva')
logger.error({ err }, 'o que falhou')
```
Nunca `console.log` em produção. Sempre passar objeto de contexto.

### Banco de dados
```javascript
import db from '../db/index.js'
// Usar prepared statements sempre:
const stmt = db.prepare('SELECT * FROM memories WHERE id = ?')
const row = stmt.get(id)
```
O singleton já tem WAL e FK. Não reconectar, não criar nova instância.

### Execa para claude CLI
```javascript
import { execa } from 'execa'
const result = await execa('claude', [
  '-p', message,
  '--output-format', 'json',
  '--dangerously-skip-permissions',
  '--resume', sessionId
], { cwd: '/config/workspace' })
```
Sempre `cwd: '/config/workspace'` para que sub-agentes apareçam no sidebar.

### Background sem bloquear resposta
```javascript
// Pattern correto para tarefas background:
setImmediate(async () => {
  try {
    await processExchange(...)
  } catch (err) {
    logger.error({ err }, 'background task failed')
  }
})
```

---

## Regras — o que nunca fazer

1. **Nunca** modificar `src/db/schema.js` sem migração explícita — o schema cria tabelas com `IF NOT EXISTS`, alterações de coluna requerem migration manual.
2. **Nunca** injetar memória no system prompt — quebra o prefix cache da Anthropic.
3. **Nunca** mutar o array `messages[]` original ao preparar envio — sempre copiar.
4. **Nunca** usar `console.log` — usar `logger.info/error/warn/debug`.
5. **Nunca** usar `require()` — projeto é ESM puro.
6. **Nunca** sobrescrever arquivos em `notes/Global/` pelo loop de consolidação automática — Fase 3 só toca em `notes/Orion/memoria/`.
7. **Nunca** chamar o SDK da Anthropic diretamente — o projeto usa `claude` CLI via `execa` intencionalmente (herda MCPs, CLAUDE.md, tudo do ambiente).
8. **Nunca** reiniciar o processo `orion` no meio de uma Fase 3 (6h) sem verificar se há merge de clusters em andamento — pode corromper memórias.

---

## Regras — o que sempre fazer

1. **Sempre** passar `cwd: '/config/workspace'` ao chamar `execa('claude', ...)` — é o que faz sub-agentes aparecerem no sidebar do plugin.
2. **Sempre** usar `pm2 restart orion` para restartar (nunca matar e recriar).
3. **Sempre** usar `better-sqlite3` em modo síncrono (a lib não é async — não usar await com ela).
4. **Sempre** fazer repair do FTS5 ao modificar a tabela `memories` manualmente: `db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")`.
5. **Sempre** usar Haiku para tarefas de extração/consolidação em background (reduz custo).
6. **Ao adicionar nova rota protegida:** importar e usar o middleware de auth de `src/auth.js`.
7. **Ao adicionar novo projeto:** inserir na tabela `projects` via seed em `src/db/schema.js`.

---

## Orquestração multi-agente

### Orchestrator v1 (src/agent/orchestrator.js)
- Workers isolados com `CLAUDE_CODE_DISABLE_MCP=1`
- Sem sessões nomeadas, sem visibilidade no sidebar
- Ativado via `/multi <tarefa>` no WhatsApp ou `POST /api/orchestrate`
- Max 3 workers em paralelo, timeout 300s

### Delegate v2 (src/agent/delegate.js)
- Workers com sessões nomeadas no `session_registry`
- **Visíveis no sidebar do plugin Claude Code**
- Ativado via `POST /api/orchestrate-v2`, `POST /api/delegate`, ou MCP `orion_delegate`
- Profundidade máxima 2 (sem loops de delegação)

### Roles e ferramentas disponíveis por worker
| Role | Ferramentas |
|---|---|
| researcher | Read, Grep, Glob, WebFetch, WebSearch |
| coder | Read, Grep, Glob, Edit, Write, Bash |
| analyst | Read, Grep, Glob |
| writer | Read, Write |
| executor | `*` (todas as ferramentas) |

---

## Integração WhatsApp

- **Provider:** Evolution API
- **Instância:** `orion2` (env `EVOLUTION_INSTANCE`, nome externo legado do WhatsApp)
- **Webhook:** `POST /webhook/evolution` — configurado na Evolution apontando para `https://orion.bayerl.cloud/webhook/evolution` (eventos: `MESSAGES_UPSERT`)
- **Filtro:** só aceita mensagens do `WHATSAPP_OWNER_JID`
- **Áudio:** transcreve `.ogg` via `src/gateway/whisper_transcribe.py` (faster-whisper local, modelo small)
- **Slash commands disponíveis:**
  - `/multi <tarefa>` — ativa orchestrator paralelo
- **Timeout:** 45s → envia `⏳ Processando, aguarde...` enquanto aguarda claude CLI
- **Prefixo no reply:** `*Orion*` (formatação WhatsApp)

---

## Indexação de sessões Claude Code

- **Pasta monitorada:** `/config/.claude/projects/-config-workspace/`
- **Arquivos:** `.jsonl` — um por sessão do Claude Code
- **Método:** `fs.watch` + polling a cada 5s (fallback)
- **Leitura incremental:** por byte offset (não relê arquivos inteiros)
- **Sessões ativas:** detectadas via `ps aux | grep claude.*--resume <uuid>`
- **Sync com VS Code:** lê/escreve `hiddenSessionIds` em `/config/data/User/globalStorage/storage.json`

---

## Vault do Orion (/config/workspace/notes/Orion/)

Ler estes arquivos antes de trabalhar na arquitetura do Orion:

| Arquivo | Conteúdo |
|---|---|
| `arquitetura-v2.md` | Diagrama de arquitetura, fluxo de sessões, decisão de usar Claude Code sessions como sub-agentes |
| `arquitetura-decisoes.md` | Por que Node.js, por que claude CLI, invariantes de memória, histórico de decisões |
| `memoria-loop-design.md` | Ciclo de vida completo das memórias, 4 fases, custos, scoring híbrido |
| `visao-e-estrategia.md` | Estratégia de versões (v1 → v2 → produção), backlog de features |
| `planos-descobertos.md` | Features planejadas: Salim (monitor tokens), Kanban, API OpenAI-compat |
| `hermes-analise-completa.md` | Análise técnica do Hermes (referência de arquitetura) |
| `memoria/` | Skills auto-geradas pela Fase 3 (não editar manualmente) |

**Regra do vault:** o loop de consolidação (Fase 3) NUNCA toca em arquivos sem frontmatter YAML nem em `Global/`. Só escreve em `notes/Orion/memoria/`.

---

## Arquivos de dados

| Arquivo | Descrição |
|---|---|
| `data/memory.db` | Banco principal SQLite (+ -shm, -wal em WAL mode) |
| `data/user_profile.md` | Perfil do Danilo — atualizado automaticamente após cada conversa |
| `data/models/` | Cache do modelo Xenova (all-MiniLM-L6-v2) — não comitar |
| `logs/orion.log` | Log estruturado JSON em produção |

---

## Estratégia de versões (contexto importante)

```
orion/       → ESTE projeto. É o Orion oficial, serve orion.bayerl.cloud (porta 8088).
hermes/       → referência Python (Nous Research) — mantido para comparação (hermes.bayerl.cloud)
```

**Migração concluída em 2026-06-25:**
1. ✅ `orion.bayerl.cloud` → aponta para o orion (Caddy: `code-server:8088`)
2. ✅ `orion v1` (Node, porta 8087) deletado (`pm2 delete orion`). Backup do DB em `orion/backups/orion-v1-20260625.db`.
3. ✅ Subdomínio `orion2.bayerl.cloud` removido (Caddy block + registro A DNS)
4. Hermes **mantido** por enquanto (referência das rodadas de comparação).

A pasta `orion/` (v1) ainda existe no disco mas o processo está morto — pode ser arquivada/removida quando quiser.
