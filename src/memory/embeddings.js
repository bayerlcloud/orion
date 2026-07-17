let _pipeline = null
let _loading = false
const _queue = []

// Lazy load — só baixa o modelo na primeira vez que precisar
async function getPipeline() {
  if (_pipeline) return _pipeline
  if (_loading) return new Promise((resolve) => _queue.push(resolve))

  _loading = true
  try {
    const { pipeline, env } = await import('@xenova/transformers')
    // Cache local para não re-baixar
    env.cacheDir = '/config/workspace/orion/data/models'
    env.allowRemoteModels = true
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    _queue.forEach(resolve => resolve(_pipeline))
    _queue.length = 0
    console.log('[embeddings] modelo carregado')
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
    return Array.from(output.data)  // float32[] com 384 dimensões
  } catch (err) {
    console.error('[embeddings] erro ao gerar embedding:', err.message)
    return null
  }
}

export async function warmup() {
  try {
    await generateEmbedding('warmup')
    console.log('[embeddings] warmup concluído')
  } catch {}
}
