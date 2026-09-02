# Dylan Heartbeat 系统 — 会话交接(给下一位 Agent)

> **规矩(2026-09-02 起)**:按日期的工作明细写在本地 `工作记录/工作记录_YYYY-MM-DD.md`(没有就新建),本文件只留一行索引 + 下面 0-7 节稳定信息,不再滚动堆条目。

## 工作日志索引(明细在 工作记录/工作记录_日期.md)
- 2026-09-02:压缩/替换去自动解析入池+多选工具栏「一键入池」(不调LLM全文直入);记忆检索升级本地真语义(embed-server pm2 8795/bge-small-zh int8/混合检索/全量降级);路径整理(全系统收敛 /opt,软链降级纯别名);邮箱 MCP 挂 pm2 email-mcp、决策痕迹禁用;chat.html 分段连播 v2→v5(覆盖全入口/历史静态/间隔自适应);打开页面默认进最后活跃会话;压缩手工块跨会话错位修复;流式回复 QQ 式分段弹出;主题保存/背景上传修复;前端/后端代码审查(修复 P0 CSRF + P1 tools 路由鉴权,已上线)+六方向系统性排查(发现并修复 cookie Secure 与 sessions 索引缓存,已上线验证)+MCP 连接失败日志排查(核实为历史误报:enabled 双过滤正常、邮箱服务正常,flush+restart 已清,+前端优化(nginx /chat 协商缓存304+getCookie去重)+会话元数据跨设备同步补齐(标星UI对齐marked-list/分支父级session-branches/当前会话current-session,均服务器双向收敛)+压缩抽屉会话下拉选择器+reqctx移日志组,详见 工作记录_2026-09-02)
- 2026-09-01:修 yun-mcp-v2(TimeoutStopSec、PATH 修正、git 工具单文件聚焦)

