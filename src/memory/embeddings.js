let _pipeline = null
let _loading = false
const _queue = []

async function getPipeline() {
  if (_pipeline) return _pipeline
  if (_loading) return new Promise((resolve) => _queue.push(resolve))
  _loading = true
  try {
    const { pipeline, env } = await import('@xenova/transformers')
    env.cacheDir = process.env.MODELS_CACHE_DIR || './data/models'
    env.allowRemoteModels = true
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    _queue.forEach(resolve => resolve(_pipeline))
    _queue.length = 0
    return _pipeline
  } catch (err) {
    _loading = false
    throw err
  }
}

export async function generateEmbedding(text) {
  try {
    const pipe = await getPipeline()
    const output = await pipe(text.slice(0, 512), { pooling: 'mean', normalize: true })
    return Array.from(output.data)
  } catch (err) {
    console.error('[embeddings] erro:', err.message)
    return null
  }
}

export async function warmup() {
  try { await generateEmbedding('warmup') } catch {}
}
