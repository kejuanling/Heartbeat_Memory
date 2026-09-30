// PM2 ecosystem 配置。现役只跑 gateway。
// 历史：wake-up 独立进程已于 2026-09-15 退役（调度并入 gateway、wake_up.js 已删除、pm2 delete 已执行），
// 其应用块曾一直遗留（整体 pm2 start 会因脚本不存在报错），2026-09-30 q5 清理项移除。
// 现网进程表仍以 pm2 save 的 dump 为准，本文件只在整体拉起/恢复时使用。
module.exports = {
  apps: [
    {
      name: "gateway",
      script: "server.js",
      cwd: "/opt/dylan-heartbeat",
      interpreter: "node",
      autorestart: true,
      max_memory_restart: "900M"
    }
  ]
};
