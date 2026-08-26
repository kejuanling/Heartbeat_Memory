# ☁️ 云服务器目录与服务地图

> 最后核对: 2026-08-26 22:xx · Alibaba Cloud Linux 3 · 磁盘 15G/40G（38%）· 内存 1.8G（swap 3G）· 入口 Nginx :9001（HTTP）/ :9002（HTTPS）
> 本文档面向运维查障，不记录 PID（会变），以「端口 + 启动命令 + 管理方式」定位服务。
> 公网 IP 以云控制台为准（旧记录 120.76.99.224，全部外部访问经 Nginx :9001 / :9002）。
> ⚠️ **路径说明**：`/root/workspace` 是指向 `/opt/dylan-heartbeat/workspace` 的**软链**，下文 `/root/workspace` 与实际 `/opt/dylan-heartbeat/workspace` 等价。各 systemd/nginx 配置里仍写 `/root/workspace`，但实际内容在 `/opt/dylan-heartbeat/workspace`。

---

## 🚀 运维速查（最高频操作）

```bash
systemctl restart <服务名>             # 重启 systemd 服务（见下表 A 组）
journalctl -u <服务名> -n 80 --no-pager   # 查 systemd 服务日志
lsof -i :<端口> -P -n | grep LISTEN     # 按端口找 PID（⚠️ 别用 ss | grep ':3000'，3000 在 ss 里显示为 *:hbci）
nginx -t && systemctl reload nginx      # 改 nginx 配置后先 test 再 reload
pm2 list|restart|logs                   # PM2 管理 gateway / wake-up（在 PATH 上）
pm2 logs wake-up --lines 80 --nostream   # 唤醒系统 stdout
pm2 logs gateway --lines 80 --nostream   # 网关 stdout
crontab -l                              # 查看定时任务（当前仅 bark 推送调度 1 条）
```

**注意**：当前 PM2 二进制位于 `/opt/node/bin/pm2`（旧路径不在默认 PATH 需加 `export PATH=/opt/node/bin:$PATH`）；如果 `pm2` 命令直接用不了，请用绝对路径 `/opt/node/bin/pm2`。

**重启 Dylan**：⚠️ 目前 3000 由**独立进程** `node /opt/dylan-heartbeat/server.js` 提供，pm2 `gateway` 处于 stopped。因此**不要默认执行 `pm2 restart wake-up gateway --update-env`**——会因 3000 被独立进程占用而 EADDRINUSE。详见下方「D. 独立进程」3000 行的说明。

**管理台**：`http://<公网IP>:9001/heartbeat/admin/mobile`（或 HTTPS :9002 同路径）
- 登录账号见 `/opt/dylan-heartbeat/.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD`
- 登录后 30 天免登录；旧 `/system/` 面板已下线。

**共影播放页**：`co-view.html`（在 `/opt/dylan-heartbeat/workspace/`），走 Nginx :9001（HTTP）/ :9002（HTTPS），前端调用 `/co-api/` → 网关 internal 接口。

---

## 📋 服务总览（按管理方式分组）

### A. systemd 管理（enabled）

| systemd 名 | 端口 | 启动命令 / 入口 | 工作目录 | 说明 / 实际状态 |
|---|---|---|---|---|
| nginx | 9001 / 9002 | /usr/sbin/nginx | - | 反向代理总入口；9001 HTTP、9002 HTTPS（共影 ssl），运行中 |
| phone-api | 8080 | python3.8 -m gunicorn -w1 -b :8080 app:app | /root/phone-report-api | 电话数据 API（内存态，单进程），运行中 |
| mcp-tools | 8771 | python3 tools_server.py | /root/workspace/mcp-tools | MCP 工具集，运行中 |
| zzf-mcp | 8890 | python3 mcp_server.py（仅 127.0.0.1） | /root/zzf-mcp | ZuiQingFeng 远程玩具 MCP，nginx /mcp 代理，运行中 |
| unified-backend | 8777 | python3 unified_server.py | /root/workspace | 小世界统一后端（diary/月历/todo），✅ systemd 正常运行 |
| netease-music | 3303 | node src/http-server.js | /opt/netease-music-mcp | 网易云音乐 MCP，✅ 现由 systemd 管理（原独立进程） |
| yun-mcp-v2 | 9010 | python mcp_server.py | /opt/dylan-heartbeat/yun-mcp-v2 | AI 文件工具 MCP（Streamable HTTP），✅ 现由 systemd 管理 |

