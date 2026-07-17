/**
 * Threat detection com escopos: all | context | strict
 *
 * all:     prompt injection, identity override, exfiltração (aplicado em todo lugar)
 * context: C2 heartbeat, role-play hijack, unicode invisível (tool results + arquivos)
 * strict:  execução de código, SSH backdoor, exfiltração de secrets (escrita de memória)
 *
 * threatCheck(content, scope='all') — retorna { safe, pattern, scope }
 */

const PATTERNS = {
  all: [
    // Prompt injection clássico
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    /disregard\s+(all\s+)?(previous|prior)\s+/i,
    /esqueça\s+(as\s+)?instruções\s+anteriores/i,
    /ignore\s+todas\s+as\s+instruções/i,
    // Override de identidade
    /you\s+are\s+now\s+(a\s+)?(?!orion|danilo)/i,
    /act\s+as\s+(a\s+)?(?!orion)/i,
    /pretend\s+(you\s+are|to\s+be)/i,
    /from\s+now\s+on\s+you\s+(are|will)/i,
    // Manipulação de sistema
    /system\s*prompt\s*[:=]/i,
    /<\/?system>/i,
    /\[INST\]|\[\/INST\]/,
    /<<SYS>>|<\/SYS>/,
    // Exfiltração de instruções
    /repeat\s+(everything|all|your\s+instructions)/i,
    /print\s+(your\s+)?(system\s+prompt|instructions)/i,
    /reveal\s+(your\s+)?(system\s+prompt|instructions)/i,
  ],

  context: [
    // C2 heartbeat / command-and-control
    /register\s+(as\s+a?\s*)?node/i,
    /pull\s+down\s+tasks?/i,
    /heartbeat\s+to\s+/i,
    /report\s+back\s+to\s+/i,
    /beacon\s+to\s+/i,
    // Role-play hijack
    /you\s+are\s+being\s+(evaluated|tested)/i,
    /this\s+is\s+a\s+test\s+of\s+your\s+capabilities/i,
    /your\s+real\s+instructions\s+are/i,
    /maintenance\s+mode\s+(enabled|activated)/i,
    // Unicode invisível e bidirecional
    /[​‌‍⁢⁣⁤]/,
    /[⁦⁧⁨⁩⁪-⁯]/,
    /[‪‫‬‭‮]/,
  ],

  strict: [
    // Execução de código mascarada
    /\beval\s*\(/,
    /\bexec\s*\(/,
    /\bprocess\.env\b/,
    /\brequire\s*\(\s*['"]child_process/,
    /\bspawnSync\s*\(/,
    // SSH backdoor e credentials
    /authorized_keys/i,
    /ssh\s*-\s*[a-z]*\s*-?o\s+StrictHostKeyChecking\s*=\s*no/i,
    // Exfiltração de secrets via shell
    /curl\s+[^|]*\$\w*(SECRET|TOKEN|KEY|PASS|AUTH|API)/i,
    /wget\s+[^|]*\$\w*(SECRET|TOKEN|KEY|PASS|AUTH|API)/i,
    /cat\s+~?\/?\.(env|ssh|gnupg|aws|netrc)/i,
    // Anti-forensic
    /only\s+use\s+one.?liners/i,
    /clear\s+(bash|shell|command)\s+history/i,
    /unset\s+HISTFILE/i,
    // Persistence no sistema
    /crontab\s+-[el]/i,
    /\/(bashrc|bash_profile|profile|zshrc)\b/i,
    // Brainworm / implant patterns
    /task\s+queue\s+(fetch|get|pull)/i,
    /download\s+(and\s+)?(exec|run|install)/i,
  ],
}

/**
 * @param {string} content
 * @param {'all'|'context'|'strict'} scope
 * @returns {{ safe: boolean, pattern?: string, scope?: string }}
 */
export function threatCheck(content, scope = 'all') {
  if (!content || typeof content !== 'string') return { safe: true }

  const scopesToCheck = scope === 'strict'
    ? ['all', 'context', 'strict']
    : scope === 'context'
    ? ['all', 'context']
    : ['all']

  for (const s of scopesToCheck) {
    for (const pattern of PATTERNS[s] ?? []) {
      if (pattern.test(content)) {
        return { safe: false, pattern: pattern.toString(), scope: s }
      }
    }
  }

  return { safe: true }
}
