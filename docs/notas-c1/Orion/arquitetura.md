> ⚠️ **Nota (jun/2026):** a migração terminou — existe um único **Orion** (NÃO há "Orion 2"/v2). Menções a v1/v2/orion2 abaixo são **histórico** do projeto.

# Orion — Arquitetura

**Última atualização:** 2026-06-23

---

## Visão

Orion é um **agente autônomo pessoal**: um orquestrador único que delega tudo para sub-agentes especializados, tem memória auto-melhorável, e é acessível via WhatsApp, browser e CLI. Não executa tarefas diretamente — planeja, delega, sintetiza.

---

## Diagrama de sessões

```
┌─────────────────────────────────────────────┐
│              Orion Orchestrator              │
│            (Orion Orchestrator)              │
│  - Recebe input (WhatsApp / Dev / API)       │
│  - Planeja e delega para sub-agentes         │
│  - Sintetiza resultados                      │
│  - Auto-melhora memória em background        │
└────────────────┬────────────────────────────┘
                 │
     ┌───────────┼──────────────┐
     │           │              │
┌────▼────┐ ┌───▼────┐ ┌──────▼──────┐
│WhatsApp │ │  Dev   │ │    Cron     │
│Sessions │ │Sessions│ │   Agents    │
└─────────┘ └────────┘ └─────────────┘
     │           │              │
     └───────────┴──────────────┘
                 │
    ┌────────────▼────────────────┐
    │       Memória Unificada     │
    │  SQLite (FTS5 + vec)        │
    │  ← JSONL reader (Claude Code│
    │  ← Vault SilverBullet sync  │
    │  → Vault write automático   │
    └─────────────────────────────┘
```

---

## As 3 categorias de sessão

### 1. WhatsApp Sessions
- Canal principal: conversa diária com o Orion via WhatsApp
- Já funcional no v1 via Evolution API
- `claude --resume session_id` para continuidade entre dias
- Orion responde com contexto de memória completo

### 2. Dev Sessions — via Claude Code plugin (decisão Jun 23)

**Insight chave:** Neo não precisa de viewer próprio no dashboard.

Neo roda como uma sessão `claude` REAL nesta máquina. O Claude Code plugin já lê os arquivos JSONL em `~/.claude/projects/`. Qualquer sessão `claude` que rodar aqui aparece automaticamente na sidebar do plugin.

**Fluxo:**
- Orion spawna Neo como sessão `claude` → aparece no plugin como "Neo: [tarefa]"
- Você clica na sessão no plugin e vê ao vivo
- Pode assistir, digitar ou deixar autônomo
- Quando Neo termina, Orion monitora o JSONL e extrai o resultado

**Por que funciona sem config extra:**
Neo herda automaticamente todos os MCPs de `~/.claude.json` (ssh-contabo, hostinger, github, playwright) + CLAUDE.md com toda a infra documentada. Neo já sabe tudo que você sabe.

**Modos:**
- Autônomo: Neo trabalha sozinho, você recebe resultado no WhatsApp
- Observado: você abre a sessão no plugin e acompanha ao vivo
- Interativo: você digita na sessão do plugin se precisar intervir

### 3. Cron Agents
Agentes com agenda visíveis e gerenciáveis no dashboard:
- `"todo dia às 9h"` → resume o que aconteceu, agenda do dia
- `"quando projeto X tiver mudanças"` → revisa e reporta
- `"semanalmente"` → consolida memória, gera novos skills
- Cada agente aparece no Kanban com status: scheduled / running / done
- Pode ser pausado, editado, retomado pelo dashboard

---

## Memória unificada — como funciona

```
Claude Code aqui          Orion
     │                        │
     │  escreve                │  escreve
     ▼                        ▼
   JSONL ──────────────▶ SQLite Memory
   (~/.claude/projects/)  (FTS5 + vec)
                               │
     ▲                        │ sync auto
     │                        ▼
     └──────────── Vault SilverBullet
                  (/config/workspace/notes/)
                               │
                               ▼
                          CLAUDE.md carrega
                          → Claude Code lê
```

**O loop:**
1. Você trabalha aqui no Claude Code → gera JSONL
2. Background task do Orion lê JSONL, extrai insights, salva no SQLite
3. Orion também escreve no vault quando aprende algo importante
4. Claude Code carrega o vault via CLAUDE.md na próxima sessão
5. Memória bidirecional automática

---

