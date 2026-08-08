# Dylan Heartbeat — AI 常驻运行时（Heartbeat Gateway）

一个给 AI 伴侣类应用（Kelivo）使用的常驻服务：维持长期对话上下文、自动唤醒、主动推送、记忆与自动摘要。

> 本项目从 [callie0313/dylan-heartbeat](https://github.com/callie0313/dylan-heartbeat) 分叉演进而来，去除了部署者的私有数据与私密称呼，可作为自部署模板使用。

---

## 它做什么

- **持续上下文**：网关保存完整时间线（`enhanced_messages.json`），对话记录不丢，重启后可恢复。
- **自动唤醒**：用户沉默超过阈值后，AI 自行决定是否主动联系，通过 Bark / ntfy 推送手机消息。
- **记忆系统**：从对话中提取 `<memory>` / `<pin>` 标签存入记忆池，支持语义检索 + 关键词检索，唤醒与对话时自动浮现相关记忆。
- **自动摘要**：沉默超过阈值自动生成第一人称回忆摘要，写入记忆池；可配置阈值与提示词。
- **管理台**：Web 管理页查看上下文 / 记忆 / 日志 / 日记，在线调整唤醒、摘要、记忆等全部参数。

## 架构

由 PM2 管理两个 Node.js 进程（`ecosystem.config.js`）：

| 进程 | 文件 | 职责 |
| --- | --- | --- |
| gateway | `server.js` | 接收 Kelivo 的 `/v1/chat/completions`，维护时间线，注入时间/记忆/永久上下文，转发上游模型，运行记忆与摘要引擎 |
| wake-up | `wake_up.js` | 按动态间隔（白天/夜间可分别配置）检查沉默时长，触发唤醒流程，调用上游模型决策，发送推送并记录唤醒事件 |

数据文件（均含隐私，已加入 `.gitignore`，不上传）：

| 文件 | 内容 |
| --- | --- |
| `enhanced_messages.json` | 完整对话时间线 |
| `data/memories.json` | 记忆池 |
| `data/state.json` | 摘要状态与待处理消息 |
| `data/pinned.json` | 永久注入上下文 |
| `diary/` | 自动日记（Markdown） |
| `.env` | 全部配置与密钥 |

## 快速开始

```bash
# Node.js >= 20
npm install
cp .env.example .env   # 然后编辑 .env
npm start              # 或 pm2 start ecosystem.config.js
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TARGET_API_URL` / `TARGET_API_KEY` / `MODEL_NAME` | 上游模型 API 地址、密钥与模型名 |
| `GATEWAY_API_KEY` | 开启公网 `/v1` 后 Kelivo 使用的网关密钥 |
| `ALLOW_PUBLIC_API` | `false`（默认）：`/v1` 仅内网/本机；`true`：公网可用，但必须携带网关密钥 |
| `INTERNAL_API_KEY` | 内部接口（`/internal/*`、`/test-bark`）鉴权密钥 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理台 HTTP Basic Auth |
| `PUSH_PROVIDER` | `bark` 或 `ntfy`；`BARK_KEY` / `NTFY_TOPIC` 等为对应渠道配置 |
| `USER_DISPLAY_NAME` / `AI_DISPLAY_NAME` | 用户与 AI 的显示称呼（代码默认 `用户` / `AI`） |
| `DIARY_ENABLED` / `DIARY_DIR` | 自动日记开关与目录 |
| `DAY_WAKE_AFTER_MINUTES` / `NIGHT_WAKE_AFTER_MINUTES` | 白天/夜间沉默多久后触发唤醒 |
| `DAY_CHECK_INTERVAL_MINUTES` / `NIGHT_CHECK_INTERVAL_MINUTES` | 唤醒检查间隔 |
| `WEATHER_ENABLED` / `WEATHER_LAT` / `WEATHER_LON` | 可选天气注入（open-meteo） |
| `MEMORY_COOLDOWN_MINUTES` | 记忆浮现冷静期 |
| `PORT` / `TIME_ZONE` | 监听端口与时区 |

完整清单见 `.env.example`。

## 安全模型

- 管理台：HTTP Basic Auth + 会话登录（登录后 30 天免登录），登录页 `/admin/mobile/login`（建议自行在前置层加 HTTPS）。
- 内部接口 `/internal/*`、`/test-bark`：必须携带 `INTERNAL_API_KEY`。
- 公网 `/v1/*`：`ALLOW_PUBLIC_API=true` 时要求 `GATEWAY_API_KEY`（`Authorization: Bearer` 或 `x-api-key`）。
- 反向代理场景：网关仅在直连来源为可信内网时才信任 `X-Real-IP` / `X-Forwarded-For`，公网请求不会被伪装成内网放行。
- 日志与前端均对密钥脱敏，不写入完整对话上下文。

## 管理台

访问管理台（`/admin` 会自动跳转到 `/admin/mobile`）可：

- 查看与搜索时间线上下文、记忆池、唤醒事件
- 查看/编辑唤醒提示词与摘要提示词
- 调整唤醒间隔、摘要阈值、记忆浮现参数
- 管理预设、日记、天气配置

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)（源代码可获取，非商业使用；商用请与原作者联系）。
