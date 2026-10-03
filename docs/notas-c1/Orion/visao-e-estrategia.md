> ⚠️ **Nota (jun/2026):** a migração terminou — existe um único **Orion** (NÃO há "Orion 2"/v2). Menções a v1/v2/orion2 abaixo são **histórico** do projeto.

# Orion — Visão Geral e Estratégia

**Última atualização:** 2026-06-23

---

## O que é o Orion

Orion é o **agente autônomo pessoal do Danilo** — roda no Contabo, fala via WhatsApp, tem memória persistente, skills, cron, e vai evoluir para orquestrar múltiplos agentes especializados.

Não é um produto. É a infra de IA pessoal do Danilo, construída em Node.js sobre o `claude` CLI.

---

## Estratégia de versões (decisão Jun 2026)

```
hermes.bayerl.cloud  → referência visual (Python original, Nous Research)
orion.bayerl.cloud   → v1 atual (Node.js, funcional no WhatsApp)
orion2.bayerl.cloud  → v2 em construção (projeto novo, limpo)
```

**Plano:**
1. Construir o `orion2` com calma, sem pressa, peça por peça
2. Usar o `orion v1` só para aproveitar código Node.js já extraído do Hermes
3. Usar o `hermes` como referência visual enquanto precisar
4. Quando o `orion2` estiver pronto → virar `orion.bayerl.cloud`
5. Apagar `orion v1` e `hermes`

**Motivação:** o v1 tem dívida técnica, foi construído rápido. O v2 nasce com a arquitetura certa desde o início.

---

## Arquitetura alvo do Orion

### Stack
- **Runtime:** Node.js (ESM)
- **Agent:** `claude` CLI via `claude -p` + `--resume`
- **DB:** better-sqlite3 + sqlite-vec + FTS5
- **Embeddings:** @xenova/transformers (local, all-MiniLM-L6-v2)
- **Gateway WhatsApp:** Evolution API
- **Dashboard:** UI do Hermes copiada verbatim (`@nous-research/ui`)
- **WebSocket:** JSON-RPC 2.0 (protocolo exato do Hermes)
- **PTY:** node-pty (terminal xterm.js no browser)

### Princípios de design
1. System prompt **byte-estável** por sessão → prefix cache da Anthropic
2. Memória sempre no **user message** (never no system prompt)
3. Sync de memória **em background** (nunca bloqueia resposta)
4. `messages[]` **nunca mutado** para envio — sempre copiar
5. Tool results externos sempre em `<untrusted_tool_result>`
6. Compressão com **lock atômico** antes de executar

---

## Sistema de multiagentes — Kanban (prioridade alta)

Inspirado no Hermes, mas em Node.js:

### Conceito
```
Board SQLite: todo → ready → running → blocked → done → archived
```
- Tarefas com status, prioridade, contexto, assignee (agente)
- `auto_decompose`: decompõe automaticamente tarefas grandes em subtarefas
- Múltiplos workers `claude -p` disputam e executam tarefas em paralelo
- Orion orquestra, não executa diretamente tarefas complexas

### Slash commands do Kanban
```
/kanban new "descrição"     → cria tarefa
/kanban list                → lista board
/kanban next                → pega próxima tarefa disponível
/kanban done <id>           → marca completa
/bg <prompt>                → roda em background sem bloquear
/fork                       → cria branch da sessão atual
```

### Workers especializados
- `researcher` — busca info, URLs, análise
- `coder` — escreve/refatora código
- `analyst` — interpreta dados, relatórios
- `writer` — redação, formatação

### Fluxo de orquestração
```
Usuário: "cria relatório sobre X"
   ↓
Orion (orchestrator) → auto_decompose → [task1, task2, task3]
   ↓ Promise.all (max 3 concurrent)
Worker 1 (researcher)  Worker 2 (analyst)  Worker 3 (writer)
   ↓
Synthesizer → resposta final
```

---

## Gaps do v1 a implementar no v2 (por prioridade)

### 🔴 Core (sem eles o agente não presta)
- [ ] Context compression com 75% threshold + lock atômico
- [ ] Background review loop (auto-memória e auto-skills)
- [ ] Tool guardrails (loop detection via SHA256)
- [ ] Sistema de skills com YAML frontmatter completo
- [ ] System prompt 3 tiers (stable / context / volatile)

### 🟡 Multiagentes
- [ ] Kanban board SQLite
- [ ] Worker pool com concorrência limitada
- [ ] auto_decompose
- [ ] Slash commands: /bg, /fork, /kanban, /branch, /rollback
- [ ] Progress relay via WebSocket para o dashboard

### 🟢 Canais e integrações
- [ ] Telegram gateway
- [ ] API REST OpenAI-compatible (`/v1/chat/completions`)
- [ ] Pairing system (approve/deny novos usuários)
- [ ] Session mirroring (cron/CLI aparecem no transcript)

### 🔵 Dashboard (UI já pronta, backend faltando)
- [ ] Sessions com dados reais (ler JSONL do Claude Code)
- [ ] Analytics reais (tokens, custo, tools usadas)
- [ ] Config page funcional
- [ ] Logs page funcional
- [ ] Files browser funcional

---

## Referências

- Análise técnica do Hermes: [[hermes-analise-completa]]
- Hermes original rodando: hermes.bayerl.cloud (bayerl/Bayerl21!)
- Orion (versão antiga) rodando: orion.bayerl.cloud (bayerl/Bayerl21!)
- Código v1: `/config/workspace/orion/`
- Código Hermes: `/config/workspace/hermes/`