## Kanban de sub-agentes

O Orion não executa — orquestra:

```
Task chega (WhatsApp / Dev / Cron)
         │
    auto_decompose
         │
    ┌────┴────┐
    │ Kanban  │ todo → ready → running → blocked → done
    └────┬────┘
         │ workers disputam tarefas
    ┌────┴──────────┐
    │               │               │
researcher      coder           analyst/writer
(busca info)  (escreve código)  (interpreta/redige)
    │               │               │
    └───────────────┴───────────────┘
                    │
              Synthesizer
                    │
              resposta final
```

Max 3 workers em paralelo. Cada worker: `claude -p <task>` isolado.

---

## Memória unificada — zero diferença entre canais (decisão Jun 23)

### O princípio
Se você falar "meu gato se chama Juvenal" no plugin, no WhatsApp, ou no chat UI do Orion — todos os canais sabem. Sempre. Sem repetir.

### Como funciona
**Uma única fonte de verdade:** `/orion2/data/memory.db` (SQLite).  
Todos os canais leem e escrevem no mesmo arquivo.

### O MCP de memória (peça central)
Um MCP local (stdio) que o Claude Code plugin usa automaticamente:

```
orion_memory_context(message)  → top-N memórias relevantes antes de responder
orion_memory_save(content)     → salva fato importante
orion_memory_search(query)     → busca explícita
```

Adicionado em `~/.claude.json` e instruído no CLAUDE.md:
> "Ao início de cada conversa: chame orion_memory_context. Ao aprender algo novo: chame orion_memory_save."

### Dupla garantia (nada se perde)
1. **MCP call direto** — imediato, quando Claude reconhece como importante
2. **JSONL reader background** — a cada 5 min lê sessões Claude Code, extrai tudo, salva no SQLite

O JSONL reader é o seguro. Mesmo que o MCP não seja chamado, em 5 minutos o fato está no banco.

### Resultado
| Canal | Lê de | Escreve em |
|---|---|---|
| WhatsApp (Orion) | SQLite direto | SQLite direto |
| Plugin Claude Code | SQLite via MCP | SQLite via MCP + JSONL reader |
| Chat UI orion2 | SQLite direto | SQLite direto |
| Cron agents / Neo | SQLite direto | SQLite direto |

## Memória SOTA — 5 features adicionais (decidido Jun 23)

1. **Entity extraction (Mem0-style)** — extrai entidades estruturadas, não só texto
2. **Relations table (grafo leve SQLite)** — subject/relation/object, sem Neo4j
3. **Auto-reflexão de padrões** — Haiku revisa semanalmente, gera insights sobre o usuário
4. **Detecção de contradições** — novo fato conflita com existente → sinaliza
5. **Memória proativa** — Orion sugere contexto relevante sem ser perguntado

## Cron jobs por linguagem natural (decidido Jun 23)

Orion cria cron jobs a partir de instrução em linguagem natural.  
Exemplo: "todo dia às 6h me dá resumo dos emails" → descobre contas pelo Gmail MCP → cria no SQLite → aparece no dashboard → confirma no zap.  
Dashboard tem UI: listar, pausar, editar, deletar cron jobs.

## Insight fundamental: Orion = Claude Code (Jun 23)

Orion e Claude Code são a mesma coisa por baixo: mesmo `claude` CLI, mesmos MCPs, mesmo CLAUDE.md, mesma memória. Diferença: quem está na frente do teclado — você ou o Orion. Tudo que você faz manualmente no plugin, o Orion faz autonomamente.

## Ordem de construção (aprovada Jun 23)

```
1. SQLite schema          — entities, relations, memories, skills, cron_jobs
2. Orion Memory MCP       — ponte entre todos os canais
3. Orion + WhatsApp      — loop básico funcionando
4. Consolidação Fase 1+2  — extração + entity extraction
5. Neo                    — sub-agente (sessão Claude Code real no plugin)
6. Consolidação Fase 3+4  — Haiku, skills, vault write
7. Chat UI orion2         — interface web
8. Cron jobs              — criação por linguagem natural + dashboard
9. Kanban + multiagentes  — workers paralelos, auto_decompose
```

## Referências

- Decisões fundamentais: [[arquitetura-decisoes]]
- Visão geral: [[visao-e-estrategia]]
- Análise técnica Hermes: [[hermes-analise-completa]]
- Loop de memória: [[memoria-loop-design]]
