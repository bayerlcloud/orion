module.exports = {
  apps: [{
    name: 'orion',
    script: 'src/server.js',
    cwd: '/config/workspace/orion',
    interpreter: 'node',
    // uid/gid removidos: o daemon do pm2 já roda como 'abc', então herda sozinho.
    // Mantê-los quebrava o `pm2 startOrReload` ("--uid requer root") impedindo
    // atualizar o max_memory_restart. (se um dia recarregar como root, readicionar.)
    // 600M era baixo demais: o processo carrega o modelo MiniLM (~400MB) + indexa
    // sessões grandes e passava de 600MB sob carga → pm2 reiniciava limpo (exit 0)
    // a cada ~20-60s, MATANDO os timers setTimeout dos crons one-shot. 1.5GB dá folga.
    max_memory_restart: '1500M',
    env: {
      HOME: '/config',
      PATH: '/config/.local/node/bin:/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'production'
    }
  }]
}
