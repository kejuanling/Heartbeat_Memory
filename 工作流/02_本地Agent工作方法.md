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

> **文档真源（2026-10-03 用户拍板）**：`工作流/01·02·03·05` **服务器为真源，本地为只读副本**。
> 本地 `C:\deepseek\工作流\` 下的同名文件只供阅读，**不得在本地修改**；要改就按本文 scp 手法改服务器那份——
> 拉取→临时副本编辑→**推送前重拉核对 md5**→`scp -O` 推回→`md5sum` 复核→再拷回本地覆盖。
> 这四个文件在服务器上已被 git 跟踪，改完单独 `git add` 提交（**勿 `-A`**）。`agent每日工作记录/` 同规则（2026-09-28 起只存服务器）。

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
- 改 `.env` 序列化/转义（server.js `serializeEnvValue`）时**必须用真 dotenv 做「写入→回读」往返验证**，别靠推理：实测 dotenv 17.4.2 的规则是「成对引号会被去掉；**只有双引号值**才还原 `\n`/`\r`，`\"` 与 `\\` **一律不还原**」——所以「转义引号」写法无效，含 `#` 的值只有加引号包裹才不被当行内注释截断（**单引号最优：不做任何还原**，故优先单引号、值含单引号时退回双引号）。验证方式：脚本里 `require('<项目>/node_modules/dotenv').parse('KEY=' + serializeEnvValue(v)).KEY === v` 逐例比对（把实现与测试放在同一脚本里跑，避免两边漂移）。（2026-09-22 E4 实证：首轮实现误以为 `\"` 可还原而失败，第二轮改「单引号优先」后 12/14 通过）

## 6. 红线与坑（技术命令/环境类，干活前扫一眼）

### 6.1 推送与重启
- 改 `chat.html` 等静态前端不用 pm2 restart（nginx 静态直出，scp 即生效）。
- 改业务代码（`server.js`/`lib/wake-scheduler.js` 等）务必 `pm2 restart gateway --update-env`，否则不生效（唤醒调度器同在 gateway 进程内）。
- **踩坑（2026-09-22 实测）**：scp 现代客户端默认走 **sftp 子模式**，本服务器环境会握手后被断连（连续 `scp: Connection closed`，而 `ssh` 同步正常）；加 **`-O`** 回退传统 scp 协议即恢复。批量循环推送时若首条失败，先手动验一条 `-O` 再继续，别误判成服务器故障。
- 原 `cloud-push.ps1` 因中文注释在本机 PowerShell 编码报错且已被取代，2026-09-21 清理删除：推文件一律改用 `scp -i $key` 单文件直推最稳。拉取全量镜像用 `cloud-sync.ps1`（依赖同目录 `unpack_tree.py`，排除清单见脚本内）。
- **踩坑（2026-09-04 实测）**：`scp -i $key 多文件... root@host:/opt/dylan-heartbeat/` 批量推送时，含子目录路径的源文件（如 `routes/chat.js`）会被**静默跳过**（退出码 0、无报错，其余文件正常），导致线上与本地不一致、改了半天不生效。强制做法：**每个文件单独 scp 一条命令**，推完立即 `md5sum <远端文件>` 与本地 `Get-FileHash -Algorithm MD5` 逐一对齐，不一致就是没推上。
- **推送前也必须比对基线 md5，不能只在推后比（2026-09-23 实测，这一步救了命）**：本地镜像只是"某一时刻的快照"，服务器可能**正被另一个会话改着**。做法：改前先把目标文件 `cp` 成 `.bak-<时间戳>`；**推送前**用 `md5sum <本地 .bak>` 对比服务器同名文件的 `md5sum`——**不一致＝有人改过 → 立即停手**，先 `git diff`／`ls -l` 查清对方改了什么，再决定是"在对方版本上重新应用我的改动"还是"等对方落地"。
  - 2026-09-23 实证：本地镜像在 `server.js` 上落后服务器一笔**未提交的流式链路重构**（工作区共 6 个文件未提交：server.js / mcp-tool-loop.js / chat.html / wake-scheduler.js / tools_config.json / tools_manifest.json），备份名 `-disable-direct-mcp`／`-response-parts`／`-reasoning-roundtrip`／`-timeline` 暴露了改动性质。若直接 scp 覆盖，对方数小时的工作即被抹掉。
  - 配套原则：**发现服务器有不一致改动时，连"重启服务"也要先问**——重启会用服务器当前文件启动，等于把对方**未完成**的改动激活上线（半成品风险）。
