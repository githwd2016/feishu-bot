module.exports = {
  apps: [{
    name: 'feishu-gitcode-review-bot',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    time: true,
  }],
};
