# 任务前速览（云服务器 MCP 工具 + AI 易错经验 + 系统速览）

> 本文件是唯一需要每次任务前快速扫过的经验总览，供 AI 任务前浏览。
> 已合并并去重：云服务器MCP工具使用经验 / AI易错经验汇总 / 系统架构关键要点 / 历史踩坑沉淀（含原「踩坑经验.md」已并入本文档）。
> 不再保留「按日期追加日志」式记录，只留框架介绍 + 踩坑干货，按主题整理。
> 历史完整版备份在 `/opt/dylan-heartbeat/backups/`。

---

## 📚 知识文档索引（快速导航）

本机与云服务器相关的参考文档都集中在 `/opt/dylan-heartbeat/`，扫这一份 + 按需翻下面几份：

- `云服务器MCP工具使用经验.md`（**本文件**）— 每次任务前扫它：系统框架 + 踩坑干货。
- `SERVER_DIRECTORY_MAP.md` — 云服务器目录与服务地图：端口 / 服务 / 路径 / Nginx 路由 / 运维速查。
- `心跳唤醒管理台-功能全解析.md` — 管理台所有页面、接口、逻辑的完整功能解析，改管理台功能时对照。
- `记忆池整理功能策划书.md` — 记忆池整理功能策划。
- （归档）`踩坑经验.md` — 已合并进本文件「AI 易错经验」各主题，原文件保留作历史备份。

---

## 〇、当前运维状态（2026-08-26 核实，重要，先看这条）

- 实际提供网关 3000 服务的**不是 pm2 里的 gateway**，而是一个独立启动的 `node /opt/dylan-heartbeat/server.js` 进程（当前 PID 1018357，21:04 启动），它**直接占用端口 3000**。
- **pm2 `gateway`（id 0）处于 stopped**（多次 restart 计数，因 3000 被上述独立进程占用导致 EADDRINUSE），并非正常启动态。
- 两者指向**同一份** `server.js` 代码，但运行方式不同：独立进程 ≠ pm2 托管进程。
- ⚠️ 因此**不能直接 `pm2 restart gateway`，也不要默认执行「重启服务」的 `pm2 restart wake-up gateway --update-env`**——重启 gateway 会因 3000 已被独立进程占用而 EADDRINUSE。服务相关改动一般由独立进程加载/已生效。
- 若想统一交回 pm2 管理：先 `kill` 占用 3000 的独立 `server.js` 进程，再 `pm2 restart gateway`；否则保持「独立进程跑服务、pm2 gateway 静默」现状。
- pm2 `wake-up`（id 1）正常在线，不在本次端口冲突范围。

---

## 一、系统速览（快速定位）

- 项目：Dylan Heartbeat（AI 伴侣后台心跳系统）。目录 `/opt/dylan-heartbeat/`，公网 Nginx 9001(HTTP)/9002(HTTPS) → 网关 3000。
- 双进程（PM2）：`gateway`（3000，对话/压缩/记忆/管理台）+ `wake-up`（唤醒 + 推送）。注：gateway 当前实际由独立 node server.js 进程提供（见上「当前运维状态」）。
- 技术栈：Node.js 20 + Fastify 5 + @xenova/transformers（当前 embedding_enabled=false，走关键词检索）+ PM2 + Nginx。
- 关键文件：`server.js`（网关+管理台 API）、`wake_up.js`（唤醒）、`admin-mobile.html`（管理台）、`memory-engine.js`、`memory-pool.js`、`context-compactor.js`、`context-replacements.js`、`tag-parser.js`、`time_utils.js`。
- 数据：`data/`（config.json / state.json / context_replacements.json / memory_pool.json / push_log.json / *_prompt.json 等）+ `enhanced_messages.json`（时间线）、`diary/`。
- 其他 MCP 端口：yun-mcp-v2(9010)、netease-music(3303)、spicy-monopoly(8773)、decision-trail(8787)、ocr-api(8790)、mcp-tools(8771)、zzf-mcp(8890)、phone-api(8080/8084)、email_server(5000)。
- decision-trail(8787)：决策痕迹 MCP，源码在 `workspace/decision-trail/`（有独立 git 仓库，remote=github xie.git，main 无 upstream，源码此前未被跟踪；数据文件由程序 autoPush 只推 data/decisions.json）。**决策同步到记忆池功能已停用**（网关 server.js 无对应 internal 接口，一直 404，无实际作用；mirrorDecisions/removeDecisions/backfillToGateway 已改为空操作并清理死代码）。
- 管理台：`http://<公网IP>:9001/heartbeat/admin/mobile`（账号密码见 `/opt/dylan-heartbeat/.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD`）。
- 常用命令：`nginx -t && systemctl reload nginx`；`pm2 logs gateway --nostream`；`systemctl status <svc>`；`find / -name <文件>` 定位。**注意 gateway 的重启姿势见「当前运维状态」**。

