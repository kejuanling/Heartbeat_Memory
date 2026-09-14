# 本地 Agent 工作方法（连接 · 命令 · 技术红线）

> **前置阅读**：执行任何操作前，请确保已通读 `01_全局操作规范.md` 和本文件 `02_本地Agent工作方法.md`（二者为必读层）。本文件仅提供具体命令和操作手法，不重复安全与确认流程。
>
> **本文件是操作手册 + 所有技术命令类踩坑的唯一归宿**。  
> 连接参数、常用命令、验证手法、以及所有与 Shell/编码/MCP 解析相关的坑，全部在此。

## 1. 连接参数（已验证可用）

| 项 | 值 |
|---|---|
| 服务器 | `120.76.99.224` |
| 登录用户 | `root`（免密） |
| 密钥 | `C:\Users\恪眷泠\.ssh\id_rsa` |
| 项目目录 | `/opt/dylan-heartbeat` |
| 本地镜像 | `C:\deepseek\cloud`（不含密钥/大块） |

## 2. 操作方式（优先级）

**重要区分**：`03_系统介绍.md` 中“接入方式”描述的主方案“SSH + 本地镜像”，是针对**人类管理员接入和故障排查**的入口描述。本文档面向 **Agent 自动化操作**，按以下优先级选择工具：

1. **优先用 yun MCP 工具（`mcp__yun__*`）**：`read_file` / `write_file` / `search_text` / `run_command` / `list_dir` 等，直接作用于 `/opt/dylan-heartbeat`，比 ssh/scp 更稳、无需交互，适合自动化读写和命令执行。
2. **备选：ssh / scp 直连**（命令见下）：当 MCP 工具不可用（如服务重启、网络抖动）或需要交互式调试（如 `pm2 logs` 实时跟看、`node --inspect`）时回退。
3. DSH MCP 配置在本地 `C:\Users\恪眷泠\.dsh\profiles\web\cordis.patch.yml`。

## 3. 环境状态自检（每次开工必做）
```powershell
# 看服务真实运行状态（别信文档）
ssh -i $key root@120.76.99.224 "pm2 list"
ssh -i $key root@120.76.99.224 "systemctl list-units --type=service | grep -E 'unified|mcp|daily|phone'"
```
## 4. 最常用命令
```powershell
$key = "$env:USERPROFILE\.ssh\id_rsa"
# 跑服务器命令
ssh -i $key root@120.76.99.224 "cd /opt/dylan-heartbeat && pm2 list"
# 拉文件
scp -i $key root@120.76.99.224:/opt/dylan-heartbeat/server.js C:\deepseek\cloud\server.js
# 推文件
scp -i $key C:\deepseek\cloud\server.js root@120.76.99.224:/opt/dylan-heartbeat/server.js
```
## 5. 验证手法（改完必验）
- 改 JS：推前本地 `node --check`，推完服务器上再 `node --check`；`pm2 restart gateway --update-env`，sleep 4，`pm2 list | grep gateway`，`pm2 logs gateway --lines 12 --nostream`（2026-09-15 起 wake-up 进程已退役，唤醒调度在 gateway 内，重启 gateway 即全部生效）
- 改 Python：`python3 -m py_compile file.py`
- 改 nginx：`/usr/sbin/nginx -t` → `systemctl reload nginx`
- 验管理台接口：`curl -u <ADMIN_USER>:<密码> http://127.0.0.1:3000/admin/...`（用户名/密码都从 `.env` 读；**用户名不是 admin**，是 .env 里的 3 位字符）
- git 提交：`git add` 只加具体文件，绝不 `git add -A`（仓库含敏感文件）

## 6. 红线与坑（技术命令/环境类，干活前扫一眼）

