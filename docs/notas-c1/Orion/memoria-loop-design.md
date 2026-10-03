> ⚠️ **Nota (jun/2026):** a migração terminou — existe um único **Orion** (NÃO há "Orion 2"/v2). Menções a v1/v2/orion2 abaixo são **histórico** do projeto.

# Orion — Design do Loop de Memória

**Última atualização:** 2026-06-23

> Este é o coração do sistema. Sem o loop de consolidação, o banco cresce com lixo e a qualidade degrada. Com ele, o Orion aprende e fica mais inteligente com o tempo — igual ao Hermes.

---

## Visão geral: ciclo de vida de uma memória

```
Você fala algo
      ↓
[EXTRAÇÃO]  → raw_memory (confiança 0.1)
      ↓
[USO]  → a cada vez que é recuperada e útil → confiança sobe
      ↓
[CONSOLIDAÇÃO]  → memórias similares fundidas → episodic/semantic
      ↓
[PROMOÇÃO]  → alta confiança + muito acessada → vira skill no vault
      ↓
[DECAIMENTO]  → não acessada por 30 dias → arquivada / deletada
```

---

## Os 4 tipos de memória no SQLite

```sql
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  type        TEXT,        -- 'raw' | 'episodic' | 'semantic' | 'skill'
  content     TEXT,        -- o fato/decisão/skill em linguagem natural
  source      TEXT,        -- 'whatsapp' | 'plugin' | 'cron' | 'vault'
  confidence  REAL,        -- 0.0 a 1.0
  access_count INTEGER,    -- quantas vezes foi recuperada
  last_accessed INTEGER,   -- timestamp
  created_at  INTEGER,
  embedding   BLOB,        -- sqlite-vec (all-MiniLM-L6-v2, 384 dims)
  metadata    TEXT         -- JSON: tags, projeto, entidades relacionadas
)
```

### Os tipos:
- **raw** (0.1–0.4) — extraído automaticamente de uma conversa. Pode ser lixo.
- **episodic** (0.4–0.7) — evento específico. "Em 20/jun, deployamos Ralab com erro de porta."
- **semantic** (0.7–0.9) — fato consolidado. "IP do Contabo é 86.48.28.10."
- **skill** (0.9+) — procedimento reutilizável. Existe no SQLite E no vault como .md.

---

## O pipeline de injeção (tempo real, por turno)

**Antes de responder**, o sistema recupera contexto relevante:

```
User message: "instala o n8n no contabo"
      ↓
1. Gera embedding da mensagem
2. Busca no SQLite:
   - BM25 (FTS5): keywords "n8n", "contabo", "instala"
   - Vector: cosine similarity com embedding
   - Recência: e^(-λt) boost para memórias recentes
   score = 0.4×BM25 + 0.4×vector + 0.2×recency
3. Top-10 memórias relevantes
      ↓
Injetadas no FINAL da user message (nunca no system prompt):

<memory>
  [semântica] IP Contabo: 86.48.28.10. Stack em /opt/stack/
  [semântica] Docker Compose + Caddy. Sem Coolify no Contabo.
  [skill] Para novo serviço: editar docker-compose.yml + Caddyfile → dns_upsert → docker compose up -d
  [episódica] n8n pessoal rodando em workflow.bayerl.cloud (porta 5678)
</memory>
      ↓
Claude responde com contexto completo
```

**Invariante:** memória sempre no user message. Nunca no system prompt (quebraria o prefix cache).

---

## O loop de consolidação (background, 4 fases)

### Fase 1 — Extração (após cada turno, async)
Não bloqueia a resposta. Roda em background imediatamente após o Claude responder.

```
Extrai da conversa:
  - Fatos: "X é Y", "X fica em Y"
  - Decisões: "decidimos usar X", "vamos com Y"
  - Preferências: "Danilo prefere X", "sempre fazer Y"
  - Erros: "X falhou porque Y"
  - Entidades: projetos, URLs, IPs, nomes

→ Salva como raw_memory no SQLite (confiança 0.1)
→ Gera embedding assíncrono
→ NÃO chama LLM aqui (caro, desnecessário)
```

### Fase 2 — Consolidação leve (a cada 30 min ou 20 turnos)
Sem LLM. Só vector math.

```
1. Busca pares de raw_memories com similaridade > 0.88
2. Se encontrar:
   - Funde: mantém o mais recente, soma access_count
   - Sobe tipo: raw → episodic
   - Sobe confiança: média ponderada
3. Aplica decaimento:
   - Memórias raw não acessadas em 7 dias → confiança × 0.8
   - Memórias com confiança < 0.05 → deletar
```