- **反向场景：本地镜像落后于服务器时，改本地再推会覆盖新版（2026-09-23 实测，差点酿成事故）**：上面那条讲的是"服务器有别人改动"，本条是其镜像——**本地镜像落后**。实测：准备给 `mcp-tool-loop.js` 加一个字段修复时，先 grep 定位，发现命中的行号（675/689）超出 `wc -l` 报出的 562 行，起了疑心；核对 md5 才确认**本地是删除前旧版（742 行）**、服务器才是新版（562 行）。若直接改本地再 scp，会**整份抹掉已提交的流式链路重构**。
  - 强制做法：**动任何本地镜像文件之前**，先 `md5sum <本地>` 对比服务器同名文件的 `md5sum`（本地用 Git Bash 的 `md5sum`，跨盘路径直接写 `C:/deepseek/cloud/...` 即可）。**不一致就先 `scp -O` 拉取覆盖本地**，再在最新版上改。
  - 辅助判据：改前 `grep`/`wc -l` 时若行号对不上、或文件大小与 `git status` 的预期不符，就是落后信号，立即核对，别硬改。
  - 本次处置：旧版留了 `mcp-tool-loop.js.bak-stale-local-*` 作标记，重新拉取后才动手。
- **每日记录只存服务器（2026-09-28 起，原「本地↔服务器双向同步」机制废止，本地记录文件夹已删除）**：工作记录只存在服务器 `/opt/dylan-heartbeat/agent每日工作记录/`。写记录 = 拉当天文件 → 本地临时副本编辑 → 单文件 `scp -O` 推回 → `md5sum` 复核（含中文文件名走 tar 打包规避编码/引号坑）；**写前重读当天文件取最大 NN+1**，防与并行会话撞号（撞号当场改号让位，见 0928 实录）。
  - **推送前必须重拉核对 md5（2026-10-01 1001-12/13 覆盖事故）**：编辑窗口内并行会话可能已写入并提交——「取号核对」只保证写前快照，推送前重拉核对不一致就停手合并（恢复走 git 历史）。
  - **tar 打包源必须就是编辑落盘的那个文件（2026-10-01 实证）**：平铺临时文件上编辑、目录结构副本打包，导致 tar「成功覆盖了旧内容」、md5 纹丝不动还不自知的空转——打包前 `md5sum 打包源` 与编辑副本比对一致再 tar。

