# Orion

Agente autônomo pessoal do Danilo Bayerl.

Node.js ESM sobre `claude` CLI, memória híbrida BM25+vetorial, WhatsApp via Evolution API, orquestração de sub-agentes, dashboard web glassmorphism.

## Stack

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js ESM |
| Framework HTTP | Express 4 |
| Agent engine | `claude` CLI via `execa` |
| Banco de dados | `better-sqlite3` + FTS5 + `sqlite-vec` |
| Embeddings | `@xenova/transformers` (all-MiniLM-L6-v2, 384 dims, local) |
| Cron | `node-cron` |
| WhatsApp | Evolution API |
| MCP server | `@modelcontextprotocol/sdk` |

## Setup

```bash
npm install
cp .env.example .env
# Preencher .env com as credenciais
npm start
```

## Estrutura

```
src/
├── server.js          # Entry point Express
├── auth.js            # Auth por cookie
├── agent/             # Loop principal + orchestration
├── api/               # Context pipeline
├── cron/              # Consolidação de memória em fases
├── db/                # SQLite schema + singleton
├── gateway/           # WhatsApp webhook (Evolution API)
├── mcp/               # MCP stdio server
├── memory/            # Retrieval híbrido + embeddings
├── sessions/          # Indexer de sessões Claude Code
└── ui/                # Dashboard HTML/CSS/JS
```

## Porta

Roda na porta `8088` via pm2.
