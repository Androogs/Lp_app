// PM2 (solo para VPS): pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'licores-palmira',
    script: 'server/index.js',
    cwd: __dirname,
    node_args: '--disable-warning=ExperimentalWarning',
    instances: 1,            // SQLite: una sola instancia (no usar modo cluster)
    exec_mode: 'fork',
    max_memory_restart: '400M',
    env: { NODE_ENV: 'production' },
    time: true,
  }],
};