---

## 二、MCP 工具使用经验

- 先备份再改：生产改动前 `cp -p` 并 `md5sum` 校验；改完 `node --check` / `py_compile` 自检；大文件用 python 精确锚点替换，`assert count==1` 后才写盘。
- 定位慢响应：`pm2 logs gateway --nostream` 看 `/v1/chat/completions` 的 `responseTime` / `prompt_tokens` / `image_parts`；`prompt_cache_hit_tokens` 命中率高说明文本不是主因，**图片无法命中缓存、每次重编码 → 历史图片才是慢的主因**。
- 管理台新增参数链路：`memory-engine.js DEFAULT_CONFIG` → `server.js RUN_CONFIG_WHITELIST + RUN_CONFIG_TYPES`（使用处从 `getConfig()` 读）→ `admin-mobile.html` 加卡片 + `load/save`（`fetch(ADMIN_API+'/config')`）。`admin-mobile.html` 每请求现读改即生效；`server.js`/`memory-engine.js` 需 restart 对应进程。
- `admin-mobile.html` 缩进是按嵌套层数（1/3/5/7 空格），与常见 2/4/6 不同；字符串锚点替换前必须 `repr()` 打印实际行。
- `data/` 已被 `.gitignore` 忽略，备份放 `data/_fix_backup_*` 不污染 git。
- mcp `list_dir` 不认相对路径，必须绝对路径；node_modules 会爆炸，先过滤。
- mcp `read_file` 读大文件（32KB+）自动截断中间段，要 start_line/end_line 分段读。
- `search_text` 只接受目录路径（传文件报「不是目录」），查看单文件用 `read_file`。
- systemctl restart MCP 服务会重启进程本身，正在执行 run_command 的会话被 SIGTERM(-15) 属正常；重启后确认 active 与 /health。
- 生成代码若需在字符串里输出反斜杠（如 "\n"），用 `chr(92)+chr(110)` 或 `chr(10)` 拼装，避免 JSON/heredoc 转义踩坑。
- bark 推送：本地 Invoke-RestMethod 被沙盒网络拦截（TLS），改用服务器 curl；URL 中文需 URL 编码。

---

## 三、AI 易错经验（按主题）

### 3.1 端口与「谁真正在服务」的识别
- **查端口别用 `ss | grep ':3000'`**：3000 在 `/etc/services` 里映射为服务名 `hbci`，`ss` 显示 `*:hbci` 而非 `*:3000`，grep 会误判"空闲"。要 `ss -antp | grep -iE '3000|hbci'` 或 `lsof -i :3000`。**注意 `ss -tlnp` 在某些环境直接不显示端口/为空，此时以 `lsof -i -P -n | grep LISTEN` 为准。**
- **判断"谁真正在服务"用 `lsof -i :PORT`**，别只看 `pm2 list`：pm2 可能显示 `errored`/`stopped`，但端口其实被一个运行中的 `node server.js`（孤儿/脱节进程）占着，pm2 反复 restart 永远 `EADDRINUSE`。此时要重启的是那个占端口的进程，而不是 `pm2 restart gateway`。
- **判断"运行中的进程是否加载了新代码"**：进程启动时间 > 代码文件 mtime 即代表已加载新代码（日志看 gateway out log）。
- 项目实际路径与目录地图可能不符：先 `find / -name 文件名`，别只信 SERVER_DIRECTORY_MAP.md。
- systemd 显示 active 但可能实际崩溃循环（端口被手动 nohup 旧进程占用 → bind 失败重试）。看 `/proc/net/tcp` socket inode 归属 + `ps`，别只看 systemctl status。
- 接口验证起 PORT=3100 临时实例，测完 kill，避免碰 3000 线上进程。

