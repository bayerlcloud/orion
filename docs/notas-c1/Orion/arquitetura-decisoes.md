> ⚠️ **Nota (jun/2026):** a migração terminou — existe um único **Orion** (NÃO há "Orion 2"/v2). Menções a v1/v2/orion2 abaixo são **histórico** do projeto.

# Orion — Decisões de Arquitetura (Memória de Projeto)

**Última atualização:** 2026-06-23  
**Fonte:** Escavação de transcripts Jun 18–23, 2026

> Este documento é a memória permanente do projeto Orion. Deve ser lido no início de cada sessão de trabalho no Orion. Atualizar sempre que uma nova decisão for tomada.

---

## Por que o Orion existe

**Motivação original (Jun 22, transcript 4e352b4b):**

> "eu quero criar um painel para mim tipo openclaw hermes de multi agentes com cron jobs e base de conhecimento vetorial e continua compartilhado com a nossa stack aqui... que inclusive cuide dos projetos aqui dentro para mim do tipo: vai vibe codando essa tool... quando o usage chegar em 95% vc pede para parar e agenda um cron job para voltar no chat e mandar retomar quando os token da janela do claude code renovarem"

> "assim eu tenho open claw - lovable - hermes tudo numa única ui universal que controle nosso code-server + claude code plugin aqui nativamente"

**Em outras palavras:** Orion é a infra de IA pessoal do Danilo — um agente autônomo que vive no Contabo, fala via WhatsApp, tem memória persistente, cron jobs, skills auto-geradas, e eventualmente orquestra múltiplos agentes especializados. Não é produto. É o "copiloto pessoal" do Danilo para seu setup de desenvolvimento.

---

## Decisão fundamental: Node.js, não Python

**Decisão (Jun 22, transcript 4e352b4b):**

> "vamos criar o orion... vai ser a versao nossa do hermes transformada em node..react e tailwind... orion.bayerl.cloud... pode fazer"

> "entao gera um plano foda com ui.... que garanta integração 100% com nossa stack aqui..... sabe...mesma memória... agente 100% integrado.... o nosso hermes vai ser construído em cima da nossa carroceria do claude aqui do code-server"

**Racional:** integração nativa com a stack existente (Contabo, Docker Compose, Evolution API, SilverBullet). Python introduziria uma segunda linguagem de runtime sem ganho real.

---

## Exigência de fidelidade 100% ao Hermes

**Três momentos distintos onde o Danilo reforçou isso:**

1. > "eu quero 101% do hermes no nosso... os mínimos detalhes"
2. > "faz uma reprodução fidedigna do hermes para nós...às vezes o que faz ele ser brilhante é algo na arquitetura que não dá para fazer (o que entendeu)"
3. > "quero que o UI do ORION seja 100% igual ao HERMES... quero o HERMES em node depois a gente adapta ele"

**Implicação prática:**
- UI: copiar verbatim o repositório `web-hermes/` do NousResearch (React + `@nous-research/ui`)
- Protocolo: WebSocket JSON-RPC 2.0 idêntico ao Hermes
- PTY: node-pty bridgeado para xterm.js (Chat page)
- Token injection: `window.__HERMES_SESSION_TOKEN__` injetado no index.html no serve-time

---

## Stack técnica aprovada

| Componente | Tecnologia | Decisão |
|---|---|---|
| Runtime | Node.js ESM | Integração nativa com stack |
| Agent engine | `claude -p` + `--resume` | Claude CLI disponível no code-server |
| Database | better-sqlite3 + FTS5 + sqlite-vec | Sem Qdrant externo |
| Embeddings | @xenova/transformers (all-MiniLM-L6-v2) | Local, gratuito, offline |
| UI / Dashboard | `web-hermes/` do NousResearch | Cópia verbatim |
| WebSocket | JSON-RPC 2.0 em `/api/ws` | Protocolo exato do Hermes |
| PTY terminal | node-pty → xterm.js em `/api/pty` | Chat page funcional |
| WhatsApp | Evolution API (evo.bayerl.cloud) | Já rodando no Contabo |

---

## Sistema de memória — escolha e motivação

**Pergunta original (Jun 22, transcript 4e352b4b):**

> "certo mas esse lance dele aprender sozinho... auto geração de skills memória FTS5 full-text + LLM summarization. Isso é uma coisa que conseguimos reproduzir?"

> "eu vi uns tutoriais falando que a memória do hermes era foda... tinha 5 camadas... isso podemos entender que é vetorial também?"

**Decisão:** Memória híbrida FTS5 + sqlite-vec (sem Qdrant externo):
- **BM25 (FTS5):** busca lexical, keywords exatas, rápida
- **sqlite-vec:** busca semântica por proximidade vetorial
- **Recência:** exponential decay score (`e^(-λt)`)
- Score final = `0.4 * bm25 + 0.4 * vector + 0.2 * recency`

**Invariantes de memória (críticos):**
1. Memória SEMPRE no user message, nunca no system prompt
2. Sync de memória em background (nunca bloqueia a resposta)
3. System prompt byte-estável por sessão (prefix cache Anthropic)