> 已停用：`mcp-ssh`（9000，disabled/inactive）、`daily-todo/daily-heart/daily-memory`（8768/8769/8770，旧 daily-涵 三服务已并入 8777）、`browser-mcp`（8772）、`bark-mcp`（8001）。

### B. systemd 单元存在但已禁用（旧服务，勿再启用）

| 单元 | 原端口 | 说明 |
|---|---|---|
| daily-todo / daily-heart / daily-memory | 8768 / 8769 / 8770 | Daily涵 独立三服务已停；todo/moments API 已并入 unified-backend（8777） |
| browser-mcp | 8772 | Playwright 浏览器 MCP 已停 |
| bark-mcp | 8001 | bark_tasks 的 HTTP 服务已停（cron 仍每分钟跑 send_now.py） |
| mcp-ssh | 9000 | SSH MCP 已禁用（见 A 组说明） |

### C. PM2 管理（pm2，开机自启）

| PM2 name | 端口 | 入口脚本 | 工作目录 | 说明 | 日志 |
|---|---|---|---|---|---|
| gateway | 3000 | server.js | /opt/dylan-heartbeat | Dylan 网关：/v1 LLM 代理 + 时间线 + 记忆/摘要引擎 + 管理台 API + 共影/截图 internal 接口 | /root/.pm2/logs/gateway-*.log |
| wake-up | - | wake_up.js | /opt/dylan-heartbeat | 唤醒系统：沉默检测 + 天气 + 记忆检索 + Bark/ntfy 推送 | /root/.pm2/logs/wake-up-*.log |

> ⚠️ **gateway 当前为 stopped**（端口 3000 被独立进程 `node /opt/dylan-heartbeat/server.js` 占用，见 D 组）。wake-up 正常 online。PM2 的 gateway 与独立进程跑的是**同一份** server.js，但只有独立进程在真正服务 3000。

### D. 独立进程（重启会丢，多数带 bash 自愈包装脚本或 nohup）

| 端口 | 进程 | 目录 | 说明 |
|---|---|---|---|
| 3000 | `node /opt/dylan-heartbeat/server.js` | /opt/dylan-heartbeat | ⚠️ **网关主进程**：当前由独立 node 提供（非 pm2 gateway）。若想交回 pm2，先 `kill` 此进程再 `pm2 restart gateway`；否则改动已由它加载/生效 |
| 5000 | python3 email_server.py | /opt/dylan-heartbeat/workspace | 邮件通知服务（email_server.py），独立运行 |
| 8773 | node mcp-server.js | /root/spicy-monopoly | 涩涩大富翁 MCP，Bearer Token 鉴权（nohup 拉起）。**当前未监听** |
| 8787 | node server.mjs | /root/workspace/decision-trail | 决策痕迹 MCP（bash 包装脚本守护）。**当前未监听** |
| 8790 | python3 app.py | /root/workspace/ocr-api | 真正的 OCR API（独立 nohup；nginx /ocr-api/ → 8790） |
| 8084 | python3.11 /opt/http_api.py | /opt | 电话数据 FastAPI（独立，非 systemd，sqlite 在 /opt/phone_data） |

> ⚠️ **8773 / 8787 当前未监听**。若需使用，按原启动命令手动拉起（spicy-monopoly: `node mcp-server.js`；decision-trail: `node server.mjs`）。8707 端口现由 `python3 /opt/http_api.py` 提供。9010/3303 已改为 systemd（见 A 组）。

---

## 🔌 端口监听速查（2026-08-26 实测）

| 端口 | 服务 | 管理方式 |
|---|---|---|
| 22 | sshd | systemd: sshd |
| 3000 | dylan-heartbeat server.js（网关主进程） | ⚠️ 独立 node（非 pm2 gateway） |
| 3303 | netease-music-mcp | systemd: netease-music |
| 5000 | email_server.py | 独立 python |
| 8080 | phone-report-api（gunicorn） | systemd: phone-api |
| 8084 | /opt/http_api.py | 独立 python |
| 8771 | mcp-tools（tools_server.py） | systemd: mcp-tools |
| 8777 | unified_server.py | systemd: unified-backend |
| 8790 | ocr-api app.py | 独立 python（nohup） |
| 8890 | zzf-mcp（仅 127.0.0.1） | systemd: zzf-mcp |
| 9001 | nginx HTTP（唯一对外 HTTP 入口） | systemd: nginx |
| 9002 | nginx HTTPS ssl（共影 + 对外 HTTPS 入口） | systemd: nginx |
| 9010 | yun-mcp-v2 | systemd: yun-mcp-v2 |

