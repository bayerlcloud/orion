/**
 * USER.md — Perfil persistente do Danilo.
 *
 * Acumula fatos sobre o usuário extraídos das conversas.
 * Injetado no system prompt de cada resposta.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execa } from 'execa'

import { createLogger } from '../logger.js'
const log = createLogger('user-profile')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILE_PATH = join(__dirname, '../../data/user_profile.md')

// Perfil inicial caso o arquivo não exista
const INITIAL_PROFILE = `# Perfil do Usuário

## Identidade
- Nome: Danilo Bayerl
- WhatsApp: 5511918460531
- Email: bayerlstudio@gmail.com
- Papel: Fundador / desenvolvedor full-stack / empreendedor

## Projetos ativos
- Orion: agente autônomo pessoal (Node.js, pm2, WhatsApp)
- Brandspace: SaaS para agências de marketing (React, Cloudflare)
- Ralab: sistema de gestão de clínicas dentárias
- TrackingMachine: CRM
- FisioExpert: app de fisioterapia
- ABCPrimeCred: portal de crédito imobiliário (4 apps, Supabase)

## Infraestrutura
- VPS Contabo: 86.48.28.10 (principal, Docker + Caddy)
- VPS Hostinger: 72.61.135.82 (legado)
- Domínio: bayerl.cloud
- code-server em code.bayerl.cloud

## Preferências de trabalho
- Responde em português brasileiro
- Prefere ações diretas sem pedir confirmação para coisas reversíveis
- Gosta de soluções simples e diretas
- Acorda cedo, trabalha de madrugada às vezes

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

// Extrai novos fatos da conversa e atualiza o perfil em background
export async function updateUserProfile(userMessage, assistantResponse) {
  // Só atualiza se a conversa parece conter fatos sobre o usuário
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

    // Adiciona os novos fatos na seção correta do perfil
    const updated = currentProfile.replace(
      '<!-- O Orion atualiza esta seção automaticamente -->',
      `<!-- O Orion atualiza esta seção automaticamente -->\n${text}`
    )
    writeFileSync(PROFILE_PATH, updated, 'utf8')
    log.info('[user-profile] atualizado com novos fatos')
  } catch {
    // silencioso — não bloqueia o fluxo principal
  }
}
