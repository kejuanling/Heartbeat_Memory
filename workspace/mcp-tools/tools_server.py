#!/usr/bin/env python3
"""
🌐 MCP 工具集 · 小世界全能工具包
暴露服务器上所有可用工具（除去Claude已有工具）
端口: 8771 · 鉴权: Bearer Token
协议: JSON-RPC 2.0
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, urllib.request, urllib.parse, os, time, subprocess
import datetime

PORT = 8771
API_TOKEN = "han-xie-2026"
BASE_URL = "http://localhost"

def _load_internal_key():
    """从心跳项目 .env 读取内部接口密钥"""
    try:
        with open("/opt/dylan-heartbeat/.env", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("INTERNAL_API_KEY="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""

INTERNAL_KEY = _load_internal_key()


# ===== HTTP 请求封装 =====
def api_get(url, timeout=6):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        return {"_error": str(e)}

def api_post(url, data, timeout=6):
    try:
        req = urllib.request.Request(url,
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        return {"_error": str(e)}

def run_cmd(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
        return {"stdout": r.stdout.strip(), "stderr": r.stderr.strip(), "rc": r.returncode}
    except Exception as e:
        return {"_error": str(e)}

# ===== 工具实现 =====
TOOLS = {}

# ── 2. 日记 ──
def tool_diary_list(args):
    count = args.get("count", 5)
    data = api_get(f"{BASE_URL}:8777/diary/api/entries")
    if "_error" in data:
        return {"error": data["_error"]}
    return {"entries": data[:count]}
TOOLS["diary_list"] = {
    "description": "查看涵的日记列表",
    "inputSchema": {
        "type": "object",
        "properties": {
            "count": {"type": "integer", "description": "获取条数，默认5"}
        }
    },
    "handler": tool_diary_list
}

def tool_diary_comment(args):
    eid = args.get("id")
    text = args.get("text")
    if not eid or not text:
        return {"error": "缺少 id 或 text"}
    result = api_post(f"{BASE_URL}:8777/diary/api/entries/comment", {"id": eid, "text": text})
    return result
TOOLS["diary_comment"] = {
    "description": "评论涵的某条日记（会Bark推送到她手机）",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "integer", "description": "日记ID"},
            "text": {"type": "string", "description": "评论内容"}
        },
        "required": ["id", "text"]
    },
    "handler": tool_diary_comment
}

# ── 心动时刻 ──
def tool_moments_list(args):
    limit = args.get("limit", 200)
    data = api_get(f"{BASE_URL}:8777/todo/api/moments?limit={limit}")
    if "_error" in data:
        return {"error": data["_error"]}
    moments = data if isinstance(data, list) else []
    return {"moments": moments, "count": len(moments)}
TOOLS["moments_list"] = {
    "description": "查看心动时刻记录列表（涵记录，谢停云可阅）。limit<=0时取全部",
    "inputSchema": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "返回条数，默认200；<=0取全部"}
        }
    },
    "handler": tool_moments_list
}

def tool_moments_search(args):
    q = args.get("q", "").strip()
    if not q:
        return {"error": "请输入搜索关键词"}
    limit = args.get("limit", 50)
    import urllib.parse
    q_enc = urllib.parse.quote(q)
    data = api_get(f"{BASE_URL}:8777/todo/api/moments/search?q={q_enc}&limit={limit}")
    if "_error" in data:
        return {"error": data["_error"]}
    moments = data if isinstance(data, list) else []
    return {"moments": moments, "count": len(moments), "keyword": q}
TOOLS["moments_search"] = {
    "description": "搜索心动时刻记录，按关键词匹配标题/内容/感受/定义备注（涵记录，谢停云可阅）。limit<=0取全部匹配",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "搜索关键词"},
            "limit": {"type": "integer", "description": "返回条数，默认50；<=0取全部匹配"}
        },
        "required": ["q"]
    },
    "handler": tool_moments_search
}

def tool_moments_count(args):
    """统计心动时刻总条数、按分类/阶段/是否定义时刻分组，可选返回最近N条预览"""
    # 取全部数据用于统计 (limit=-1)
    data = api_get(f"{BASE_URL}:8777/todo/api/moments?limit=-1")
    if "_error" in data:
        return {"error": data["_error"]}
    moments = data if isinstance(data, list) else []
    total = len(moments)

    # 预览条数（默认10，<=0不返回预览）
    preview_limit = args.get("preview", 10)

    # 分组统计
    by_category = {}
    by_stage = {}
    defining_count = 0
    for m in moments:
        cat = m.get("category") or "未分类"
        by_category[cat] = by_category.get(cat, 0) + 1
        stg = m.get("stage") or "无阶段"
        by_stage[stg] = by_stage.get(stg, 0) + 1
        if m.get("is_defining"):
            defining_count += 1

    # 按出现次数排序
    by_category = dict(sorted(by_category.items(), key=lambda x: -x[1]))
    by_stage = dict(sorted(by_stage.items(), key=lambda x: -x[1]))

    result = {
        "total": total,
        "defining_count": defining_count,
        "non_defining_count": total - defining_count,
        "by_category": by_category,
        "by_stage": by_stage,
    }

    if preview_limit and preview_limit > 0:
        # moments 已经按 ts 降序，取前N条做预览
        preview = []
        for m in moments[:preview_limit]:
            preview.append({
                "id": m.get("id"),
                "title": m.get("title", ""),
                "text": (m.get("text", "")[:80] + "...") if len(m.get("text", "")) > 80 else m.get("text", ""),
                "category": m.get("category", ""),
                "stage": m.get("stage", ""),
                "is_defining": m.get("is_defining", False),
                "ts": m.get("ts", "")
            })
        result["preview"] = preview
        result["preview_count"] = len(preview)

    # 可选：按分组过滤后的条数
    only_category = args.get("category", "")
    if only_category:
        matched = [m for m in moments if (m.get("category") or "") == only_category]
        result[f"count_in_category_{only_category}"] = len(matched)

    only_stage = args.get("stage", "")
    if only_stage:
        matched = [m for m in moments if (m.get("stage") or "") == only_stage]
        result[f"count_in_stage_{only_stage}"] = len(matched)

    return result

TOOLS["moments_count"] = {
    "description": "统计心动时刻：总条数、按分类/阶段/是否定义时刻分组、最近N条预览。推荐优先使用这个查看心动概况。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "preview": {"type": "integer", "description": "预览最近N条，默认10；<=0不返回预览，只返回统计"},
            "category": {"type": "string", "description": "可选：额外统计某分类下的条数"},
            "stage": {"type": "string", "description": "可选：额外统计某阶段下的条数"}
        }
    },
    "handler": tool_moments_count
}

# ── 3. 待办 ──
def tool_todo_list(args):
    data = api_get(f"{BASE_URL}:8777/todo/api/todos")
    return {"todos": data if isinstance(data, list) else []}
TOOLS["todo_list"] = {
    "description": "查看今日待办清单",
    "inputSchema": {"type": "object", "properties": {}},
    "handler": tool_todo_list
}

def tool_todo_add(args):
    text = args.get("text")
    if not text:
        return {"error": "缺少 text"}
    result = api_post(f"{BASE_URL}:8777/todo/api/todos/xie", {"text": text})
    return result
TOOLS["todo_add"] = {
    "description": "谢停云新增待办事项",
    "inputSchema": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "待办内容"}
        },
        "required": ["text"]
    },
    "handler": tool_todo_add
}

# ── 5. 经期 ──
def tool_period_get(args):
    date = args.get("date", datetime.date.today().isoformat())
    data = api_get(f"{BASE_URL}:8777/monthly/api/records/{date}")
    return {"date": date, "period": data.get("period") if isinstance(data, dict) else None}
TOOLS["period_get"] = {
    "description": "查看某天的经期记录",
    "inputSchema": {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "日期 YYYY-MM-DD，默认今天"}
        }
    },
    "handler": tool_period_get
}

# ── 12. 今日总结（AI写）──

# ── 12. 手机app使用记录 ──

def tool_phone_records(args):
    limit = args.get("limit", 20)
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://localhost:8084/today_records?limit={limit}", timeout=5) as resp:
            data = json.loads(resp.read())
        return {"records": data if isinstance(data, list) else data, "date": datetime.date.today().isoformat()}
    except Exception as e:
        return {"error": str(e)}

TOOLS["phone_records"] = {
    "description": "查看今天手机app使用的详细记录",
    "inputSchema": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "返回条数，默认20"}
        }
    },
    "handler": tool_phone_records
}

# ── 记忆检索（心跳记忆库，AI 主动回忆）──
def tool_memories_search(args):
    q = (args.get("q") or "").strip()
    if not q:
        return {"error": "请输入检索关键词"}
    topK = max(1, min(20, int(args.get("topK", 5))))
    params = {"q": q, "topK": topK}
    if args.get("type"):
        params["type"] = args["type"]
    if args.get("minImportance") is not None:
        params["minImportance"] = args["minImportance"]
    url = f"{BASE_URL}:3000/internal/memory/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"x-internal-key": INTERNAL_KEY})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"error": str(e)}
    if isinstance(data, dict) and data.get("error"):
        return {"error": data["error"]}
    mems = data.get("memories", []) if isinstance(data, dict) else []
    cleaned = []
    for m in mems:
        cleaned.append({
            "id": m.get("id"),
            "type": m.get("type"),
            "importance": m.get("importance"),
            "timestamp": m.get("timestamp"),
            "score": round(m.get("_score", 0), 4),
            "content": m.get("content"),
        })
    return {"query": q, "count": len(cleaned), "memories": cleaned}

TOOLS["memories_search"] = {
    "description": "主动检索谢意行的长期记忆库（语义+关键词混合检索，含相关度评分）。想回忆涵的偏好、事实、时刻、情绪、摘要时使用。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "检索关键词或想问的问题，例如：涵最喜欢的花、我们第一次见面"},
            "topK": {"type": "integer", "description": "返回条数，默认5，最大20"},
            "type": {"type": "string", "description": "按记忆类型过滤，逗号分隔：fact/preference/moment/emotion/trace/summary"},
            "minImportance": {"type": "number", "description": "最低重要度0~1，只返回重要度≥该值的记忆"}
        },
        "required": ["q"]
    },
    "handler": tool_memories_search
}

# ===== MCP HTTP 处理器 =====
class MCPHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_POST(self):
        # ── 鉴权检查 ──
        auth = self.headers.get('Authorization', '')
        if auth != f'Bearer {API_TOKEN}':
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                "jsonrpc": "2.0",
                "error": {"code": -32001, "message": "Unauthorized: 无效的 Authorization Token"}
            }, ensure_ascii=False).encode('utf-8'))
            return

        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        try:
            req = json.loads(post_data.decode('utf-8'))
            resp = self.handle_request(req)
        except Exception as e:
            resp = {"jsonrpc": "2.0", "error": {"code": -32700, "message": str(e)}}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(resp, ensure_ascii=False, indent=2).encode('utf-8'))

    def handle_request(self, req):
        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params", {})

        if method == "initialize":
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "protocolVersion": "0.1.0",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "小世界MCP工具集", "version": "1.0.0"}
                }
            }
        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": "pong"}

        if method == "tools/list":
            tool_list = []
            for name, t in TOOLS.items():
                tool_list.append({
                    "name": name,
                    "description": t["description"],
                    "inputSchema": t["inputSchema"]
                })
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": tool_list}}

        if method == "tools/call":
            tool_name = params.get("name")
            args = params.get("arguments", {})
            if tool_name not in TOOLS:
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32601, "message": f"未知工具: {tool_name}"}
                }
            try:
                result = TOOLS[tool_name]["handler"](args)
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]}
                }
            except Exception as e:
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32000, "message": str(e)}
                }

        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    # ── GET: 白兰访问计数（供前端页面调用）──
    # ── GET: 白兰访问计数（供前端页面调用）──
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        if self.path == '/baillan-visit':
            try:
                fpath = '/root/workspace/baillan/baillan.json'
                if os.path.exists(fpath):
                    with open(fpath) as f:
                        data = json.load(f)
                else:
                    data = {"planted": "2026-07-05", "name": "白兰", "status": "生长中", "count": 0, "stage": "seed", "last_watered": None, "total_visits": 0}
                data["count"] = data.get("count", 0) + 1
                data["total_visits"] = data.get("total_visits", 0) + 1
                stages_list = [1, 3, 6, 10, 15, 25]
                stage_names = ["seed", "sprout", "grow", "bud", "bloom", "full"]
                stage_idx = 0
                for i, th in enumerate(stages_list):
                    if data["count"] >= th:
                        stage_idx = i
                data["stage"] = stage_names[stage_idx]
                with open(fpath, 'w') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                resp = {"ok": True, "count": data["count"], "stage": data["stage"]}
            except Exception as e:
                resp = {"ok": False, "error": str(e)}
            self.wfile.write(json.dumps(resp).encode('utf-8'))
        else:
            self.wfile.write(json.dumps({"ok": True, "msg": "MCP Server Running"}).encode('utf-8'))

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    print(f"🚀 小世界MCP工具集启动 -> http://0.0.0.0:{PORT}")
    print(f"🔑 鉴权: Bearer Token (API_TOKEN={API_TOKEN})")
    print(f"📡 暴露 {len(TOOLS)} 个工具:")
    for name in sorted(TOOLS.keys()):
        print(f"   ├─ {name}")
    while True:
        try:
            server = HTTPServer(("0.0.0.0", PORT), MCPHandler)
            server.serve_forever()
        except Exception as e:
            print(f"⚠️ 服务器崩溃: {e}，5秒后重启...")
            time.sleep(5)

    # ── GET: 白兰访问计数（供前端页面调用）──

# ── 🎲 涩涩大富翁 ──
MONOPOLY_DIR = "/root/spicy-monopoly"
def _monopoly_run(cmd):
    """在游戏目录下执行引擎命令并返回结果"""
    return run_cmd(f"cd {MONOPOLY_DIR} && python3 monopoly_play.py {cmd}", timeout=15)

def tool_monopoly_new(args):
    p1_name = args.get("p1_name", "涵")
    p1_sex = args.get("p1_sex", "女")
    p1_role = args.get("p1_role", "受")
    p2_name = args.get("p2_name", "屿")
    p2_sex = args.get("p2_sex", "男")
    p2_role = args.get("p2_role", "攻")
    flavor = args.get("flavor", "medium")
    reverse = args.get("reverse", 0.3)
    rounds = args.get("rounds", 18)
    redline = args.get("redline", "")
    identity = args.get("identity", "mixed")
    
    cmd = f'new "{p1_name}:{p1_sex}:{p1_role}" "{p2_name}:{p2_sex}:{p2_role}" {flavor} {reverse} {rounds}'
    if redline:
        cmd += f" {redline}"
    cmd += f" 身份={identity}"
    
    result = _monopoly_run(cmd)
    return {"stdout": result.get("stdout",""), "stderr": result.get("stderr",""), "rc": result.get("rc",-1)}

TOOLS["monopoly_new"] = {
    "description": "🎲 开局涩涩大富翁。创建新游戏并分配身份。必填参数只有玩家名字。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "p1_name": {"type": "string", "description": "玩家1名字，默认涵"},
            "p1_sex": {"type": "string", "description": "玩家1性别，默认女"},
            "p1_role": {"type": "string", "description": "玩家1攻受，默认受"},
            "p2_name": {"type": "string", "description": "玩家2名字，默认屿"},
            "p2_sex": {"type": "string", "description": "玩家2性别，默认男"},
            "p2_role": {"type": "string", "description": "玩家2攻受，默认攻"},
            "flavor": {"type": "string", "description": "强度: light/medium/heavy，默认medium"},
            "reverse": {"type": "number", "description": "反转概率0~1，默认0.3"},
            "rounds": {"type": "integer", "description": "回合数12/18/24，默认18"},
            "redline": {"type": "string", "description": "红线，逗号分隔，如anal,pain"},
            "identity": {"type": "string", "description": "身份模式: off/mixed/nsfw_only，默认mixed"}
        }
    },
    "handler": tool_monopoly_new
}

def tool_monopoly_roll(args):
    result = _monopoly_run("roll")
    return {"stdout": result.get("stdout",""), "stderr": result.get("stderr","")}

TOOLS["monopoly_roll"] = {
    "description": "🎲 掷骰。当前玩家掷骰走格，触发对应格子事件。每次轮到你的时候调用这个。",
    "inputSchema": {"type": "object", "properties": {}},
    "handler": tool_monopoly_roll
}

def tool_monopoly_status(args):
    result = _monopoly_run("status")
    return {"stdout": result.get("stdout",""), "stderr": result.get("stderr","")}

TOOLS["monopoly_status"] = {
    "description": "📊 查看当前游戏状态：棋盘、位置、金币、手牌、身份信息。",
    "inputSchema": {"type": "object", "properties": {}},
    "handler": tool_monopoly_status
}

def tool_monopoly_result(args):
    result = _monopoly_run("result")
    return {"stdout": result.get("stdout",""), "stderr": result.get("stderr","")}

TOOLS["monopoly_result"] = {
    "description": "🏆 查看终局结果（仅游戏结束后有效）。",
    "inputSchema": {"type": "object", "properties": {}},
    "handler": tool_monopoly_result
}

def tool_monopoly_action(args):
    action = args.get("action", "")
    param = args.get("param", "")
    if action == "buyout":
        cmd = f"buyout {param}"
    elif action == "buy":
        cmd = "buy"
    elif action == "pay":
        cmd = "pay"
    elif action == "serve":
        cmd = "serve"
    elif action == "duel":
        cmd = f'duel "{param}"'
    elif action == "card":
        idx = args.get("card_index", 0)
        target = args.get("target", "")
        cmd = f"card {idx} {target}" if target else f"card {idx}"
    elif action == "discard":
        idx = args.get("card_index", 0)
        cmd = f"discard {idx}"
    elif action == "mark":
        target = args.get("target", "")
        pos = args.get("position", "")
        cmd = f'mark "{target}" "{pos}"'
    elif action == "persona":
        text = args.get("text", "")
        cmd = f'persona "{param}" "{text}"'
    else:
        return {"error": f"未知操作: {action}，可用: buyout/buy/pay/serve/duel/card/discard/mark/persona"}
    
    result = _monopoly_run(cmd)
    return {"stdout": result.get("stdout",""), "stderr": result.get("stderr","")}

TOOLS["monopoly_action"] = {
    "description": "🎮 游戏操作：买断(buyout)、买卡(buy)、付过路费(pay)、差遣抵费(serve)、对决(duel)、用卡/弃卡(card/discard)、猜淫纹(mark)、宣告人设(persona)。需要指定action和参数。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "description": "操作类型: buyout/buy/pay/serve/duel/card/discard/mark/persona"},
            "param": {"type": "string", "description": "参数，buyout需要玩家名，duel需要玩家名，persona需要玩家名"},
            "card_index": {"type": "integer", "description": "卡牌序号（card/discard时使用）"},
            "target": {"type": "string", "description": "目标玩家名（card/mark时使用）"},
            "position": {"type": "string", "description": "猜的位置（mark时使用）"},
            "text": {"type": "string", "description": "宣告内容（persona时使用）"}
        },
        "required": ["action"]
    },
    "handler": tool_monopoly_action
}