**未监听（文档曾记录但现未运行）**：8773（spicy-monopoly）、8787（decision-trail）、9000（mcp-ssh）、8000/8765（Ombre-Brain）、8001（bark HTTP）、8097（reading-nook）、8764（问卷）、8768/8769/8770（daily-涵 三服务）、8772（browser-env）、8088（静态）。

---

## 🌐 Nginx 路由表（:9001 root=/root/workspace；:9002 HTTPS 含共影 ssl）

| 路径 | 去向 | 说明 |
|---|---|---|
| / | 静态 index.html | 首页（/root/workspace/index.html） |
| /diary/ /diary/api/ | 127.0.0.1:8777 | 日记（unified-backend） |
| /heart /heart/ | alias /root/workspace/daily-涵/ | 心动时刻独立路径（原 /todo/heart.html） |
| /todo/ /todo/api/ | alias /root/workspace/daily-涵/ 静态 + API → 8777 | 待办/心动页 + 后端 |
| /todo/api/memories | 404 | 记忆桶显式禁用 |
| /notes/ /notes/api/ | 404 | 谢的日记已删除 |
| /monthly/ /monthly/api/ | 127.0.0.1:8777 | 月历/记账 |
| /ocr-api/ | 127.0.0.1:8790/ | 真正的 OCR API（直连 8790） |
| /decision-trail/ | 127.0.0.1:8787/ | 决策痕迹（⚠️ 后端当前未监听，访问会 502） |
| /system/ | alias /root/workspace/system/ | 系统面板（静态 alias 页） |
| /admin | 127.0.0.1:3000 | 管理台（admin 前缀，门户跳转+登录后重定向） |
| /heartbeat/ | 127.0.0.1:3000/ | Dylan 网关 + 管理台（rewrite 去掉前缀） |
| /co-api/ | 127.0.0.1:3000/internal/co/ | 共影聊天/唤醒 API 代理（read/send 超时 180s） |
| /screenshot-api/ | 127.0.0.1:3000/internal/screenshot/ | 截图唤醒 API（key 由 nginx 注入，从 conf.d/screenshot-key.conf） |
| /mcp | 127.0.0.1:8890 | zzf-mcp（streamable-http，读超时 120s） |

> 注：9002（HTTPS server 块）路由与 9001 基本一致，并额外提供共影 ssl（证书 /etc/nginx/ssl/co-view.crt）。9002 不含 /screenshot-api/（仅 9001 配置该 location）。

---

## 🗂️ Dylan Heartbeat 管理台与内部接口（/heartbeat/ → 127.0.0.1:3000，共影 /co-api/ & /screenshot-api/ 同样落于此）

管理台入口：`/heartbeat/admin/mobile`（GET /admin 自动 302 到 /admin/mobile）。鉴权：会话登录（30 天）或 HTTP Basic。

