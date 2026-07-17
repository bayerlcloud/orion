// Half-life por categoria (dias) — configuração intuitiva.
// Half-life = tempo para um fato ter 50% da sua confiança original.
export const HALF_LIFE_DAYS = {
  decision:   46,   // ~6 semanas — decisões mudam
  tool:       87,   // ~3 meses — ferramentas evoluem
  general:   139,   // ~4.5 meses
  project:   231,   // ~7.5 meses — projetos estáveis
  user_pref: 347,   // ~11 meses — preferências duradouras
  person:    693,   // ~2 anos — fatos sobre pessoas
}

// Derivado matematicamente: rate = ln(2) / half_life
// Equivale ao decaimento exp(-rate * age_days) → 50% na half_life
export const DECAY_RATES = Object.fromEntries(
  Object.entries(HALF_LIFE_DAYS).map(([k, v]) => [k, Math.LN2 / v])
)

// Cota de memórias ATIVAS por categoria — teto estrutural anti-enxame.
// Encheu → a de menor valor (confiança × recência × uso) é arquivada.
export const CATEGORY_QUOTAS = {
  decision:  150,
  tool:      120,
  general:   250,
  project:   250,
  user_pref: 120,
  person:    150,
  default:   200,
}

// Gate hebbiano: distância L2 (métrica do vec0; embeddings normalizados) abaixo
// disso = mesmo fato → reforça a memória existente em vez de criar duplicata.
// L2 0.49 ⇔ cosseno 0.88 (L2² = 2·(1-cos)). Medido: quase-idênticos ≈ 0.29.
export const HEBBIAN_DISTANCE = 0.49
