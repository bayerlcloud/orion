// Extração de fatos e entidades via heurísticas (Fase 1 — sem LLM)
// Fase 3 (consolidação profunda) usará Haiku para enriquecer

const FACT_PATTERNS = [
  /meu (\w+) se chama ([A-ZÀ-Ú][a-zà-ú]+)/gi,
  /minha (\w+) se chama ([A-ZÀ-Ú][a-zà-ú]+)/gi,
  /meu nome é ([A-ZÀ-Ú][a-zà-ú]+)/gi,
  /(?:prefiro|gosto de|odeio|detesto) ([^.!?]+)/gi,
  /(?:sempre|nunca) ([^.!?]+)/gi,
  /o (\w+) (?:é|está|fica) ([^.!?]+)/gi,
  /(?:decidi|vamos|decidimos) ([^.!?]+)/gi,
]

const ENTITY_PATTERNS = [
  { pattern: /meu (?:cachorro|gato|pet|animal) (?:se chama|chama|é) ([A-ZÀ-Ú]\w+)/gi, type: 'pet', relation: 'tem_pet' },
  { pattern: /meu filho (?:se chama|chama|é) ([A-ZÀ-Ú]\w+)/gi, type: 'person', relation: 'tem_filho' },
  { pattern: /minha (?:esposa|namorada|mulher) (?:se chama|chama|é) ([A-ZÀ-Ú]\w+)/gi, type: 'person', relation: 'tem_parceira' },
  { pattern: /meu (?:projeto|sistema|app) (?:se chama|chama|é) ([A-ZÀ-Ú]\w+)/gi, type: 'project', relation: 'tem_projeto' },
  { pattern: /(?:uso|usamos|utilizamos) ([A-Z][a-zA-Z]+) (?:para|no|na)/gi, type: 'tool', relation: 'usa' },
]

export function extractFacts(text) {
  const facts = []
  for (const pattern of FACT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const fact = match[0].trim()
      if (fact.length > 10 && fact.length < 200) facts.push(fact)
    }
  }
  return [...new Set(facts)]
}

export function extractEntities(text) {
  const entities = []
  const relations = []

  for (const { pattern, type, relation } of ENTITY_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1]?.trim()
      if (!name) continue
      entities.push({ name, type })
      relations.push({ subject: 'Danilo', relation, object: name })
    }
  }

  return { entities, relations }
}