### 3.2 服务与进程
- 长驻进程（gateway / wake-up）各把配置读进内存，改 `data/config.json` 后必须重启对应进程才生效；wake-up 不热读 config。
- PM2 双 daemon 坑：`pm2 list` 为空但进程实际由 `/root/.pm2` 的 God Daemon(老进程)托管时，CLI 会连到刚新建的空 daemon。可靠重载方式：直接 `kill <gateway_pid>`，PM2 原 daemon 会以 `autorestart:true` 读盘拉起新进程。
- PM2：wake-up 找不到 .env → 必须 `cd /opt/dylan-heartbeat` 后启动；pm2 restart 不更新工作目录 → delete + start；`pm2` 不在 PATH → 用 `/opt/node/bin/pm2`。

### 3.3 API 测试与数据安全
- 「按钮提示保存成功」≠「改动持久化」。必须对比保存前后配置文件的实际内容。
- 排查链路：请求到达（网关日志）→ 是否写盘（mtime/内容）→ 运行服务是否读同一份文件（systemd WorkingDirectory、路径一致）。
- 「diff 式保存 + 全量覆盖」是典型数据丢失：前端以为发了「全部要改的」，后端以为是「全部最终状态」。
- 用管理接口做「写入类」测试会真改数据。测试覆盖/合并型 API 必须像真实前端传完整状态（如 `PUT /admin/tools` 传 `disabled: []` 会把用户停用工具全部启用）；要么先快照、要么只测校验失败分支；改完与备份逐字比对。
- **快照里的 content 已是 JSON.stringify 后的字符串**（如 `/admin/logs/context` 响应），直接喂给「数组拆分函数」会误判为没图片（count=0）。要先 `JSON.parse` 还原成数组再验证，或改在捕获点之前验证。
- **`lastLLMMessages` 是内存态**，重启后为空，接口返回空数组属正常。验证逻辑用真实快照离线测即可，**不要为了验证去触发真实上游对话**（会打扰线上聊天）。
- 多模态响应体积：单条 content 内嵌 base64 图片可达 2MB，前端当纯文本渲染会卡死。后端用 `splitMultimodalContent()` 拆成「纯文字 + 图片元数据」，base64 不落存储/不进响应；前端对图片只显示「[图片 N 张]」，超长纯文本（>30000 字符）折叠「展开全文」。
- **朝不存在的接口发请求 = 白费 + 一直 404**：decision-trail 曾向 `/internal/decisions/sync`、`/internal/decisions/remove` 同步决策到记忆池，但网关 server.js 从没实现这两个接口，于是每次决策操作都触发 404 告警、功能为空。排查：先 `search_text` 在 server.js 里确认真实存在该路由/接口，再判断是否真的在服务。此类「假同步」应直接关掉，而非反复重试。

### 3.4 多进程 / 并发 / 沙盒
- gateway 与 wake-up 共享数据文件是竞态：多进程共享文件必须「单写者」或加锁；wake-up 只读，写入统一走网关内部接口。
- 并发编辑同一批文件：另一 AI 会话可能同时改（mtime 变/内容整体替换）。改前后看 mtime，发现被换过要重新核对。
- 沙盒 writable roots 不同 turn 会变；以当前 permissions 为准。

### 3.5 上下文压缩
- 先分清两套系统：context-replacements（记忆/AI 替换）与 context-compactor（手动块摘要替换），别混。
- 块启用状态决定压缩是否生效：先看 `data/context_compaction_blocks.json` 的 `enabled`。
- 块索引是「时间线可压缩消息」序号（0 起），不是发送上下文序号，会因特殊事件/工具链偏移。
- 压缩编号体系要同源：未覆盖区预览编号（`rangePreview`）与填编号/改范围（`compressibleItems`）必须用同一套可压缩列表，`rangePreview` 应复用 `contextReplacements.compressibleItems()`，否则 compactor 对软删除消息"保留占位"会让编号漂移约 8 条。
- 模拟压缩直接 require `context-compactor.js` 跑 `compactMessages`，不要自己重写签名算法。签名 = sha256(非特殊事件消息 contentToText 按 `\x01` 连接)，锚点用 `normalizedCompareKey(role+\x00+去标签压缩空白)`。
- 网关日志「转发前压缩生效: 消息 X -> Y」是真实发送前计数；`/admin/logs/context` 返回 lastLLMMessages（压缩后、转发前），两者一致才是生效。
- wake-up 与主聊天共用 compactor 但各自组装历史；查「实际发送条数」要区分是 wake-up 日志还是 gateway 日志。
- 压缩「条数没变」不一定是坏：手动块按签名在缓存 context_compaction.json 找摘要，命中才替换。

