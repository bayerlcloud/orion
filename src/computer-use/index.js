/**
 * Computer Use — controle de desktop via xdotool + scrot no display virtual.
 *
 * Requer no sistema (instalar como root no host):
 *   apt-get install -y xdotool scrot
 *
 * O display virtual está em DISPLAY=:99 (Xvfb, sempre ativo).
 * Sem essas ferramentas, os endpoints retornam 503 com instruções.
 */
import { execa } from 'execa'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { createLogger } from '../logger.js'

const logger = createLogger('computer-use')
const DISPLAY = process.env.DISPLAY || ':99'
const ENV = { ...process.env, DISPLAY }
const SCREEN_PATH = '/tmp/orion-screen.png'

// Cache de disponibilidade por 60s
let _availCache = null
let _availCacheTs = 0

export async function isAvailable() {
  const now = Date.now()
  if (_availCache !== null && now - _availCacheTs < 60_000) return _availCache
  try {
    await execa('which', ['xdotool'], { reject: true, timeout: 2_000 })
    await execa('which', ['scrot'], { reject: true, timeout: 2_000 })
    _availCache = true
  } catch {
    _availCache = false
  }
  _availCacheTs = now
  return _availCache
}

export async function screenshot(outputPath = SCREEN_PATH) {
  if (!await isAvailable()) throw new Error('scrot não encontrado — instale: apt-get install -y xdotool scrot')
  const result = await execa('scrot', [outputPath, '--overwrite'], { env: ENV, reject: false, timeout: 10_000 })
  if (result.exitCode !== 0) throw new Error(`scrot falhou (exit ${result.exitCode}): ${result.stderr}`)
  const buf = await readFile(outputPath)
  return { path: outputPath, base64: buf.toString('base64'), mimeType: 'image/png', size: buf.length }
}

export async function click(x, y, button = 1) {
  if (!await isAvailable()) throw new Error('xdotool não encontrado')
  await execa('xdotool', ['mousemove', String(x), String(y)], { env: ENV, timeout: 5_000 })
  await execa('xdotool', ['click', String(button)], { env: ENV, timeout: 5_000 })
  logger.debug({ x, y, button }, 'click')
}

export async function doubleClick(x, y) {
  if (!await isAvailable()) throw new Error('xdotool não encontrado')
  await execa('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', '2', '1'], { env: ENV, timeout: 5_000 })
}

export async function type(text) {
  if (!await isAvailable()) throw new Error('xdotool não encontrado')
  await execa('xdotool', ['type', '--delay', '30', '--', text], { env: ENV, timeout: 30_000 })
  logger.debug({ chars: text.length }, 'typed')
}

export async function key(keysym) {
  if (!await isAvailable()) throw new Error('xdotool não encontrado')
  await execa('xdotool', ['key', keysym], { env: ENV, timeout: 5_000 })
}

export async function moveMouse(x, y) {
  if (!await isAvailable()) throw new Error('xdotool não encontrado')
  await execa('xdotool', ['mousemove', String(x), String(y)], { env: ENV, timeout: 5_000 })
}

export async function scroll(x, y, direction = 'down', clicks = 3) {
  if (!await isAvailable()) throw new Error('xdotool não encontrado')
  const btn = direction === 'down' ? '5' : '4'
  await execa('xdotool', ['mousemove', String(x), String(y)], { env: ENV })
  for (let i = 0; i < clicks; i++) {
    await execa('xdotool', ['click', btn], { env: ENV, timeout: 5_000 })
  }
}

export async function runAction(action) {
  switch (action.type) {
    case 'screenshot':   return screenshot(action.path)
    case 'click':        return click(action.x, action.y, action.button ?? 1)
    case 'double_click': return doubleClick(action.x, action.y)
    case 'type':         return type(action.text)
    case 'key':          return key(action.key)
    case 'move':         return moveMouse(action.x, action.y)
    case 'scroll':       return scroll(action.x, action.y, action.direction, action.clicks)
    default: throw new Error(`Ação desconhecida: ${action.type}. Disponíveis: screenshot, click, double_click, type, key, move, scroll`)
  }
}

export async function getStatus() {
  const available = await isAvailable()
  return {
    available,
    display: DISPLAY,
    xvfbRunning: existsSync('/tmp/.X99-lock'),
    tools: {
      xdotool: available,
      scrot: available,
    },
    installHint: available ? null : 'Para habilitar: (no host) apt-get install -y xdotool scrot',
  }
}
