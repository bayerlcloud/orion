import { createBoard, getBoard, addTask, getBoardStatus, getBoardTasks } from './store.js'
import { runWorker } from './worker.js'
import { createLogger } from '../logger.js'
const logger = createLogger('kanban')

export { createBoard, getBoard, addTask, getBoardStatus, getBoardTasks }

export async function dispatch(boardName, workerCount = 3) {
  const board = getBoard(boardName)
  if (!board) throw new Error(`Board "${boardName}" não encontrado`)
  const workers = Array.from({ length: workerCount }, (_, i) => `worker-${Date.now()}-${i}`)
  logger.info({ boardName, workerCount }, 'despachando workers')
  Promise.allSettled(workers.map(id => runWorker(board.id, id)))
    .then(() => logger.info({ boardName }, 'todos os workers finalizaram'))
  return { board: board.name, workers: workers.length, status: 'dispatched' }
}