### 3.6 统一替换（applyReplacements）
- applyReplacements 是唯一生效入口：主聊天 / 唤醒(wake_up.js) / 共影(coBuildHistory) 三处都要改，漏一处某路径还是原文。
- recordText 应用时包一层前缀「（对话摘要 · 时间范围）\n」；断言校验要用完整前缀。
- 预览接口 buildUnifiedReplacementPreview 里 blockStart/blockEnd 是「可压缩消息」序号（0 起），页面显示要 +1；AI 记录无 range，用 firstIdx/lastIdx 换算。
- 重算块签名时 items 结构必须是 `{msg, idx}` 列表（chunkSignatureOf 内部取 e.msg）；传裸消息会算出空签名。
- 管理页遗留死按钮比后端下线慢半拍：mark / add-summary / reset（会清空全部手工块）/ prompts 压缩提示词，后端下线时同步从页面移除。
- 判断「发给模型的实际上下文」要同时看主聊天（server.js /v1）和唤醒（wake_up.js runWakeUp），以代码实际路径为准，别只看配置残留开关。
- 管理台显示状态不能全信：publicItem 丢 enabled 字段会把已停用的替换显示成「已替换」。

### 3.7 唤醒系统
- 唤醒与对话差异 = 工具调用链（唤醒无）+ 唤醒提示词（唤醒有）；其余共用同一套组装，不要另起一套配置。
- 唤醒日志只输出摘要，看不到完整 payload；确认实际发送内容按代码路径重建（stripPosition → applyReplacements → compactMessages → 拼 wakeMessages）。
- `<wake>` 严格正则 `<wake>\s*(\d+)\s*</wake>`；0/负数忽略，>1440 截断为 1440。
- `<wake>` 标签必须在写入时间线/推送前从原始回复剥离（extractDiaryFromResponse 之前），否则泄漏到推送和上下文。
- 唤醒抑制守卫放 runWakeUp 最前面，每次重新读文件（readWakeSchedule 不缓存），长驻进程才即时生效。
- 定时唤醒作废：设定后、到点前用户发任何消息 → 作废；updated_at 当设定时刻，getLastUserTime 对比。作废清理文件时必须同时 clearTimeout 内存定时器，否则到点还会跑一次。
- 提示词要改两处：wake_prompt.txt（实际渲染）+ wake_up.js buildWakePrompt 默认兜底模板。

### 3.8 检索行为
- 多关键词搜索语义是「交集」：所有关键词都命中才出现，不是 OR；searchTimeline 和检索池都用 `hitTerms.length === terms.length`。
- recentlyShown 10 分钟去重是用户认可的原行为，不要擅自「修」；改行为前先确认是不是 bug。
- 检索池去重：先归一化（去标签/标点/空白）精确去重，再 5-gram Jaccard>=0.9 近重复；倒排索引加速；缓存 5 分钟。
- 工具说明与实现要一致：说明写「可以问问题」但实现是整句字符匹配 → 改为「用关键词检索」。
- 词云看不到导入词不是 bug：按权重取前 80，低频词排不进去。
- curl 测中文 query 必须 `--data-urlencode`，浏览器端 encodeURIComponent 没问题。

