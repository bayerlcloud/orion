import pino from 'pino'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(__dirname, '../logs')
mkdirSync(LOG_DIR, { recursive: true })

const isDev = process.env.NODE_ENV !== 'production'

const transport = pino.transport(isDev
  ? {
      // Dev: saída legível no terminal com cores
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    }
  : {
      // Prod: JSON em arquivo com rotação diária
      targets: [
        {
          target: 'pino/file',
          options: { destination: join(LOG_DIR, 'orion.log'), append: true },
        },
      ],
    }
)

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'orion' },
  },
  transport
)

// Logger por módulo — facilita filtrar por origem
export function createLogger(module) {
  return logger.child({ module })
}