### 6.2 Shell / 引号 / 编码
- 远端 shell 用单引号包整条命令：`ssh host 'cmd'`，避免本地先解析 `$(...)/引号` 导致 unexpected EOF。
- `ssh host "..."`（外层用双引号）时，命令内容里的 `$(date +%s)` 等会被本机 PowerShell 先求值——轻则备份名时间戳被吞/报 `Get-Date` 错，重则命令变形。要带时间戳的备份名，最稳是写脚本 → scp 到 `/tmp` → `ssh host 'bash /tmp/x.sh'` 执行，别在双引号 ssh 命令里拼 `$(...)`。
- PowerShell 内嵌 python 引号坑：`ssh host "python3 -c \"...encoding='utf-8'...\""` 会被本地 PowerShell 先解析 '/"/$()，报 ParserError。最稳做法：把命令写成本地 `.sh` → scp 上传到 `/tmp` → `ssh host 'bash /tmp/xxx.sh'`，绕开本地引号解析。
- 凡是在远端传带空格/特殊字符的参数（header、中文、json），直接走脚本文件，别在命令行拼。
- 别用 PowerShell `Get-Content` 读 UTF-8 中文（默认 GBK 乱码）；看中文用 read 工具。
- 远端跑多行 JS（`ssh host "node -e '...'"`）：引号/`$(...`/换行极易被本地先解析报 `unexpected token`。最稳做法：脚本里用 `cat > /tmp/x.js <<'EOF'` heredoc 落盘 → `node --check /tmp/x.js && node /tmp/x.js` → 删文件，绕开一切引号转义；且先 `node --check` 再执行，避免写库失败。
- 内部接口鉴权不确定时先实测再批量写库：`/v1/upload-image` 等走全局 addHook 要 `Authorization: Bearer <api_key>`（`chat-settings.json` 里的 key 即可用），无鉴权/带错头会 401。批量脚本先小样本验通道，成功再全量。
- Git Bash scp/ssh 首连报 `Host key verification failed`：加 `-o StrictHostKeyChecking=accept-new`（中文用户名导致 known_hosts 写不进，每次都会刷警告但不影响传输）。
- **踩坑（2026-09-22 实测，上一条的另一种成因）**：`Host key verification failed` 也可能是 `~/.ssh/known_hosts` 里**存在重复/冲突条目**导致——此时 `ssh-keyscan` 拿到的公钥与仓库内 `C:\deepseek\_known_hosts` **完全一致也照样失败**，`accept-new` 也救不了。解法：显式指定干净副本 `-o UserKnownHostsFile=C:/deepseek/_known_hosts`（该文件在仓库根，已收录 `120.76.99.224` 的 ed25519 公钥）。`cloud-sync.ps1` 已补 `-KnownHosts` 参数（默认 `C:\deepseek\_known_hosts`）并把它加到 ssh/scp 上；补参数前它因此**静默失败**（退出码 1、零输出），表现为"同步跑了但没反应"。
- Git Bash 里连接密钥路径务必写字面值 `-i "C:/Users/恪眷泠/.ssh/id_rsa"`；别用 PowerShell 的 `$env:USERPROFILE` 语法（在 bash 下会展开成 `:USERPROFILE\.ssh\id_rsa` 导致找不到密钥、Permission denied）。
- **生成/转换密钥格式（2026-09-16 实测）**：`ssh-keygen -p -m PKCS8` 对 **Ed25519** 私钥提示成功但**静默不转**（文件头仍是 OPENSSH PRIVATE KEY）。要 PKCS#8 PEM（如 ChatGPT SSH 只收未加密 PKCS#8 Ed25519，不收 RSA/OpenSSH 格式）用本机 python cryptography：`serialization.load_ssh_private_key` 读入 → `private_bytes(PEM, PKCS8, NoEncryption())` 覆写同文件。验证用 `openssl pkey -in 密钥 -noout -text_pub`（验类型且不泄私钥；**别用 asn1parse**，会把私钥字节打出来）。新密钥做登录测试务必加 `-o IdentitiesOnly=yes`，防止静默回退旧密钥造成假阳性。
- **踩坑（2026-09-26 实测）**：查「某配置是否存在」类问题，`grep -rn ... | grep -v '#' | head -20` 的 **head 截断会让排在后面的文件（含现行 nginx.conf）整个不可见**——差点据此误判「nginx 全局没配 proxy_read_timeout」（实际 /v1 有 300s，只是 /heartbeat/ 漏配）。存在性结论要用 `grep -c` 对具体文件计数，别用会截断的管道看一眼就下结论。
- **grep 交替模式必须 -E（2026-09-28 实测）**：`grep "a|b"` 是 BRE，`|` 按字面处理 → **静默零命中**（本次死代码核查脚本两节因此空结果，差点误判「无调用点」）；交替一律 `grep -E "a|b"`。顺带：`node --check` 只能查 JS 源码，对 package.json 报 SyntaxError（验 JSON 用 `node -e "JSON.parse(...)"`）。

### 6.3 MCP / 工具解析
- MCP（streamable-http）响应常是 SSE 而非纯 JSON：`tools/list` 返回 `event: message\ndata: {json}`，直接 `json.loads(raw)` 会报错。解析时逐行找 `data:` 前缀、取其后 JSON（多条时取最后一条 data），且 `result.content[].text` 常是嵌套的 JSON 字符串，要二次 `json.loads`。
- ESM 项目本地 `node --check` 误报：有 `.js`（含 import）的项目若本地目录没有 `package.json` 的 `"type":"module"`，本地 `node --check` 会报 `Cannot use import statement outside a module`——不是代码语法错。推到远端（项目本身 ESM）后再 `node --check`，或本地临时以 `.mjs` 校验。
- **`mcp__yun__*`（DeferExecuteTool）传参必须「扁平」，且命令里带管道/`sed`/复杂转义时会报错（2026-09-23 实测）**：
  - 参数结构：`params` 的值**直接就是**工具的参数对象，即 `{"command": "..."}`。误写成 `{"command": {"command": "..."}}`（多包一层）会报 `root: must be object`。修正方式：把内层对象直接当 `params`。
  - 命令内容：含 `|` 管道、`sed -n 'x,yp'`、或多重嵌套引号的 `run_command` **经常报同一个 `root: must be object`**（与参数结构无关，属命令字符串解析问题）。绕过方式：**拆成多条简单命令**分别调用（如把 `grep ... | head -20` 拆成一次 `grep -o` 限定输出），或改用 `read_file` / `search_text` 等专用工具。
  - 取大文件里的匹配**不要用会输出整行的 grep**：`THEME_PRESETS` 这类超长单行（数万字符）被整行吐出会冲垮上下文；用 `grep -no '<模式>'` 只回行号+匹配片段。