### 3.9 提示词与特殊事件
- 记忆内联标签：VALID_TYPES 白名单要全；流式响应过滤 `<memory>` 用 tagBuffer + findPartialOpen 逐 chunk。
- `[DIARY]` 正则与方括号冲突，用 `[\[]DIARY[\]]`；未闭合容错提取（开标签后剩余视为日记）+ 推送/上下文兜底剥离残留标签。
- 孤儿 AI 回复：客户端删用户消息后清理无配对 assistant。
- 提示词优先级：`wake_prompt.txt` > `WAKE_PROMPT_TEMPLATE` 环境变量 > 代码默认模板。Prompt = wakePrompt + memoryContext + pinnedContext + cleanSP（+ 时间标签）。

### 3.10 前端 / 管理台开发踩坑
- **`read_file` 显示的行号会多带一个前导空格**，导致"看到"的缩进比文件实际多 1 个空格；用精确字符串替换时按显示缩进匹配会 `count=0` 失败。改前先 `python -c "print(repr(读取片段))"` 确认真实缩进，或用正则 `[ \t]*` 匹配缩进、不写死空格数。
- 缩进陷阱：admin-mobile.html 不同段落混用 1/3/5/7 与 2/4/6 空格缩进（toggleCard 等 1/3、fetch 封装与 mempool 段 2/4）。批量补丁前先用 `sed -n 'Np' | cat -A` 抄真实空白，锚点 count 校验全部为 1 才写盘，任一失败先 exit(1) 不落盘。
- **校验单文件 HTML 内联 JS**：用 python 正则提取 `<script>...</script>` 内容写到临时 `.js`，再 `node --check`。注意服务器 python3.6 的 `subprocess.run` 不支持 `capture_output` 参数，要用 `stdout=subprocess.PIPE, stderr=subprocess.PIPE` + `communicate()` 或用 python3 新版本。
- 后台轮询必须命名化：匿名 `setInterval` 无法清理/暂停，改为 `unreadPollTimer` 等命名变量 + `start/stop` 辅助函数；用 `visibilitychange` 在页面隐藏时 `clearInterval`、显示时按状态恢复。
- 重绘短路：`reconcileCcList(el,html)` 若 `html === ccLastRenderedHtml` 直接 return，相同渲染结果不再解析/替换 DOM。
- 全局加载条：fetch 封装内加 inflight 计数，首个请求 180ms 后才显示 `.global-loading`，`.finally(endLoad)` 只附加在 admin URL 分支。
- 键盘可达性：对 FAB/回到顶部/折叠卡片头等 onclick 元素补 role/tabindex，并 addEventListener('keydown')（Enter/Space preventDefault 后调用原函数）；折叠卡片用 aria-expanded。
- busy 按钮：保存函数统一 apiRequest(..., {busy:...})，由 apiRequest 自动禁用/恢复，防重复提交。
- CSRF 双提交：登录与既有会话下发可读 `admin_csrf` cookie；Fastify 全局 `preHandler` 在 `/admin*` 写操作+有效会话时校验 `X-CSRF-Token` 与 cookie 一致；Basic 认证与 `/internal/*` 跳过。`reply.header('Set-Cookie',[a,b])` 支持同时下发两个 cookie。
- XSS 内联 onclick 陷阱：把用户文本放进 `onclick="fn('...')"` 时，`escapeHtml` 把 `'` 转成 `&#39;` 会被 HTML 先行解码回 `'`，从而可注入。需用专门函数 `escJsStr`（先转 `&`，再转 `"`,`<`,`>`,`\`,`'`）。
- Python 正则坑：`re.findall(pattern, content)` 不加 `re.M` 时 `^` 只匹配字符串开头，跨行锚点全部 count=0 静默失败；`sed -i` 在 MCP heredoc 里改 Python 正则字符串容易双重转义，直接重写脚本文件更稳。
- **JS 作用域坑**：把工具函数插到 `app.post("/v1/chat/completions")` 处理器内部后，顶层函数访问不到，运行时报 ReferenceError。`node --check` 查不出作用域问题，改完必须确认函数在顶层，否则移到顶层。
- **面板/卡片跨页签移动**：除搬 HTML 外，还要同步 `switchTab` 里的按页签加载逻辑（如 `loadToolsConfig`/`loadServices` 从 system 分支移到 config 分支、`loadPinned` 从 prompts 分支移除），否则切到该页签列表空白。用元素唯一标记（id/data-collapse-id）做区间判断，别用 indexOf 匹配中文标题（会误命中注释/弹窗标题）。
- 大函数拆分走"自下而上按行号替换"：先改最下面的行区间（行号不变），再依次向上，最后在最上方做插入；每步用首尾行文本做断言防偏移。
- 状态收敛方案：37 个压缩/记忆业务变量收进 `const AppState = {...}`，删掉散落的 `let` 声明，全文件用正则 `\b名称\b` → `AppState.名称` 替换。顺序：先删声明 → 再替换标识符 → 最后插入 AppState 对象（键名不能被二次替换）。替换后跑"裸引用检查"：`(?<![A-Za-z0-9_$.])名称\b` 只允许命中对象键与注释。
- 单文件纯函数单测法：test 脚本里读 admin-mobile.html，正则提取 <script> 块，再按函数名 + 平衡大括号提取函数源码，vm.runInContext 求值后断言。给"单文件部署"的前端纯逻辑补 node --test。
- `node --test`（不带路径）会递归扫整个仓库目录树，可能被无关文件干扰（本仓库会因 .local/bin/python3.11 缺失报错）；跑单测用显式路径 `node --test test/xxx.test.js` 最稳。
- re.sub 替换串陷阱：`\'` 不是 Python 替换串转义，会原样写成反斜杠+引号，产生非法 JS（如 `memView: \'cloud\',`）。字符串字面量改用双引号（`memView: "cloud",`）规避；任何替换后必须 node --check 兜底。
- **缩进/锚点必须用整行**：`<span class="collapse-arrow">▾</span>` 这类在页面上重复出现，精确替换必须用整行做锚点，否则 count!=1 或改错位置。
- 验证组合拳：node --check 只查语法；线上用 curl 登录后 grep 标记 + 检查 git diff --stat 只含目标文件。
- 改 onclick/定位行为后用户说“还是跳/没变”先别动代码：admin-mobile.html 服务端每请求都从磁盘读、不用重启，用户端看到旧的十有八九是浏览器缓存。先让用户 Ctrl+Shift+R（Mac Cmd+Shift+R）强刷再测，确认后再改。本次“原文搜索点结果自动跳转”就是：先只堵标星、用户反馈仍跳（缓存+未强刷），最后直接整块去掉 onclick 定位才符合预期。