## 0. 怎么访问云服务器(唯一接入方式)
- 通过 MCP 服务 yun-mcp-v2 (Http://120.76.99.224:9010/sse), header X-API-Key: Rsh200506@11111。
- 工具: list_dir / read_file / write_file / search_text / file_info / run_command / get_server_status / git_status / git_log / git_diff。
- 路径坑: MCP read_file 有映射怪癖(/root/workspace = /opt/dylan-heartbeat/workspace, 但 /root/HEARTBEAT.md 报不是文件)。可靠读文件用 run_command 跑 shell。
- DSH MCP 配置在本地 C:\\Users\\恪眷泠\\.dsh\\profiles\\web\\cordis.patch.yml。要原生 mcp__cloud__* 工具需重启 DSH web; 此前全程用 SDK 直连。

### 读文件(在 run_command 里复制)
cat /opt/dylan-heartbeat/server.js
sed -n 1,200p /opt/dylan-heartbeat/server.js
sed -n 4300,4350p /opt/dylan-heartbeat/server.js
grep -n pattern /opt/dylan-heartbeat/server.js
cat /opt/dylan-heartbeat/ops/status.sh

## 1. 架构 / 运行服务
- server.js 网关(端口 3000, node /opt/dylan-heartbeat/server.js, pm2 进程名 gateway)
- wake_up.js 心跳/唤醒( node, pm2 进程名 wake-up)
- email_server.py 邮箱 MCP(端口 5000, workspace/ 下, pm2 进程名 email-mcp)
- unified_server.py 统一后端(端口 8777, systemd unified-backend, 路径 /opt/dylan-heartbeat/workspace/unified_server.py, 蓝图 /todo /diary /monthly /notes /goban)
- tools_server(8771, systemd mcp-tools), yun-mcp-v2(9010, 本MCP), zzf-mcp(8890), spicy-monopoly(8773), netease(3303), ocr-api(8790)
- decision-trail(8787)已停用:进程未跑,mcp-servers.json 已禁用,nginx 路由还在
- nginx /etc/nginx/nginx.conf (listen 9001 http / 9002 ssl): /heartbeat/ -> 网关3000(去前缀); /admin -> 301 /heartbeat; /co-api/ -> 3000/internal/co/; /screenshot-api/ -> 3000/internal/screenshot/; /v1 -> 3000; /todo|/diary|/monthly -> 8777; /ocr-api -> 8790; /decision-trail -> 8787
- 路径规范:项目唯一真身 /opt/dylan-heartbeat;/root/workspace 只是软链别名,不再新增引用(详见 系统介绍.md 路径地图)

## 2. 凭据 / .env(/opt/dylan-heartbeat/.env)
- ADMIN_USER / ADMIN_PASSWORD (管理台 basicAuth, header Authorization: Basic base64(u:p))
- INTERNAL_API_KEY (内部 /internal/*, header x-internal-key)
- TARGET_API_URL / TARGET_API_KEY / MODEL_NAME (LLM), BARK_KEY, USER_DISPLAY_NAME
- 前端 admin 由网关 GET /admin/mobile (preHandler mobileAuth = header 认证) 返回; 资产 /admin/mobile.css 与 .js 免认证路由

## 3. 本会话已提交(master)
- 33dde5f memory-pool检索优化(截断限制后已revert)
- 115be4b 标星 -> context-replacements
- 5e9fdcf ops工具 + backupFile轮转 + .gitignore
- 4a44c0a 管理台对齐修复(AI生成摘要路径/字段 id->repId)
- 778c7ec 移 retrieval_max_content_chars
- 1b19825 utils/push.js
- 69e96a9 routes/push-events.js
- bc188da routes/memory-pool.js

## 4. 目录现状(/opt/dylan-heartbeat)
- server.js(5414行) wake_up.js memory-engine/memory-pool/context-replacements/context-compactor.js
- admin-mobile.html(62K) + admin-mobile.css(85K) + admin-mobile.js(230K)
- utils/push.js(7工具) routes/push-events.js routes/memory-pool.js
- ops/ (status.sh backup.sh cleanup.sh) data/(16M) backups/_bak_graveyard/ archives/(461M orphans tar.gz) archive/
- workspace/(unified_server.py email_server.py chat.html co-view.html index.html daily-涵/ diary/ monthly/ decision-trail/ mcp-tools/ 等)
- server.js 5611->5414 行; admin-mobile.html 356K->62K; 磁盘 38%->36%, 腾出 ~617MB

## 5. 验证手法(复用)
- 改 JS: python heredoc 精确替换(assert count==1) + node --check; 重启 pm2 restart gateway wake-up --update-env, sleep4, pm2 list | grep gateway, pm2 logs gateway --lines 12 --nostream
- 验管理台接口: python urllib + base64 Basic auth(从 .env 读 ADMIN_*) 或 curl -u u:p
- nginx: /usr/sbin/nginx -t 校验 -> systemctl reload nginx
- git add 只加具体文件, 绝不 -A (仓库有未忽略敏感文件 .git-credentials / .bash_history / .env)。.gitignore 已有 .env / *bak* / data/ / backups/ / enhanced_messages.json*
- 编辑前 cp file file.bak-<ts> (.bak* 被 ignore)

## 6. 未做 / 有坑
- context-compactor.js 删除: 剩 11 处调用(rangePreview / loadConfig / saveConfig / getCompactionPromptForDisplay / saveCompactionPromptConfig / resetCompactionPromptConfig / generateSummaryForRange), 连 LLM 摘要(makeChunk/buildCompactionPrompt/callCompactionLLM) + 管理台, generateSummaryForRange 会真调模型, 不可自动验证。建议分批 + 用户在 /admin/context-compaction 点一遍, 勿盲删
- memory-pool reparse/config/clean 路由仍在 server.js(LLM + addCompactionLog + path.join(__dirname,data,context_replacements.json))
- /admin/logs/* 散落各处未拆
- archives 461M orphans 备份未删(需用户确认)
- 更深目录重组(移动子项目/被引用页面)会断 require/路由, 别盲做

## 7. 兼容性注意
- data/config.json 被 memory-engine 和 context-compactor 共用(不同键共存)
- contentKey 两模块一致(sha256(role+0+contentToText).slice32); contentToText 仅差软删除保护(compactor 对 deleted 返回空). 现有标星兼容
- 管理台只有一个入口 /heartbeat/admin(用户用这个), /admin 是 301 跳转
- 管理台 MCP 服务器页(PUT /admin/mcp/servers)会整体覆写 mcp-servers.json, 手改后要读回确认; 改它之后需 pm2 restart gateway(启动后有 _mcpClientsCache)
