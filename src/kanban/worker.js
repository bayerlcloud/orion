import { execa } from 'execa'
import { createLogger } from '../logger.js'
import { getNextTask, completeTask, failTask, heartbeat, recoverStaleTasks } from './store.js'
const logger = createLogger('kanban-worker')

const HEARTBEAT_MS = 30_000
const TASK_TIMEOUT_MS = 600_000

export async function runWorker(boardId, workerId) {
  logger.info({ boardId, workerId }, 'worker iniciado')
  recoverStaleTasks()

  let currentTaskId = null
  const hbTimer = setInterval(() => {
    if (currentTaskId) heartbeat(workerId, currentTaskId)
  }, HEARTBEAT_MS)

  try {
    while (true) {
      const task = getNextTask(boardId, workerId)
      if (!task) break

      currentTaskId = task.id
      logger.info({ taskId: task.id, title: task.title }, 'executando task')

      try {
        const proc = execa('claude', [
          '-p', `${task.description ?? task.title}\n\nRetorne o resultado completo.`,
          '--output-format', 'json', '--dangerously-skip-permissions',
        ], { cwd: '/config/workspace' })

        const timeoutP = new Promise((_, reject) =>
          setTimeout(() => { proc.kill(); reject(new Error('task timeout')) }, TASK_TIMEOUT_MS)
        )
        const result = await Promise.race([proc, timeoutP])
        const parsed = JSON.parse(result.stdout)
        completeTask(task.id, (parsed.result ?? parsed.content ?? '').trim())
        logger.info({ taskId: task.id }, 'task concluída')
      } catch (err) {
        failTask(task.id, err.message)
        logger.error({ err, taskId: task.id }, 'task falhou')
      }
      currentTaskId = null
    }
  } finally {
    clearInterval(hbTimer)
    logger.info({ boardId, workerId }, 'worker encerrado')
  }
}
