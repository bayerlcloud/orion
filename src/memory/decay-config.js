export const HALF_LIFE_DAYS = {
  decision:   46,
  tool:       87,
  general:   139,
  project:   231,
  user_pref: 347,
  person:    693,
}

export const DECAY_RATES = Object.fromEntries(
  Object.entries(HALF_LIFE_DAYS).map(([k, v]) => [k, Math.LN2 / v])
)

export const CATEGORY_QUOTAS = {
  decision:  150,
  tool:      120,
  general:   250,
  project:   250,
  user_pref: 120,
  person:    150,
  default:   200,
}

export const HEBBIAN_DISTANCE = 0.49