### 3.11 凭据与安全
- 凭据读取：dotenv 运行时注入不会出现在 `/proc/<pid>/environ`；应从 `/opt/dylan-heartbeat/.env` 的 `ADMIN_USER`/`ADMIN_PASSWORD` 读取（勿打印明文）。
- 鉴权：反代场景 `ALLOW_PUBLIC_API=false` 仍可匿名访问 → 网关只信任可信内网源的 X-Real-IP/X-Forwarded-For；「内网才放行」必须考虑反代链路与伪造头。
- `.env` 权限 600；PM2 日志装 `pm2-logrotate`；管理台建议走 HTTPS。

---

## 四、其他关键经验（历史沉淀）

- 嵌入模型：HF 国内不可达 → 代码内设 `env.remoteHost="https://hf-mirror.com/"`；transformers v2.17.2 不自动读 HF_ENDPOINT。嵌入未就绪时 addMemory 得到 null → 两阶段（先入库再补 embedding）。1.8GB 内存 OOM → `NODE_OPTIONS=--max-old-space-size=800` 或远程嵌入 `EMBEDDING_API_URL`。
- 数据文件：全部原子写（tmp + rename）；时间线损坏 loadTimeline 自动备份 `.corrupt-*`；空 body 请求跳过 saveTimeline。
- 内存治理：gateway ~450-700MB + 无头浏览器 ~170MB → OOM 杀进程（曾一晚上重启 300+ 次）。用 `free -h`、`dmesg | grep -i oom`、`pm2 list` 重启次数监控。
- 工具集（mcp-tools）：`tools_manifest.json` 由服务启动时自动重新生成，**不能手改**；运行时描述以 `tools_config.json` 的 `descriptions`/`schemas` 覆盖为准（配置覆盖优先，源码只作恢复默认底稿）；改完 watch 循环 2 秒热加载重写 manifest；`tools_server.py` 只作源码默认。
- 导入对话：`imported-conversations.js` 解析（按 `---` 分段，首行 `YYYY年M月D日 HH:mm:ss · 说话人`，涵→user、谢意行→assistant）；入库后逐条恢复原始 timestamp；导入内容不能整个记录共用同一个去重 key。


