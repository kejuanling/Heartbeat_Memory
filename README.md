# Dylan Heartbeat — 个人 AI 心跳 / 陪伴系统

一个给 AI 伴侣应用（Kelivo）使用的常驻运行时：AI 不是被动等消息，而是自己"活"在服务器里——记住长期上下文、主动唤醒、主动推送、自动写日记、自动消化记忆。

> 本项目分叉自 [callie0313/dylan-heartbeat](https://github.com/callie0313/dylan-heartbeat)，保留了名字和"让 AI 主动找人类"的理念；实现层面已经过完全重构，与上游代码基本无关。

## 它做什么

- **持续上下文**：完整时间线（`enhanced_messages.json`）+ 会话级文件 + 摘要压缩，窗口滑出的内容可检索、可回看，重启不丢。
- **主动唤醒**：用户沉默超过阈值后，AI 自行决定是否主动联系，通过 Bark / ntfy 推送手机消息（唤醒调度在 gateway 进程内）。
- **记忆系统（V2）**：蒸馏 → 门卫 → 重跑 → 两块总结 → 相关注入，分级记忆 + 人工把关（详见下文）。
- **自动日记**：AI 在回复中写日记或调用写日记工具，落盘日记库并进时间线，不被压缩、可隐藏。
- **主题化前端**：单体 `chat.html`（内联 CSS/JS），多套主题（暖白 / 微信 / Claude 极简 / 黑夜 / CRT 等）。
- **管理台**：Web 管理页在线调整唤醒、摘要、记忆、主题、日记等全部参数。
- **MCP 工具集**：AI 可主动调用的一批工具——记忆检索、历史搜索、日记、经期、查岗、待办、留言等。

## 架构

| 进程 / 服务 | 位置 | 职责 |
| --- | --- | --- |
| gateway（pm2） | `server.js` | 网关主进程：`/v1` 聊天入口、SSE、时间线维护、唤醒调度（`lib/wake-scheduler.js` 在进程内）、记忆与摘要引擎 |
| embed-server（pm2） | — | bge-small-zh 文本向量服务，供记忆语义检索 / 相似分组 |
| email-mcp（pm2） | — | 邮件 MCP |
| MCP 工具服务 | `workspace/mcp-tools/tools_server.py`（:8771） | AI 侧工具：`memory_search` / `context_search` / `context_digest` / `diary_*` / `period_*` / `phone_state` / `todo_*` / `paper_*` 等 |
| 静态前端 | `workspace/chat.html` + nginx（:9002） | 聊天前端（单体，改前端即时生效） |

附属数据服务（按部署可选）：moments/todo（:8777）、phone-report（:8080）等。

## 记忆系统（V2）

一条记忆从产生到被用起来，走完整链路：

1. **蒸馏**（`memory-distill.js`）：从对话原文 + 日记线索提取候选记忆——分类（fact / rule / event）、打关键词、可选的氛围、标明来源（#msg_id）。
2. **门卫**（`judge-adapter.js`）：给候选打两个分——价值分（值不值得留）和时效分（会不会过时），各带一句话理由；**只打标不拍板**，低分也只是"交人工"，从不自动拒绝或合并。
3. **人工审批**：候选进管理台待审队列，approve 才入池。
4. **重跑**（`memory-backfill.js`）：存量记忆回锅——重分类、补关键词、补氛围、更新价值分；产出的标签再过一次门卫。
5. **两块总结**（`memory-summary.js`）：rule →"规矩"、fact →"理解"，汇总成两块常驻文本注入每次对话，造人设底色。
6. **相关注入**（`context-v2-builder.js`）：只捞 event，混合分 = 词面×0.5 + 语义×0.15，每轮最多 1 条，同会话来源的记忆不重复注入；纯算法、不调模型。
7. **检索工具**（`memory_search`）：AI 主动查记忆池，同款混合分，类不限制、最多 5 条；用完整一句话查询比短关键词更容易命中（带语义匹配）。

数据文件（均在 `.gitignore`，含隐私不上传）：

| 文件 | 内容 |
| --- | --- |
| `data/memory_v2.json` | 记忆池（active / 沉底 / 待审等状态） |
| `data/memory_review_queue.json` | 待审 / 已审队列 |
| `data/memory_v2_vectors.json` | 语义向量旁路缓存（删掉后自动补算） |
| `data/memory_v2_config.json` | 记忆系统配置（开关、权重、门槛、条数） |
| `data/memory_*_prompt.json` | 蒸馏 / 重跑 / 总结 / 门卫提示词（运行时实时读取） |

## 上下文与压缩

- 完整时间线 `enhanced_messages.json` + 会话级 `enhanced_messages_s_*.json`。
- 摘要压缩（`context-compactor.js`）：长对话压缩为摘要块（`context_compaction_*.json`），压缩摘要置于状态机摘要之前，前缀缓存命中率高。
- 历史回看：`context_search`（原文碎片）+ `context_digest`（AI 整理成连贯叙述，调模型）。

## 日记

- 写入两条路：AI 回复末尾写 `[DIARY]...[/DIARY]` 标签块，或调用 `write_diary` 工具。
- 落盘 `data/diary.json`；时间线追加一条 `kind:diary` 的隐藏 assistant 消息（前端显示时剥标签，history API 过滤）。
- 日记不被压缩、跨窗口按需注入；`hidden=true` 的日记等效删除，可恢复。

## 快速开始

```bash
# Node.js >= 20
npm install
cp .env.example .env   # 然后编辑 .env
pm2 start ecosystem.config.js
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
- 内部接口 `/internal/*`、`/test-bark`：必须携带 `INTERNAL_API_KEY`（未配置时 fail-closed 直接拒绝）。
- 公网 `/v1/*`：`ALLOW_PUBLIC_API=true` 时要求 `GATEWAY_API_KEY`（`Authorization: Bearer` 或 `x-api-key`）。
- 反向代理场景：网关仅在直连来源为可信内网时才信任 `X-Real-IP` / `X-Forwarded-For`，公网请求不会被伪装成内网放行。
- 日志与前端均对密钥脱敏，不写入完整对话上下文。

## 管理台

访问管理台（`/admin` 自动跳转 `/admin/mobile`）可：

- 查看与搜索时间线上下文、记忆池（含待审队列、卡片关键词/氛围）、唤醒事件
- 在线调整唤醒间隔、摘要阈值、记忆浮现参数（相关注入权重/门槛/条数/衰减）
- 管理预设、日记、天气配置、主题

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)（源代码可获取，非商业使用；商用请与原作者联系）。

---

## 命名考据

- Dylan：威尔士语 dy（巨大）+ llanw（潮汐），意为"大潮"。神话人物 Dylan ail Don，"浪之子"（《Mabinogi》第四支）：受洗触水即跃入海，取得海性，游如鱼。传说潮汐不息的拍打，是海在给孩子续心跳。
- 名字沿自分叉源头 callie0313/dylan-heartbeat，随机所得，含义为命运补齐。
- 本项目从"让 AI 主动找人类"的野心开始，目前由该野心持续执行中。

—— 名字是随手起的，含义是命运补的。