### Fase 3 — Consolidação profunda (a cada 6 horas ou 100 turnos)
**Aqui entra o LLM.** É onde o Orion realmente "aprende".

```
1. Cluster de memórias similares (similaridade > 0.80):
   - Chama Claude: "Funda essas 4 memórias em 1 fato conciso"
   - Resultado: novo semantic_memory com confiança alta
   - Deleta os raws/episodics que foram fundidos

2. Candidates a skill (confiança > 0.85 + tipo episodic/semantic + acessada 5+ vezes):
   - Chama Claude: "Gera um skill document para: [memória]"
   - Formato: YAML frontmatter + corpo markdown
   - Salva no SQLite como skill (confiança 0.9+)
   - Verifica se já existe skill similar no vault:
     - Se sim → chama Claude para FUNDIR/REESCREVER o .md
     - Se não → cria novo .md em /notes/Orion/skills/

3. Review de skills existentes:
   - Skills não acessadas em 30 dias → marca como deprecated
   - Skills com conteúdo conflitante → chama Claude para resolver
```

### Fase 4 — Revisão diária (cron, todo dia às 3h)
```
1. Arquiva memórias episódicas com mais de 90 dias (move para tabela archive)
2. Exporta semantic_memories de alta confiança para vault se não existirem
3. Lê vault SilverBullet → extrai novos fatos → importa para SQLite
4. Gera relatório: "N memórias novas, M fundidas, K skills geradas"
5. Manda resumo no WhatsApp (opcional, configurável)
```

---

## O que vai para o vault SilverBullet

**Critério de promoção:** tipo `skill` ou `semantic` com confiança ≥ 0.9 + acessada ≥ 5 vezes.

**Estrutura de um skill .md:**
```markdown
---
name: deploy-novo-servico-contabo
type: skill
confidence: 0.95
created: 2026-06-23
tags: [infra, contabo, docker, deploy]
---

# Como deployar um novo serviço no Contabo

## Pré-requisitos
- Acesso SSH via mcp ssh-contabo
- ...

## Passos
1. Editar `/opt/stack/docker-compose.yml`
2. ...
```

**Onde ficam no vault:**
```
/notes/
  Orion/
    skills/           ← skills auto-geradas pelo loop
      deploy-servico.md
      criar-dns.md
      ...
    arquitetura-decisoes.md   ← escrito manualmente/semi-manual
    memoria-loop-design.md    ← este arquivo
  Global/
    Padroes de Qualidade.md   ← nunca sobrescrito pelo loop
```

**Regra de ouro:** o loop NUNCA sobrescreve arquivos em `Global/` nem arquivos sem frontmatter YAML. Só toca em `/Orion/skills/`.

---

## Sincronização bidirecional com Claude Code

```
Claude Code sessions (JSONL)
    ↓ (leitura, nunca escrita)
JSONL Reader (background, a cada 15 min)
    ↓
Extrai: decisões, fatos, erros, padrões
    ↓
SQLite raw_memories
    ↓ (loop de consolidação normal)
SQLite semantic/skills
    ↓ (se importante)
Vault SilverBullet
    ↓ (CLAUDE.md carrega na próxima sessão)
Claude Code já tem o contexto
```

**O CLAUDE.md é a ponte.** Orion escreve no vault → CLAUDE.md carrega o vault → Claude Code aqui tem o contexto na próxima sessão.

---

## Onde a memória é injetada para cada canal

| Canal | Memória injetada como |
|---|---|
| WhatsApp | `<memory>...</memory>` no final da user message |
| Plugin Claude Code | CLAUDE.md já carrega o vault (passivo) |
| Neo (sub-agente) | `<memory>...</memory>` na task description |
| Cron agent | `<memory>...</memory>` no prompt inicial |

---

## Custos e performance

| Operação | Frequência | Custo |
|---|---|---|
| Extração (Fase 1) | Toda resposta | Grátis (regex + heurística) |
| Busca retrieval | Toda resposta | ~2ms (SQLite FTS5 + vec) |
| Consolidação leve (Fase 2) | 30 min | Grátis (vector math) |
| Consolidação profunda (Fase 3) | 6 horas | $0.001–0.01 (Haiku) |
| Revisão diária (Fase 4) | 1x/dia | $0.01–0.05 (Haiku) |

A consolidação profunda usa **Haiku** (barato, rápido) — não Sonnet/Opus. Só para fusão e geração de skills simples.

---

## Referências

- Arquitetura geral: [[arquitetura]]
- Análise técnica do Hermes (onde extraímos isso): [[hermes-analise-completa]]
- Decisões fundamentais: [[arquitetura-decisoes]]