### 6.1 推送与重启
- 改 `chat.html` 等静态前端不用 pm2 restart（nginx 静态直出，scp 即生效）。
- 改业务代码（`server.js`/`lib/wake-scheduler.js` 等）务必 `pm2 restart gateway --update-env`，否则不生效（唤醒调度器同在 gateway 进程内）。
- `cloud-push.ps1` 中文注释在本机 PowerShell 会因编码报错：别依赖它，改用 `scp -i $key` 单文件直推最稳。
- **踩坑（2026-09-04 实测）**：`scp -i $key 多文件... root@host:/opt/dylan-heartbeat/` 批量推送时，含子目录路径的源文件（如 `routes/chat.js`）会被**静默跳过**（退出码 0、无报错，其余文件正常），导致线上与本地不一致、改了半天不生效。强制做法：**每个文件单独 scp 一条命令**，推完立即 `md5sum <远端文件>` 与本地 `Get-FileHash -Algorithm MD5` 逐一对齐，不一致就是没推上。
- **每日记录同步**：`agent每日工作记录\` 本地与服务器 `/opt/dylan-heartbeat/agent每日工作记录\`（与 `工作流\` 同级）**双向同步**——本地写完推服务器、服务器有新内容拉回本地；一律**单文件 `scp` + `md5sum` 复核**（遵守上面「每文件单独 scp」原则），含中文文件名可用 tar 打包规避编码/引号坑。

### 6.2 Shell / 引号 / 编码
- 远端 shell 用单引号包整条命令：`ssh host 'cmd'`，避免本地先解析 `$(...)/引号` 导致 unexpected EOF。
- `ssh host "..."`（外层用双引号）时，命令内容里的 `$(date +%s)` 等会被本机 PowerShell 先求值——轻则备份名时间戳被吞/报 `Get-Date` 错，重则命令变形。要带时间戳的备份名，最稳是写脚本 → scp 到 `/tmp` → `ssh host 'bash /tmp/x.sh'` 执行，别在双引号 ssh 命令里拼 `$(...)`。
- PowerShell 内嵌 python 引号坑：`ssh host "python3 -c \"...encoding='utf-8'...\""` 会被本地 PowerShell 先解析 '/"/$()，报 ParserError。最稳做法：把命令写成本地 `.sh` → scp 上传到 `/tmp` → `ssh host 'bash /tmp/xxx.sh'`，绕开本地引号解析。
- 凡是在远端传带空格/特殊字符的参数（header、中文、json），直接走脚本文件，别在命令行拼。
- 别用 PowerShell `Get-Content` 读 UTF-8 中文（默认 GBK 乱码）；看中文用 read 工具。
- 远端跑多行 JS（`ssh host "node -e '...'"`）：引号/`$(...`/换行极易被本地先解析报 `unexpected token`。最稳做法：脚本里用 `cat > /tmp/x.js <<'EOF'` heredoc 落盘 → `node --check /tmp/x.js && node /tmp/x.js` → 删文件，绕开一切引号转义；且先 `node --check` 再执行，避免写库失败。
- 内部接口鉴权不确定时先实测再批量写库：`/v1/upload-image` 等走全局 addHook 要 `Authorization: Bearer <api_key>`（`chat-settings.json` 里的 key 即可用），无鉴权/带错头会 401。批量脚本先小样本验通道，成功再全量。
- Git Bash scp/ssh 首连报 `Host key verification failed`：加 `-o StrictHostKeyChecking=accept-new`（中文用户名导致 known_hosts 写不进，每次都会刷警告但不影响传输）。
- Git Bash 里连接密钥路径务必写字面值 `-i "C:/Users/恪眷泠/.ssh/id_rsa"`；别用 PowerShell 的 `$env:USERPROFILE` 语法（在 bash 下会展开成 `:USERPROFILE\.ssh\id_rsa` 导致找不到密钥、Permission denied）。

### 6.3 MCP / 工具解析
- MCP（streamable-http）响应常是 SSE 而非纯 JSON：`tools/list` 返回 `event: message\ndata: {json}`，直接 `json.loads(raw)` 会报错。解析时逐行找 `data:` 前缀、取其后 JSON（多条时取最后一条 data），且 `result.content[].text` 常是嵌套的 JSON 字符串，要二次 `json.loads`。
- ESM 项目本地 `node --check` 误报：有 `.js`（含 import）的项目若本地目录没有 `package.json` 的 `"type":"module"`，本地 `node --check` 会报 `Cannot use import statement outside a module`——不是代码语法错。推到远端（项目本身 ESM）后再 `node --check`，或本地临时以 `.mjs` 校验。

### 6.4 文件与目录
- 镜像不是唯一真相，以服务器为准：改→推回→pm2 restart。
- 编辑前 `cp file file.bak-$(date +%s)`（`.bak*` 被 gitignore）。
- 大文件：用 `sed -n 1,200p` 分段看，别整个 cat。