### 6.4 搜索范围（2026-09-21 踩坑，血的教训）
- **绝对不要在 `C:\deepseek` 或 `C:\deepseek\cloud` 根目录上做递归 grep/search（不限 `--include`、不限 `path`）**。这两个目录下挂着第三方整包构建产物（`zzf-mcp/apk/x/assets/.../app-renderjs.js` 单行 300 万字符、`workspace/*/package-lock.json`、`node_modules`），一次递归 grep 会把**几 MB 单行 JS 灌进上下文**，直接冲垮会话。
- 正确姿势：①`cd` 到目标子目录再搜；②必须跨目录搜时，用 Grep 工具的 `glob` 参数限定文件类型（如 `*.js`）+ 排除清单，或明确指定 `path` 到具体子目录；③拿不准先 `Glob` 看目录结构再决定范围。
- **排除清单必须显式列全（2026-09-21 二次中招）**：只写 `--exclude-dir=node_modules --exclude-dir=workspace` 仍会命中 `zzf-mcp/apk/x/assets/apps/__UNI__E392D13/www/app-renderjs.js`（单行 300 万字符）。在 `cloud/` 下递归 grep 的**安全写法**：
  `grep -rn "关键词" . --include=*.js --exclude-dir=node_modules --exclude-dir=zzf-mcp --exclude-dir=workspace --exclude-dir=_archive --exclude-dir=.git`
  拿不准就先 `ls` 看一眼顶层，把非源码目录（`*-mcp/`、`*apk*`、`_archive`、`node_modules`）全部排掉再搜。
- Git Bash 的 `bash` 首跑会报 `dirname: command not found` + `wc/ls: command not found`（shim 的 PATH 被污染），**不是真的没有这些命令**——在每条命令前加 `export PATH="/usr/bin:/bin:/usr/local/bin:$PATH";` 即可恢复。
- PowerShell 工具在本机 **stdout 捕获不稳定**（常返回 `Command completed with exit code 0` 但无输出）；需要看输出时，把结果 `Out-File` 写到一个 `.txt` 再用 Read 读。

### 6.5 文件与目录
- 镜像不是唯一真相，以服务器为准：改→推回→pm2 restart。
- 编辑前 `cp file file.bak-$(date +%s)`（`.bak*` 被 gitignore）。
- 大文件：用 `sed -n 1,200p` 分段看，别整个 cat。
- **踩坑（2026-09-30 实测）**：清理 `.bak-*` 时用 `ls *.bak-* | grep -v …` 收集清单——**shell glob 默认不匹配点开头文件**，7 个 `.env.bak-*` 全部漏网（含密钥的旧备份没清掉）；第二轮改 `find . -name "*.bak-*"` 补清。**凡涉及隐藏文件（点开头）的批量收集/清理，一律 find，别用 ls+glob**。
- **踩坑（2026-09-22 实测）本地镜像的 git 跟踪集与服务器不一致**：`routes/chat-context.js`、`lib/wake-scheduler.js` 在 `C:\deepseek\cloud` 里是 **untracked**（`git diff -- <file>` 对它永远为空、看不到自己改了什么、也不会有 diff 输出），在服务器 `/opt/dylan-heartbeat` 里却是 **tracked**（`git status` 显示 `M`）。**判断"改动是否生效/是否与他人冲突"不能只看本地 `git diff`**——要 `git status --short -- <file>` 或直接比两端 md5。改这类文件时别被"diff 为空"骗成"没改成功"。
- **本地 git 历史落后于服务器时，必须单独同步 `.git`**：`cloud-sync.ps1` 的排除清单含 `.git`，所以纯文件同步**不会**让本地 git 跟上；落后时本地 `git status` 会把已同步的文件误报为 `M`。恢复方式：服务器 `tar czf /tmp/hb-git.tgz .git` → scp 拉回 → 本地 `rm -rf .git && tar xzf hb-git.tgz`（约 60MB / 2.5 分钟）→ 校验 `git log --oneline -2` 能看到服务器最新提交、且目标文件 `git status` 归零。
- **本地跑「require 线上模块」的验证脚本（2026-09-25 实测）**：`C:\deepseek\cloud` 镜像**不含 `node_modules`**，直接 `require('cloud/lib/xxx.js')` 会报 `Cannot find module 'fs-extra'`（走 `memory-engine.js`）。解法：先 `$env:NODE_PATH="c:\deepseek\_tmp_node_deps\node_modules"`（该目录已备 fs-extra）再 `node 脚本.js`。两个连带坑：①脚本里 `console.error` 的输出会被 PowerShell 包成 `NativeCommandError`（哪怕 exit code 是 0），断言时要把 `console.error` 和 `console.log` 一并捕获，否则会误判成失败；②要隔离真实数据目录，先 `require.resolve` 目标依赖模块并替换 `require.cache` 的导出（见 05 的 W-3 坑）。