| Method | Path | 说明 | Auth |
|---|---|---|---|
| GET | /admin/env | 状态卡 + 非敏感 env（密钥只回传是否已配置） | ✅ 会话/Basic |
| POST | /admin/save | 保存 .env 键（热生效，无需重启） | ✅ 会话/Basic |
| GET/POST | /admin/config | 读/写 data/config.json（记忆/摘要/唤醒参数，热生效） | ✅ 会话/Basic |
| GET | /admin/mobile | 管理台页面 | ✅ 会话 |
| POST | /admin/restart | 执行 RESTART_COMMAND | ✅ 会话/Basic |
| GET | /admin/logs/wake-up | 唤醒原始日志纯文本 | ✅ 会话/Basic |
| GET/POST/PUT/DELETE | /admin/logs/pinned | 永久注入上下文增删改 | ✅ 会话/Basic |
| GET/POST/DELETE | /admin/logs/summary-prompt · /admin/logs/wake-prompt | 摘要/唤醒提示词 | ✅ 会话/Basic |
| GET/POST | /admin/memories 系列 · /admin/stats · /admin/summary/* | 记忆管理/统计/摘要 | ✅ 会话/Basic |
| POST | /internal/co/chat | 共影聊天（user 消息+可选画面 → AI 回复，写入时间线共影记录） | 🔑 内部 |
| POST | /internal/co/wake | 共影观影唤醒（定时/手动 👁，画面→AI 决定说不说） | 🔑 内部 |
| POST | /internal/co/describe 等 | 共影画面描述 internal 接口 | 🔑 内部 |
| POST | /internal/screenshot/wake | 截图唤醒（图片→视觉解析→写时间线→可选推送） | 🔑 内部 |
| POST | /internal/*（wake-event、heartbeat、memory/search 等） | 其余内部接口，需 x-internal-key=INTERNAL_API_KEY | 🔑 内部 |

**生效方式速记**：
- 「管理台 → 配置」区（data/config.json）：热生效（唤醒侧每次检查前重新读取）
- 「管理台 → 环境变量」区（.env）：热生效（wake-up 每轮检查前重读，gateway 请求时重读）
- 时区/端口等不在管理台的项仍以重启为准

---

## 💾 数据文件位置

| 服务 | 文件/目录 | 说明 |
|---|---|---|
| unified-backend | /root/workspace/diary/diary.json | 日记数据 |
| unified-backend | /root/workspace/monthly/data.json | 月历/记账 |
| unified-backend | /root/workspace/daily-涵/* | 待办/心动（todo 数据，后端并入 8777） |
| gateway/wake-up | /opt/dylan-heartbeat/enhanced_messages.json | 完整对话时间线（含普通对话 + 特殊事件 + 共影记录） |
| gateway/wake-up | /opt/dylan-heartbeat/data/config.json | 记忆/摘要/唤醒参数（管理台「配置」区，热生效） |
| gateway/wake-up | /opt/dylan-heartbeat/data/memories.json | 记忆池 |
| gateway/wake-up | /opt/dylan-heartbeat/data/memory_pool.json | 记忆池（memory-pool.js 用） |
| gateway/wake-up | /opt/dylan-heartbeat/data/pinned.json | 永久注入上下文 |
| gateway/wake-up | /opt/dylan-heartbeat/data/state.json | 摘要状态与待处理消息 |
| gateway/wake-up | /opt/dylan-heartbeat/data/summary_prompt.json | 摘要提示词配置 |
| gateway/wake-up | /opt/dylan-heartbeat/data/_fix_backup_* / _unify_backup_* | 数据修复/合并前的备份目录 |
| gateway/wake-up | /opt/dylan-heartbeat/wake_prompt.txt | 唤醒提示词模板 |
| gateway/wake-up | /opt/dylan-heartbeat/diary/ | 自动日记（Markdown） |
| email_server | /opt/dylan-heartbeat/workspace/email_server.py | 邮件通知服务（5000） |
| phone-api | /root/phone-report-api（8080）· /opt/phone_data（8084 sqlite） | 电话数据 |
| bark_tasks | /root/bark_tasks/log.txt | 推送调度日志 |
| nginx | /etc/nginx/ssl/co-view.crt / co-view.key | 共影 HTTPS 证书 |
| nginx | /etc/nginx/conf.d/screenshot-key.conf | 截图接口注入的 key |

---

## ⏰ 定时任务（crontab -l，2026-08-26）

| 周期 | 命令 | 说明 |
|---|---|---|
| 每分钟 | cd /root/bark_tasks && python3 send_now.py >> /root/bark_tasks/log.txt 2>&1 | Bark 推送调度（HTTP 服务 8001 未运行，cron 仍每分钟执行脚本） |
| 每日另设 | 见 `crontab -l` 实际（可能含唤醒/推送等） | 以现行 crontab 为准 |

> 旧 `daily_archive.py` 归档任务已注释（脚本不存在）。

---

## 📁 目录结构

### /root 顶层
| 目录 | 用途 |
|---|---|
| workspace | 指向 `/opt/dylan-heartbeat/workspace` 的**软链**（小世界主目录：首页 + 统一后端 + 多个子项目 + co-view.html 共影播放页） |
| yun-mcp-v2 | 旧独立（现 systemd 9010，实际在 /opt/dylan-heartbeat/yun-mcp-v2） |
| zzf-mcp | ZuiQingFeng 远程玩具 MCP（systemd，8890） |
| bark_tasks | Bark 推送调度（cron 每分钟） |
| spicy-monopoly | 涩涩大富翁 MCP（8773，当前未监听） |
| phone-report-api | 电话数据 API 源码（systemd 8080） |
| browser-env | Playwright 浏览器 MCP（已停用） |
| static-pages | 静态小页面（diary/sea/finger/drawer 等） |
| like-repo | 备份镜像（如 system/index.html 跳转页副本） |
| diary / archive | 旧日记 / 旧归档 |
| mcp_env | MCP 专用 Python venv（yun-mcp-v2 / 旧 mcp-ssh 用） |

### /opt
| 目录 | 用途 |
|---|---|
| dylan-heartbeat | Dylan 网关 + 唤醒系统（PM2 gateway/wake-up + 独立 gateway 进程），全部数据在此 |
| dylan-heartbeat/workspace | ⭐ 小世界实际目录（/root/workspace 软链指向这）：mcp-tools/decision-trail/ocr-api/daily-涵/diary/monthly/system/co-view.html/unified_server.py/email_server.py |
| dylan-heartbeat/yun-mcp-v2 | yun-mcp-v2 MCP（systemd 9010） |
| netease-music-mcp | 网易云音乐 MCP（systemd 3303） |
| node | Node.js 发行版（pm2 在 /opt/node/bin/pm2） |
| http_api.py | 电话数据 FastAPI（独立，8084） |
| phone_data | 电话数据（sqlite，8084 使用） |
| app_tracker_mcp.py | 应用跟踪 MCP（存在但未运行） |
| *.log（dylan-heartbeat.log 等） | 历史进程日志 |

### /opt/dylan-heartbeat/workspace 子目录
`index.html`（首页）、`unified_server.py`（统一后端：diary/goban/notes/monthly/todo，systemd 8777）、`co-view.html`（共影播放页）、`email_server.py`（5000）、`daily-涵`（旧三服务源码 + 静态页 + heart.html，服务已停但静态页面仍在）、`mcp-tools`、`decision-trail`、`ocr-api`、`memories`、`monthly`、`diary`、`system`（下线面板）、`_archive`

### 身份文档（/opt/dylan-heartbeat/*.md）
`AGENTS.md` `BOOTSTRAP.md` `HEARTBEAT.md` `IDENTITY.md` `SOUL.md` `TOOLS.md` `USER.md` `SERVER_DIRECTORY_MAP.md`（本文档）`WORKLOG_20260803.md` `云服务器MCP工具使用经验.md` `心跳唤醒管理台-功能全解析.md` `踩坑经验.md`(已并入经验文档)`记忆池整理功能策划书.md`

---

## ⚠️ 已知配置注意点（运维时留意）

1. **PM2 路径**：旧版 /opt/node/bin/pm2 不在默认 PATH；若 `pm2` 不可用，用绝对路径 `/opt/node/bin/pm2` 或 `export PATH=/opt/node/bin:$PATH`。
2. **3000 双跑冲突**：当前 3000 由独立 `node /opt/dylan-heartbeat/server.js` 提供，pm2 `gateway` 是 stopped。二者是同一份 server.js，但只有独立进程在服务。**勿直接 `pm2 restart gateway`**（会 EADDRINUSE）；要交回 pm2 先 `kill` 独立进程。
3. **mcp-ssh 已停**：systemd 单元 disabled / inactive，9000 未监听；如恢复需重新 enable 手动脚本。
4. **共影 & 截图接口**：/co-api/ 与 /screenshot-api/ 均落到 3000；screenshot 的 key 由 nginx 从 conf.d/screenshot-key.conf 注入（快捷指令无需处理 key）；共影播放页需 HTTPS（9002）下截图功能才可用（getDisplayMedia 要求安全上下文）。
5. **OCR 端口已修正**：nginx /ocr-api/ 现在直连 8790（真实 OCR 服务），不再是 8771。
6. **phone-api 双端口**：8080 为 systemd gunicorn（phone-report-api，内存态）；8084 为 /opt/http_api.py 独立 FastAPI（sqlite，重启会丢）。
7. **9002 HTTPS**：共影 ssl 证书 /etc/nginx/ssl/co-view.*；该 server 块不含 /screenshot-api/ 代理。
8. **dylan-heartbeat 数据文件集中在 /opt/dylan-heartbeat/**：含 data/ 子目录；/root/ 下同名 JSON 为旧副本，不再使用。备份目录 data/_fix_backup_*、_unify_backup_* 为历史修复备份，可清理。
9. **RESTART_COMMAND**：原为 `pm2 restart wake-up gateway --update-env`。⚠️ 因当前 gateway 由独立进程服务，执行前先核实是否真的需要重启 gateway（见第 2 点）。
10. **管理台配置生效方式**：配置区（config.json）与环境变量区（.env）均热生效；仅时区/端口等非管理台项以重启为准。
11. **安全**：gateway 3000 的 /v1 公网访问由 `ALLOW_PUBLIC_API` + `GATEWAY_API_KEY` 控制；8773 spicy-monopoly 需 Bearer Token；8771/8777 内部接口需 `INTERNAL_API_KEY`；8890 仅绑定 127.0.0.1。
12. **docker/containerd 已安装但无运行容器**；需要时再启。
13. **独立进程无开机自启**：8790/8084/5000 重启后需按上表命令手动拉起（部分有 bash 自愈包装脚本）。8773/8787 当前未监听，需用则手动拉起。
