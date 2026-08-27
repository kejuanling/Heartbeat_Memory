# Dylan Heartbeat 系统 — 会话交接(给下一位 Agent)

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
- unified_server.py 统一后端(端口 8777, python3 /root/workspace/unified_server.py, 蓝图 /todo /diary /monthly /notes /goban)
- email_server.py(5000), yun-mcp-v2(9010, 本MCP), zzf-mcp(8890), tools_server(8771), spicy-monopoly(8773), netease(3303), decision-trail(8787), ocr-api(8790)
- nginx /etc/nginx/nginx.conf (listen 9001 http / 9002 ssl): /heartbeat/ -> 网关3000(去前缀); /admin -> 301 /heartbeat; /co-api/ -> 3000/internal/co/; /screenshot-api/ -> 3000/internal/screenshot/; /v1 -> 3000; /todo|/diary|/monthly -> 8777; /ocr-api -> 8790; /decision-trail -> 8787

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
- workspace/(unified_server.py chat.html co-view.html index.html daily-涵/ diary/ monthly/ decision-trail/ mcp-tools/ 等)
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
