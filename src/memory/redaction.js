/**
 * Redação de Dados Sensíveis — strip credentials antes de persistir na memória.
 * Item 1 da análise Hermes vs Orion Round 4.
 */

const SENSITIVE_PATTERNS = [
  // API keys e tokens com prefixos conhecidos
  { re: /\b(sk-|sk_live_|sk_test_|xoxb-|xoxp-|ghp_|gho_|ghs_|github_pat_|glpat-|npm_|dp\.|aiza)[A-Za-z0-9_\-]{8,}/gi, label: '[API_KEY]' },
  // Bearer / Authorization headers
  { re: /\bBearer\s+[A-Za-z0-9._\-]{20,}/gi, label: '[BEARER_TOKEN]' },
  // password=valor (qualquer formato)
  { re: /\b(password|senha|pwd|token|secret|api[_\-]?key|apikey|access[_\-]?token|auth[_\-]?token)\s*[=:]\s*\S+/gi, label: '[CREDENTIAL]' },
  // CPF brasileiro (com ou sem pontuação)
  { re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, label: '[CPF]' },
  // Cartão de crédito (16 dígitos em grupos)
  { re: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, label: '[CARD]' },
  // Strings hexadecimais longas (≥40 chars) — secrets de HMAC, digests, etc.
  { re: /\b[0-9a-f]{40,}\b/gi, label: '[HEX_SECRET]' },
  // Base64 longa sem espaços (≥60 chars) — tokens JWT, etc.
  { re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{60,}={0,2}(?![A-Za-z0-9+/])/g, label: '[BASE64_TOKEN]' },
]

/**
 * Redige dados sensíveis num texto.
 * @returns {{ content: string, changed: boolean, patterns: string[] }}
 */
export function redact(text) {
  if (!text || typeof text !== 'string') return { content: text, changed: false, patterns: [] }
  let out = text
  const patternsFound = []
  for (const { re, label } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0
    if (re.test(out)) {
      re.lastIndex = 0
      out = out.replace(re, label)
      patternsFound.push(label)
    }
  }
  return { content: out, changed: patternsFound.length > 0, patterns: patternsFound }
}

/** Retorna true se o texto parece conter dados sensíveis (sem modificar). */
export function containsSensitiveData(text) {
  if (!text) return false
  for (const { re } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0
    if (re.test(text)) return true
  }
  return false
}