---

## Conceito Salim — agente gerenciador de token window

**Visão (Jun 22, transcript 0727f1a5):**

O Danilo quer um sub-agente chamado "Salim" que:
- Monitora o uso de tokens da janela do Claude Code
- Quando usage chega a 95%, para a tarefa, agenda cron job
- Cron job retoma automaticamente quando a janela renovar
- Permite trabalhar overnight sem perder progresso

**Status:** conceitual, não implementado ainda. Prioridade pós-v2.

---

## Migração Chromium compartilhado

**Decisão (Jun 22, transcript 0727f1a5):**

```
Estado atual:
- playwright-mcp tem Chromium próprio (porta 8931)
- hermes-dashboard tem Chromium próprio

Estado futuro:
- 1 único Chromium compartilhado (linuxserver/chromium)
- noVNC ao vivo em browser.bayerl.cloud
- playwright-mcp → PLAYWRIGHT_WS_ENDPOINT
- Hermes/Orion → CDP URL
```

**Timeline:** depois que Orion estiver estável.

---

## Multi-model routing (visão)

**Intenção do Danilo:** diferentes agentes usam diferentes modelos conforme complexidade:
- Haiku: email summarization, tasks simples, classificação
- Sonnet: tasks normais, coding padrão
- Opus: raciocínio complexo, arquitetura, análise profunda

**Status:** não implementado ainda. Fazer no contexto do Kanban multi-agente.

---

## Estratégia de versões (decisão Jun 23)

```
hermes.bayerl.cloud   → referência (Python original, Nous Research) — temporário
orion.bayerl.cloud    → v1 (funcional no WhatsApp, dívida técnica)
orion2.bayerl.cloud   → v2 em construção (projeto novo e limpo)
```

**Plano:**
1. `orion2` nasce como projeto do zero, arquitetura certa
2. Aproveitar só código Node.js já extraído do `orion v1`
3. `hermes` fica de referência visual enquanto precisar
4. Quando `orion2` pronto → vira `orion.bayerl.cloud`
5. Apagar `orion v1` e `hermes`

**Motivação:** v1 tem dívida técnica acumulada. v2 nasce com todas as decisões certas desde o início.

---

## Padrão de execução autônoma (SaasMaster)

**Aprendizado de outra conversa (Jun 22, transcript 1f8e30fb):**

Danilo quer execução zero-intervenção:
> "eu quero como premissa que não pergunte nada... simplesmente vai até o final"

Padrão aprovado para agentes autônomos:
1. **Brief** — extrair/assumir requisitos
2. **Plan** — único ponto de espera (pode ser removido)  
3. **Execute** — subagentes em paralelo
4. **Verify** — loop Playwright auto-correção

Aplicar este padrão no Orion para tasks via WhatsApp: receber instrução → executar → reportar resultado. Sem confirmações intermediárias.

---

## Requisitos do sistema de memória do Orion

O Danilo quer que o Orion resolva exatamente o problema que está acontecendo agora: contexto se perde entre sessões.

**Requisitos explícitos:**
- Decisões arquiteturais preservadas entre sessões
- Skills auto-geradas após cada tarefa completada
- Background review loop que consolida memória automaticamente
- Vault do SilverBullet sincronizado com a memória do agente
- Contexto de projeto disponível ao iniciar qualquer sessão

**Por isso o vault é crítico:**
- `/config/workspace/notes/` = fonte de verdade permanente
- Claude lê no início de cada sessão de trabalho em projeto
- Orion escreve nele automaticamente após aprender algo novo

---

## O que está implementado no v1 (referência)

| Funcionalidade | Status v1 |
|---|---|
| better-sqlite3 + FTS5 + sqlite-vec | ✅ |
| @xenova/transformers (embeddings) | ✅ |
| Vault sync (SilverBullet → memória) | ✅ |
| `claude --resume` (multi-turn) | ✅ |
| Skills auto-geradas | ✅ (básico) |
| WhatsApp via Evolution | ✅ |
| React dashboard (UI Hermes) | ✅ |
| WebSocket JSON-RPC 2.0 | ✅ |
| PTY (xterm.js + node-pty) | ✅ |
| Cron system | ✅ (básico) |
| Context compression 75% | ❌ |
| Tool guardrails (SHA256 loop) | ❌ |
| System prompt 3 tiers | ❌ |
| Background review loop | ❌ |
| Kanban multi-agente | ❌ |
| Multi-model routing | ❌ |
| API OpenAI-compatible | ❌ |
| Telegram gateway | ❌ |

---

## Referências

- Visão e estratégia geral: [[visao-e-estrategia]]
- Análise técnica completa do Hermes: [[hermes-analise-completa]]
- Código v1: `/config/workspace/orion/`
- Hermes original: `hermes.bayerl.cloud` (bayerl/Bayerl21!)
- Orion (versão antiga) rodando: `orion.bayerl.cloud` (bayerl/Bayerl21!)