### 3.12 网关（gateway）重启与“整理记忆池”清洗调优
- **gateway 重启坑**：pm2 里 `gateway` 常显示 `stopped`/`pid=0`（状态与真实进程 desync），但实际在跑 `node /opt/dylan-heartbeat/server.js`（父进程是 PM2 God Daemon，pid 通常 67493）。改完 server.js/memory-pool.js 要生效，用 **准确 PID `kill -TERM <pid>`**，pm2 会自动拉新进程；别依赖 `pgrep -f "^node ...server.js$"`（精确匹配常抓不到，导致 kill 空转），也别相信 `ss -ltn | grep :3000`（有时测不到但 curl 有响应）。重启后用 `curl -u han:xxxx -s -o /dev/null -w "%{http_code}" .../clean/prompt` 看 401/200 判断是否加载了新路由。
- **改代码后必须重启**：`admin-mobile.html` 改动刷新浏览器即可生效，但 `memory-pool.js`/`server.js` 改动要重启 gateway。
- **清洗性能**：`deepseek-v4-flash-vision-exp` 单条清洗约 2.7s，整池 270 条一次喂会超时。`clean_max_items`（默认 50）控制单次批大小，`cleanPool` 按重要级降序取前 N，低频“体检”分几次跑。若 MCP `tools/call` 超时，先把 `clean_max_items` 临时调小（如 8）做只读 preview 验证管道。
- **对齐 note**：`/proc/<pid>/environ` 读不到 dotenv 注入的凭据，admin 凭据在 `/opt/dylan-heartbeat/.env` 的 `ADMIN_USER`/`ADMIN_PASSWORD`（勿打印明文）。
- 压缩编号体系要同源：未覆盖区预览编号（`rangePreview`）与填编号/改范围（`compressibleItems`）必须用同一套可压缩列表，`rangePreview` 应复用 `contextReplacements.compressibleItems()`，否则 compactor 对软删除消息"保留占位"会让编号漂移约 8 条。
- 生成摘要发原文必须同源：`generateSummaryForRange` 一定要用 `contextReplacements.compressibleItems()` 构建 items，别用 compactor 自己的 `isCompressible`（后者对软删除 `deleted===true` 返回 true、且不排除「记忆碎片」，列表会多几条，导致同一编号指到不同消息、切片首尾与块编号错位）。`buildPlan`/`generateBlockSummary` 用 `loadBlocks()`（context_compaction_blocks.json 那套）与 `compressibleItems` 是两套编号，别混。

### 3.13 已标星消息编辑 与 进程重启确认
- 已标星消息存 `data/context_compaction_marks.json`；`listMarked()` 只列 content 非空的条目，`total` 可能 < 文件内 mark 总数（content 为空的存量会被过滤/走 matched 兜底）。
- 标星消息正文会被 `starredContextText()`（server.js）读到用于**跨窗口注入**（拼成 `她：/我：`+content）。所以编辑标星消息 = 改 `marks[key].content`，改完会同步影响跨窗口注入给 AI 的内容。
- 编辑链路：`context-compactor.updateMark(key,{content})`（只改 content，保留 markedAt/role）→ `server.js POST /admin/context-compaction/marked/update` → 前端 `openMarkEdit/saveMarkEdit`。⚠️ 不要复用 `/admin/context-compaction/mark` 做编辑（它会重置 markedAt，把消息当作重新标星）。
- kill 独立的 node server.js 进程后，PM2 God Daemon 会按 `autorestart:true` 自动拉起新进程（加载新代码），但 `pm2 list` 可能显示 `errored`/`pid=0`——这是**状态 desync**，别误判服务挂了。判断是否加载新代码：进程 `lstart`（`ps -o lstart`）是否晚于代码文件 mtime。
- 用管理接口测"写入类"会真改数据（标星/编辑），先备份 `data/context_compaction_marks.json`，测完复原并逐字比对，残留测试标记 grep 排查。
