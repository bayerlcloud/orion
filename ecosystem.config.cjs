module.exports = {
  apps: [{
    name: 'orion',
    script: 'src/server.js',
    cwd: '/config/workspace/orion',
    interpreter: 'node',
    max_memory_restart: '1500M',
    env: {
      HOME: '/config',
      PATH: '/config/.local/node/bin:/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'production'
    }
  }]
}
