// PM2 ecosystem 配置。现役只跑 gateway；wake-up 独立进程已于 2026-09-15 退役（调度并入 gateway、
// wake_up.js 已删除、pm2 delete 已执行），下方 wake-up 应用块为退役遗留——用本文件整体 start 会因
// 脚本不存在报错，条目清理待拍板（现网进程表以 pm2 save 的 dump 为准）。
module.exports = {
  apps: [
    {
      name: "gateway",
      script: "server.js",
      cwd: "/opt/dylan-heartbeat",
      interpreter: "node",
      autorestart: true,
      max_memory_restart: "900M"
    },
    {
      // 退役遗留（2026-09-15 wake-up 并入 gateway）：勿再启动，见头部说明
      name: "wake-up",
      script: "wake_up.js",
      cwd: "/opt/dylan-heartbeat",
      interpreter: "node",
      autorestart: true,
      max_memory_restart: "400M",
      env: {
        EMBEDDING_MODE: "disabled",
        // 只读模式：wake-up 不落盘记忆/状态，避免与 gateway 双写互相覆盖
        MEMORY_ENGINE_READONLY: "1"
      }
    }
  ]
};
