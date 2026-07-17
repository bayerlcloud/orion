import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { createLogger } from '../logger.js'
const log = createLogger('user-profile')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILE_PATH = join(__dirname, '../../data/user_profile.md')

const INITIAL_PROFILE = `# Perfil do Usuário

## Identidade
- Nome: (configure em OWNER_DISPLAY_NAME no .env)

## Projetos ativos
<!-- preencha após o primeiro uso -->

## Preferências de trabalho
<!-- preencha após o primeiro uso -->

## Fatos aprendidos nas conversas
<!-- O Orion atualiza esta seção automaticamente -->
`

export function loadUserProfile() {
  if (!existsSync(PROFILE_PATH)) {
    writeFileSync(PROFILE_PATH, INITIAL_PROFILE, 'utf8')
    return INITIAL_PROFILE
  }
  return readFileSync(PROFILE_PATH, 'utf8')
}

export function buildProfileContext(profile) {
  if (!profile || profile.trim().length < 10) return ''
  return `\n\n<perfil_usuario>\n${profile.trim()}\n</perfil_usuario>`
}

export async function updateUserProfile(userMessage, assistantResponse) {
  const triggers = [
    'meu ', 'minha ', 'eu ', 'a gente ', 'prefiro ', 'gosto ', 'odeio ',
    'sempre ', 'nunca ', 'trabalho ', 'moro ', 'tenho ', 'sou ',
  ]
  const lower = userMessage.toLowerCase()
  if (!triggers.some(t => lower.includes(t))) return

  const currentProfile = loadUserProfile()

  const prompt = `Você é um extrator de fatos sobre o usuário. Analise esta conversa e extraia APENAS fatos novos e relevantes sobre o usuário que ainda NÃO estão no perfil atual.

PERFIL ATUAL:
${currentProfile.slice(0, 1500)}

MENSAGEM DO USUÁRIO: ${userMessage.slice(0, 400)}

RESPOSTA DO ASSISTENTE: ${assistantResponse.slice(0, 300)}

Se há fatos novos relevantes (projetos, preferências, rotinas, pessoas, decisões importantes), responda com bullet points em português para adicionar na seção "Fatos aprendidos". Máximo 3 bullets por vez.
Se não há nada novo relevante, responda apenas: NADA

Responda apenas os bullets ou NADA:`

  try {
    const result = await execa('claude', [
      '-p', prompt,
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ], { timeout: 25_000 })

    const parsed = JSON.parse(result.stdout)
    const text = (parsed.result ?? parsed.content ?? '').trim()

    if (!text || text === 'NADA' || text.toUpperCase().includes('NADA')) return

    const updated = currentProfile.replace(
      '<!-- O Orion atualiza esta seção automaticamente -->',
      `<!-- O Orion atualiza esta seção automaticamente -->\n${text}`
    )
    writeFileSync(PROFILE_PATH, updated, 'utf8')
    log.info('[user-profile] atualizado com novos fatos')
  } catch {
    // silencioso
  }
}
