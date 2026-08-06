// PM2 ecosystem 配置：gateway 保持本地嵌入模型；wake-up 禁用嵌入模型以节省内存（唤醒检索退化为关键词+随机记忆）
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
