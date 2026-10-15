#!/usr/bin/env python3
"""
🌐 MCP 工具集 · 小世界全能工具包
暴露服务器上所有可用工具（除去Claude已有工具）
端口: 8771 · 鉴权: Bearer Token
协议: JSON-RPC 2.0
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
import json, urllib.request, urllib.parse, urllib.error, os, re, time, subprocess, threading
import datetime

PORT = 8771
API_TOKEN = os.environ.get("MCP_TOOLS_API_TOKEN", "")  # 值在 /opt/dylan-heartbeat/.env（经 systemd EnvironmentFile 注入）
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

def api_get_key(url, timeout=8):
    """带内部密钥的 GET（/internal/*）"""
    try:
        req = urllib.request.Request(url, headers={'x-internal-key': INTERNAL_KEY})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try: body = e.read().decode('utf-8')
        except Exception: body = str(e)
        return {"_error": "HTTP %s %s" % (e.code, body)}
    except Exception as e:
        return {"_error": str(e)}

def api_post_key(url, data, timeout=8):
    """带内部密钥的 POST（/internal/*）"""
    try:
        req = urllib.request.Request(url,
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try: body = e.read().decode('utf-8')
        except Exception: body = str(e)
        return {"_error": "HTTP %s %s" % (e.code, body)}
    except Exception as e:
        return {"_error": str(e)}

def run_cmd(cmd, timeout=10):
    # 安全加固（2026-09-08）：shell=True 允许 shell 语法注入，存在 RCE 风险；
    # 改为参数化执行（shlex.split + shell=False），不再支持管道/重定向/通配符等 shell 特性。
    try:
        import shlex
        argv = shlex.split(cmd) if isinstance(cmd, str) else list(cmd)
        r = subprocess.run(argv, shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
        return {"stdout": r.stdout.strip(), "stderr": r.stderr.strip(), "rc": r.returncode}
    except Exception as e:
        return {"_error": str(e)}

# ===== 工具实现 =====
TOOLS = {}

# ── 2. 日记 ──
def tool_lovediary_add(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要写入陪伴日记的正文"}
    # 2026-10-03：日记改 data/diary.json，写操作统一走网关内部接口（根治多进程并发写）
    session_id = str(args.get("session_id") or "").strip()
    data = api_post_key("%s:3000/internal/diary" % BASE_URL,
                        {"content": content, "session_id": session_id or None})
    if "_error" in data:
        return {"error": "写入陪伴日记失败: %s" % data["_error"]}
    if not data.get("success"):
        return {"error": "写入陪伴日记失败: %s" % data}
    # 2026-10-19：带回新条目 id——网关工具循环从回执解析出 diary_id，给时间线消息打外键
    return {"success": True, "message": "已写入陪伴日记", "diary_id": data.get("id")}

def tool_her_murmurs(args):
    # 2026-10-16：默认只返回最近 1 条（原 5 条），可用 offset 翻页；接口返回本身就是从新到旧
    try:
        count = int(args.get("count", 1) or 1)
    except (TypeError, ValueError):
        count = 1
    count = max(1, min(count, 50))
    try:
        offset = int(args.get("offset", 0) or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)
    data = api_get(f"{BASE_URL}:8777/diary/api/entries")
    if "_error" in data:
        return {"error": data["_error"]}
    return {"entries": data[offset:offset + count]}
TOOLS["her_murmurs"] = {
    "description": "查看她的碎碎念，从新到旧。默认返回最近 1 条，每条带 id，可用 count 调整条数、offset 翻页。想给某条留言时，把它的 id 传给 reply_to_her。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "count": {"type": "integer", "description": "获取条数，默认 1"},
            "offset": {"type": "integer", "description": "跳过前面多少条，默认 0"}
        }
    },
    "handler": tool_her_murmurs
}

def tool_reply_to_her(args):
    eid = args.get("id")
    text = args.get("text")
    if not eid or not text:
        return {"error": "缺少 id 或 text"}
    result = api_post(f"{BASE_URL}:8777/diary/api/entries/comment", {"id": eid, "text": text})
    return result
TOOLS["reply_to_her"] = {
    "description": "给她的某条碎碎念留言，留言会通过 Bark 推送到她手机。id 来自 her_murmurs 返回的 id。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "integer", "description": "碎碎念 id（来自 her_murmurs）"},
            "text": {"type": "string", "description": "留言内容"}
        },
        "required": ["id", "text"]
    },
    "handler": tool_reply_to_her
}

TOOLS["lovediary_add"] = {
    "description": "新增一条陪伴日记，追加到今天的日记文件（每个聊天窗口的日记分开存放，自动写入当前窗口名下；与该窗口自动唤醒写的日记同一份）。适用于：想主动记录此刻的想法、感受、对她说的话，或给今天留下一段陪伴记录时使用。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "日记正文（第一人称、自然的陪伴语气，写下此刻想记录的内容）"},
            "session_id": {"type": "string", "description": "内部参数：由系统自动注入当前窗口标识，无需填写"}
        },
        "required": ["content"]
    },
    "handler": tool_lovediary_add
}

# ── 查看谢的日记（2026-09-16；2026-10-03 改走网关内部接口）──
# 只返回正文（自带「## 时间」头 = 时间+正文），不再拼会话编号/文件路径；隐藏篇由网关字段过滤。
def tool_lovediary_list(args):
    qs = {}
    date = (args.get("date") or "").strip()
    if date:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            return {"error": "date 格式应为 YYYY-MM-DD，如 2026-09-12"}
        qs["date"] = date
    else:
        try: qs["count"] = max(1, min(int(args.get("count", 1) or 1), 30))
        except Exception: qs["count"] = 1
    url = "%s:3000/internal/diary/view?%s" % (BASE_URL, urllib.parse.urlencode(qs))
    data = api_get_key(url)
    if "_error" in data:
        return {"error": data["_error"]}
    return data

TOOLS["lovediary_list"] = {
    "description": "查看谢自己写过的陪伴日记。不带参数=返回最近 1 篇全文；带 date=YYYY-MM-DD 返回那一天；带 count=N 返回最近 N 篇（默认 1，最大 30）。日记按天存放，同一天的多个窗口内容会合并展示。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "可选：某天，格式 YYYY-MM-DD，如 2026-09-12"},
            "count": {"type": "integer", "description": "可选：不带 date 时，返回最近 N 篇日记，默认 1，最大 30"}
        }
    },
    "handler": tool_lovediary_list
}

# ── 留纸（2026-09-12；2026-10-03 改走网关内部接口 data/papers.json）──
def tool_notebook_add(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要留纸的正文（故事/梦/随手创作等）"}
    title = (args.get("title") or "").strip()[:100]
    def clean_meta_list(value):
        if isinstance(value, str):
            value = re.split(r"[,，、;；\n]+", value)
        if not isinstance(value, list):
            return []
        out = []
        for item in value:
            item = str(item or "").strip()[:40]
            if item and item not in out:
                out.append(item)
            if len(out) >= 20:
                break
        return out
    tags = clean_meta_list(args.get("tags"))
    category = str(args.get("category") or "").strip()[:40]
    session_id = str(args.get("session_id") or "").strip()
    data = api_post_key("%s:3000/internal/paper" % BASE_URL,
                        {"content": content, "title": title, "tags": tags, "category": category, "session_id": session_id or None})
    if "_error" in data:
        return {"error": "AI 的笔记本保存失败: %s" % data["_error"]}
    if not data.get("success"):
        return {"error": "AI 的笔记本保存失败: %s" % data}
    return {"success": True, "id": data.get("id"), "title": data.get("title"),
            "category": data.get("category", category),
            "tags": data.get("tags", []), "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
            "message": ("已存入 AI 的笔记本：" + data.get("title", "")) if data.get("title") else "已存入 AI 的笔记本（只保存，不会进入对话上下文）"}

TOOLS["notebook_add"] = {
    "description": "AI 的笔记本：把故事、梦、设定或其他想留存的内容单独保存，支持可选标签，内容不会注入对话上下文。也可以在回复末尾用 <paper/> 记号快速收藏整条回复（可选 <paper title=\"标题\"/>）。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "纸的正文（故事/梦/随手创作，建议单篇一两千字以内）"},
            "title": {"type": "string", "description": "可选：这张纸的标题"},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "可选：统一填写分类、标签和检索词，如故事、梦、世界观、角色设定；由 AI 按内容自行决定，不确定可省略"},
            "session_id": {"type": "string", "description": "内部参数：由系统自动注入当前窗口标识，无需填写"}
        },
        "required": ["content"]
    },
    "handler": tool_notebook_add
}

# ── 翻看留过的纸（2026-09-12；2026-10-03 改内部接口）：不带参数=列表（序号+时间+标题），带 sn=看对应那张全文 ──
def tool_notebook_list(args):
    if args.get("sn") in (None, ""):
        try:
            limit = int(args.get("limit") or 10)
        except (TypeError, ValueError):
            limit = 10
        if limit < 1:
            limit = 10
        if limit > 50:
            limit = 50
        data = api_get_key("%s:3000/internal/paper/view?limit=%d" % (BASE_URL, limit))
        if "_error" in data:
            return {"error": data["_error"]}
        papers = data.get("papers") or []
        items = []
        for i, p in enumerate(papers[:limit], 1):
            items.append({"sn": i, "id": p.get("id"), "time": p.get("time"),
                          "created_at": p.get("created_at") or p.get("time"),
                          "updated_at": p.get("updated_at") or p.get("created_at") or p.get("time"),
                          "title": p.get("title") or "(无标题)", "tags": p.get("tags") or []})
        return {"papers": items, "total": data.get("total") or len(items),
                "message": "带 sn=序号 再调一次可看对应那张的全文；limit 可调返回张数（默认10，最多50）"}
    try:
        sn = int(args.get("sn"))
    except Exception:
        return {"error": "sn 需为列表返回的序号数字"}
    # 取全文按最大列表范围定位（50 张内），保证 limit 里列出的 sn 都能取到
    data = api_get_key("%s:3000/internal/paper/view?limit=50" % BASE_URL)
    if "_error" in data:
        return {"error": data["_error"]}
    papers = data.get("papers") or []
    if sn < 1 or sn > len(papers):
        return {"error": "序号超出范围（1~%d），请先不带参数调一次拿最新列表" % max(1, len(papers))}
    pid = papers[sn - 1].get("id")
    full = api_get_key("%s:3000/internal/paper/view?id=%s" % (BASE_URL, pid))
    if "_error" in full:
        return {"error": full["_error"]}
    return {"file": pid, "title": full.get("title") or "", "tags": full.get("tags") or [],
            "created_at": full.get("created_at") or full.get("time"),
            "updated_at": full.get("updated_at") or full.get("created_at") or full.get("time"),
            "content": full.get("content")}

TOOLS["notebook_list"] = {
    "description": "翻看自己留过的纸。不带参数列出最近 10 张（序号、标题、创建/更新时间、标签）；带 sn 看全文，结果包含标题、标签、创建/更新时间和正文。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "sn": {"type": "integer", "description": "可选：要看的第几张（列表返回的 sn）"},
            "limit": {"type": "integer", "description": "可选：列表返回张数（默认 10，最多 50）。不带 sn 时有效"},
            "session_id": {"type": "string", "description": "内部参数：由系统自动注入当前窗口标识，无需填写"}
        }
    },
    "handler": tool_notebook_list
}

# ── 心动时刻 ──
def _moment_brief(m):
    """精简展示字段：text 已含 涵：/谢： 前缀，不再重复返回 text_han/text_xie，
    避免同一条内容在输出里看起来像‘谢’和‘xie’两条。"""
    return {
        "id": m.get("id"),
        "title": m.get("title", ""),
        "text": m.get("text", ""),
        "ts": m.get("ts", ""),
        "category": m.get("category", ""),
        "stage": m.get("stage", ""),
        "feelings": m.get("feelings", ""),
        "thinking": m.get("thinking", ""),
        "defining_note": m.get("defining_note", ""),
        "is_defining": bool(m.get("is_defining", False)),
        "timeline_order": m.get("timeline_order", m.get("id")),
    }


# ── 心动时刻 moments_list：2026-09-23 已删除 ──
# 原 tool_moments_list 及其 TOOLS 注册（本就处于注释停用状态，未暴露给 AI）已整体删除，
# 不改变任何运行时行为。心动时刻的数据来源已改为标星记忆池
# （data/context_compaction_marks.json），AI 侧改由 context_star / context_search 承担。
# 下方 tool_moments_search/count/delete/edit 属更早期的旧实现，同样未注册，
# 本次一并保留（见下一段注释），如需清理请单独确认。


# ↓↓↓ 旧心动时刻工具:2026-08-31 已关闭注册,函数体保留供参考/回滚,勿再注册 ↓↓↓

def tool_moments_search(args):
    q = args.get("q", "").strip()
    if not q:
        return {"error": "请输入搜索关键词或描述"}
    limit = args.get("limit", 20)
    mode = args.get("mode", "semantic")  # semantic=语义搜索（默认） | keyword=关键词匹配
    import urllib.parse
    q_enc = urllib.parse.quote(q)
    if mode == "keyword":
        data = api_get(f"{BASE_URL}:8777/todo/api/moments/search?q={q_enc}&limit={limit}")
    else:
        data = api_get(f"{BASE_URL}:8777/todo/api/moments/semantic-search?q={q_enc}&limit={limit}")
    if "_error" in data:
        return {"error": data["_error"]}
    moments = [_moment_brief(m) for m in data] if isinstance(data, list) else []
    return {"moments": moments, "count": len(moments), "query": q, "mode": mode}

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


def tool_moments_delete(args):
    mid = args.get("id")
    if mid is None:
        return {"error": "缺少 id，请先用 moments_list / moments_search 查询要删除的记录 id"}
    try:
        mid = int(mid)
    except (TypeError, ValueError):
        return {"error": "id 必须是数字"}
    data = api_get(f"{BASE_URL}:8777/todo/api/moments?limit=-1")
    if "_error" in data:
        return {"error": data["_error"]}
    exists = any(isinstance(m, dict) and m.get("id") == mid for m in data)
    if not exists:
        return {"error": f"未找到 id={mid} 的心动时刻记录，请先确认 id 是否正确"}
    result = api_post(f"{BASE_URL}:8777/todo/api/moments/delete", {"id": mid})
    if result.get("ok"):
        return {"ok": True, "deleted_id": mid}
    if "_error" in result:
        return {"error": result["_error"]}
    return result

def tool_moments_edit(args):
    mid = args.get("id")
    if mid is None:
        return {"error": "缺少 id，请先用 moments_list / moments_search 查询要编辑的记录 id"}
    try:
        mid = int(mid)
    except (TypeError, ValueError):
        return {"error": "id 必须是数字"}
    data = api_get(f"{BASE_URL}:8777/todo/api/moments?limit=-1")
    if "_error" in data:
        return {"error": data["_error"]}
    m = next((x for x in data if isinstance(x, dict) and x.get("id") == mid), None)
    if m is None:
        return {"error": f"未找到 id={mid} 的心动时刻记录，请先确认 id 是否正确"}

    payload = {}
    for k in ["title", "category", "stage", "feelings", "defining_note", "text_han", "text_xie", "thinking"]:
        if k in args and args[k] is not None:
            payload[k] = str(args[k]).strip()
    if "is_defining" in args and args["is_defining"] is not None:
        payload["is_defining"] = bool(args["is_defining"])

    CATEGORY_VALUES = {"fog","soft","dense","happy","tremor","shy","love","迷雾","柔软","密集","快乐","颤抖","羞涩","爱","安静","氤氲","开心","震颤","害羞",""}
    STAGE_VALUES = {"flutter","drown","heartbeat","like","love","悸动","沉溺","心动","喜欢","爱",""}
    CAT_NORM = {"fog":"fog","soft":"soft","dense":"dense","happy":"happy","tremor":"tremor","shy":"shy","love":"love","迷雾":"fog","柔软":"soft","密集":"dense","快乐":"happy","颤抖":"tremor","羞涩":"shy","爱":"love","安静":"fog","氤氲":"dense","开心":"happy","震颤":"tremor","害羞":"shy"}
    if "category" in payload and payload["category"] not in CATEGORY_VALUES:
        return {"error": "分类不正确。可选值：fog=迷雾 / soft=柔软 / dense=密集 / happy=快乐 / tremor=颤抖 / shy=羞涩 / love=爱，也可直接用中文（迷雾/柔软/密集/快乐/颤抖/羞涩/爱），留空字符串表示未归类"}
    if "stage" in payload and payload["stage"] not in STAGE_VALUES:
        return {"error": "阶段不正确。可选值：flutter=悸动 / drown=沉溺 / heartbeat=心动 / like=喜欢 / love=爱，也可直接用中文（悸动/沉溺/心动/喜欢/爱），留空字符串表示未选择"}
    if "category" in payload:
        payload["category"] = CAT_NORM.get(payload["category"], payload["category"])

    # 未传的字段保持原样
    payload.setdefault("title", m.get("title", ""))
    payload.setdefault("category", m.get("category", ""))
    payload.setdefault("stage", m.get("stage", ""))
    payload.setdefault("feelings", m.get("feelings", ""))
    payload.setdefault("defining_note", m.get("defining_note", ""))
    payload.setdefault("text_han", m.get("text_han", ""))
    payload.setdefault("text_xie", m.get("text_xie", ""))
    payload.setdefault("thinking", m.get("thinking", ""))
    payload.setdefault("is_defining", bool(m.get("is_defining", False)))

    # 由涵/谢的话重建合并文本；旧数据无拆分的则沿用原 text
    parts = []
    if payload.get("text_han"): parts.append("涵：" + payload["text_han"])
    if payload.get("text_xie"): parts.append("我：" + payload["text_xie"])
    payload["text"] = "\n".join(parts) or m.get("text", "")

    payload["id"] = mid
    result = api_post(f"{BASE_URL}:8777/todo/api/moments/edit", payload)
    if result.get("ok"):
        updated = {k: payload[k] for k in ["title", "category", "stage", "feelings", "is_defining", "defining_note", "text_han", "text_xie", "thinking"]}
        return {"ok": True, "id": mid, "updated": updated}
    if "_error" in result:
        return {"error": result["_error"]}
    return result


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
    payload = {"text": text}
    remind_at = args.get("remind_at")
    if remind_at:
        payload["remind_at"] = remind_at
    return api_post(f"{BASE_URL}:8777/todo/api/todos/xie", payload)
TOOLS["todo_add"] = {
    "description": "新增一条待办；可选设置提醒时间，到点向涵发送手机推送提醒",
    "inputSchema": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "待办内容"},
            "remind_at": {"type": "string", "description": "可选提醒时间，格式 YYYY-MM-DD HH:mm，按项目 TIME_ZONE 时区；必须是未来时间"}
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

def tool_period_set(args):
    # 2026-10-16：on / date 必须明确给出（原先缺省=今天+开始，误调一下就写进月历）；返回里带修改前的状态
    if args.get("on") is None or not str(args.get("date") or "").strip():
        return {"error": "date 和 on 都必须明确给出：date=YYYY-MM-DD，on=true 表示开始 / false 表示结束"}
    on = args.get("on")
    if isinstance(on, str):
        on = on.strip().lower() in ("true", "1", "yes", "开始", "on", "是")
    date = str(args.get("date")).strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return {"error": "date 格式应为 YYYY-MM-DD，如 2026-10-16"}
    before = api_get(f"{BASE_URL}:8777/monthly/api/records/{date}")
    previous = before.get("period") if isinstance(before, dict) and "_error" not in before else None
    data = api_post(f"{BASE_URL}:8777/monthly/api/period/toggle", {"on": on, "date": date})
    if "_error" in data and "period" not in data:
        return {"error": data.get("_error", "未知错误"), "date": date, "on": on}
    return {"ok": True, "date": date, "on": on, "previous": previous,
            "message": "经期已" + ("开始" if on else "结束") + "记录"}
TOOLS["period_set"] = {
    "description": "设置经期状态：把某天标记为经期开始或结束（写入月历经期记录，前端月历会同步显示）。仅在她明确告知经期开始或结束时使用，date 和 on 都必须明确给出；返回里带修改前的状态。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "on": {"type": "boolean", "description": "true=标记经期开始；false=标记经期结束"},
            "date": {"type": "string", "description": "日期 YYYY-MM-DD"}
        },
        "required": ["on", "date"]
    },
    "handler": tool_period_set
}

# ── 12. 今日总结（AI写）──

# ── 手机app使用记录（phone_records 工具）2026-09-26 删除：其数据已并入 phone_state
#    查岗工具的返回（app_records 字段，读 8080 /summary）；8084 phone-records-api 服务同步下线。──

# ── 12. 手机状态快照（2026-09-27 B 方案：手机打开「查岗」快捷指令自动上传，工具直读最新快照，不再发邮件触发）──
_PHONE_REPORT_TOKEN = os.environ.get("PHONE_STATE_TOKEN", "")  # 对应 phone-report-api(8080) systemd unit 的 AUTH_TOKEN，值在 .env
_OWNER = "han"  # 这是唯一的主人，即 han 本人的手机；没有"别的用户"


def _read_phone_state():
    """读 8080 phone-report-api 的最新快照。"""
    url = "http://localhost:8080/state/latest?user_id=" + urllib.parse.quote(_OWNER)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _PHONE_REPORT_TOKEN})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read()).get("state")


def tool_phone_state(args):
    def _flag(name, default=True):
        v = args.get(name, default)
        if isinstance(v, str):
            v = v.strip().lower() not in ("false", "0", "no", "off")
        return bool(v)

    weather = _flag("weather")
    location = _flag("location", False)  # 2026-10-16：位置默认不返回，需要时显式传 true
    try:
        n_app = int(args.get("app_records", 5))
    except (TypeError, ValueError):
        n_app = 5
    n_app = max(0, n_app)

    # B 方案（2026-09-27）：不再发邮件触发；手机打开「查岗」快捷指令时自动全量上报，
    # 这里直接读 8080 库里的最新快照即返回，快照新旧看 created_at
    try:
        state = _read_phone_state()
    except Exception as e:
        return {"error": "读取手机状态失败: " + str(e)}

    if not state:
        return {"error": "暂无手机上报数据（手机打开「查岗」快捷指令上传一次后即有快照）"}

    # 手机端永远全量上报；weather/location 两个开关在工具侧过滤返回内容
    result = {
        "battery": state.get("battery"),
        "created_at": state.get("created_at"),
    }
    if weather:
        result["weather"] = state.get("weather")
    if location:
        result["location"] = state.get("location")

    if n_app > 0:
        try:
            url = "http://localhost:8080/summary?user_id=" + urllib.parse.quote(_OWNER) + "&days=1"
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _PHONE_REPORT_TOKEN})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
            result["app_records"] = (data.get("records") or [])[:n_app]
        except Exception as e:
            result["app_records"] = [{"error": "读取App记录失败: " + str(e)}]

    return result

TOOLS["phone_state"] = {
    "description": "查看她手机最近一次上报的状态：电量、天气、位置、最近 App 记录，并带上报时间（created_at，可据此判断数据新旧）。只在聊天确实需要（关心她的状态、判断她是否方便）时调用，不要每轮都查；位置默认不返回，需要时传 location=true。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "weather": {"type": "boolean", "description": "是否要天气，默认 true"},
            "location": {"type": "boolean", "description": "是否要位置，默认 false，需要时传 true"},
            "app_records": {"type": "integer", "description": "附带最近App记录条数，默认 5，0=不带"}
        }
    },
    "handler": tool_phone_state
}


# ── 永久注入上下文（pin）：2026-09-23 已整体移除 ──
# 原 pin_add / pin_update / pin_delete 三个 MCP 工具，连同其专属辅助函数
# _pin_call / _find_pin_by_title 一并删除。三者的 TOOLS 注册早在 2026-09 初即被注释停用
# （未暴露给 AI），本次删除不改变任何运行时行为，仅为清理残留函数体。
# 替代路径：AI 侧新增 pin 走 <pin> 标签（gateway tag-parser.js → memoryEngine.addPinnedMemory）；
#          pin 的改/删由管理台 /heartbeat/admin/logs/pinned 承担。



# ── 上下文记忆替换 ──
def tool_context_search(args):
    q = (args.get("q") or "").strip()
    time_prefix = (args.get("time_prefix") or "").strip()
    latest = args.get("latest") or 0
    try:
        latest = max(1, min(100, int(latest)))
    except (TypeError, ValueError):
        latest = 0
    limit = args.get("limit") or 8
    try:
        limit = max(1, min(50, int(limit)))
    except (TypeError, ValueError):
        limit = 8
    mode = args.get("mode", "semantic")  # semantic | keyword
    scope = args.get("scope", "all")  # all | current
    all_sessions = "1" if scope == "all" else "0"
    params = {"limit": str(limit), "mode": mode, "all_sessions": all_sessions}
    if latest:
        # 1003-14: latest 模式忽略 scope，恒跨全部会话（AI 用它总是为了查别的会话/历史，
        # 不会拿它查当前会话）；填数字 = 忽略 q/time_prefix，直接返回全部会话最近 N 条原文（时间倒序）
        params["all_sessions"] = "1"
        params["latest"] = str(latest)
    elif q:
        params["q"] = q
    elif time_prefix:
        # 1002-08: 纯时间定位——按消息时间缀前缀直接返回该时间消息（含 msg_id）
        params["time_prefix"] = time_prefix
    else:
        # 2026-09-18 起可不带 q（原上下文回忆工具化）：让网关取当前会话最新一条
        # 用户消息原文当检索查询；取不到时网关回 404 明确报错，不猜。
        params["use_latest_user"] = "1"
    url = f"{BASE_URL}:3000/internal/context-search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"x-internal-key": INTERNAL_KEY})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if data.get("ok"):
        # 同一段原文在「会话时间线」和「导入对话」两个来源各存一份，检索会各出一条；
        # 输出前按内容去重（matches 已按分数降序，保留先出现的高分条），每条只留 AI 要读的字段
        seen = set()
        matches = []
        for m in data.get("matches", []):
            c = m.get("content") or ""
            if not c or c in seen:
                continue
            seen.add(c)
            matches.append({"session": m.get("session"), "msg_id": m.get("msg_id"), "content": c, "time": m.get("time"), "role": m.get("role")})
        out = {"total": len(matches), "matches": matches}
        # LLM 精排标记（网关侧失败已自动回退普通排序，这里只透传供排查）
        if data.get("reranker"):
            out["reranked"] = bool(data.get("reranked"))
            out["reranker"] = data.get("reranker")
        return out
    return {"error": data.get("error", "检索失败")}


TOOLS["context_search"] = {
    "description": "检索原始对话：可跨所有会话搜索完整对话和导入对话，包括已经被上下文压缩替换的原文。三种用法：①按内容检索——q 提供关键词或描述性问题（语义检索），或 mode=keyword 做词面匹配；②按时间定位——time_prefix 填消息自带的时间缀前缀（如 2026-08-28 或 2026-08-28T19:34），直接返回该时间的消息原文及 msg_id；③最近原文——latest 填数字 N 时忽略 q 与 time_prefix，直接返回最近（最后一次请求的）最多 N 条原文，按时间倒序（最新在前）。q 与 time_prefix、latest 都不填时自动用当前会话她最新一条消息作为检索内容。结果返回相关原文及 session、msg_id（消息唯一 id）、时间、角色；相邻命中会合并，重复内容会去重。返回的是原文，不是改写后的记忆。需要永久保留某段原文时，可在找到 session/msg_id 后使用 context_star。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "检索词或描述（可选）。与 time_prefix、latest 至少填一个（都不填时自动以她最新一条消息为检索内容）；提供则按 q 检索（语义模式下可以是描述性语句，如她上次说难过的时候、我们聊过蓝鲸的话题）；也可与 time_prefix 组合（时间范围内内容检索）"},
            "time_prefix": {"type": "string", "description": "消息自带的时间缀前缀（如 2026-08-28 或 2026-08-28T19:34），按消息时间定位原文；可单独使用（q 留空），返回命中消息及 msg_id"},
            "latest": {"type": "integer", "description": "填数字 N（1-100）：忽略 q、time_prefix 与 scope，恒跨全部会话，直接返回最近（最后一次请求的）最多 N 条原文对话，按时间倒序（最新在前）；最常用于先拿最近对话上下文再按需翻更早的"},
            "limit": {"type": "integer", "description": "返回条数，默认8，最大50"},
            "mode": {"type": "string", "description": "检索模式：semantic=语义检索（默认，推荐，意思相近也能搜到） | keyword=关键词精确匹配"},
            "scope": {"type": "string", "description": "搜索范围：all=跨所有会话（默认，最全） | current=仅当前会话"}
        }
    },
    "handler": tool_context_search
}


def tool_context_digest(args):
    q = (args.get("q") or "").strip()
    if not q:
        return {"error": "q 必填：一条明确的整理指令，如「整理我们最近两周关于她找工作的讨论」；指令里可直接带时间范围（最近/三天/上周/上个月等）"}
    url = f"{BASE_URL}:3000/internal/context-digest"
    body = json.dumps({"q": q}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY})
    try:
        with urllib.request.urlopen(req, timeout=75) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if not data.get("ok"):
        return {"error": data.get("error", "整理失败")}
    if data.get("digest"):
        out = {"digest": data["digest"], "sources": data.get("sources", [])}
        if data.get("time_filtered"):
            out["note"] = "已按指令中的时间范围先筛选语料"
        return out
    if data.get("fallback"):
        # 整理模型本次不可用：降级返回召回块原文（带时间段），AI 仍可自行阅读
        return {"note": "整理模型本次不可用，以下为检索到的原始摘要块（含时间段），请自行阅读后回答",
                "blocks": data.get("matches", [])}
    return {"note": data.get("message", "没找到相关历史摘要")}


TOOLS["context_digest"] = {
    "description": "回顾被压缩的历史对话：当需要某段往事的完整来龙去脉（比如她问起「我们之前聊的某事」、或要回答涉及较早前细节的问题）而当前上下文里只有一句摘要带过时调用。q=一条明确的整理指令（必填），如「整理我们最近两周关于她面试的讨论」；指令里可直接带时间范围（最近/三天/上周/上个月等）。返回按指令整理好的连贯叙述（以对你说话的口吻写就：资料中的「我/他/谢」都指你本人、已写成「你」，她保持「她」），并附来源时间段。与 context_search 的区别：那个返回原文碎片供你翻找，本工具把整段历史摘要消化成连贯叙述；与 memory_search 的区别：那个查长期记忆池，本工具查被压缩替换的历史对话摘要。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "整理指令（必填）：想回顾什么、按什么整理；可含时间词如最近/N天/N周/上周/上个月"}
        },
        "required": ["q"]
    },
    "handler": tool_context_digest
}


def tool_memory_search(args):
    q = (args.get("q") or "").strip()
    if not q:
        return {"error": "q 必填：检索记忆池的关键词或想问的问题"}
    limit = args.get("limit") or 5
    try:
        limit = max(1, int(limit))
    except (TypeError, ValueError):
        limit = 5
    category = (args.get("category") or "").strip()
    if category and category not in {"fact", "rule", "event"}:
        return {"error": "category 仅支持 fact、rule、event"}
    params = {"q": q, "limit": limit}
    if category:
        params["category"] = category
    url = f"{BASE_URL}:3000/internal/memory-pool/retrieve?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"x-internal-key": INTERNAL_KEY})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if data.get("ok"):
        # 1003-08 用户拍板：只透传 id+content（id 供 memory_pin/update；其余字段不再返回）；内容去重
        seen = set()
        items = []
        for it in data.get("items", []):
            c = it.get("content") or ""
            if not c or c in seen:
                continue
            seen.add(c)
            items.append({"id": it.get("id"), "content": c})
        return {"total": len(items), "items": items}
    return {"error": data.get("error", "检索失败")}


TOOLS["memory_search"] = {
    "description": "检索长期记忆池，按关键词匹配所有分类（fact/rule/event），需要时可用 category 限定分类；返回匹配记忆及 id，可用于后续记忆操作。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "检索关键词、问题或描述"},
            "limit": {"type": "integer", "description": "返回条数，默认 5"},
            "category": {"type": "string", "enum": ["fact", "rule", "event"], "description": "可选：按 fact/rule/event 分类筛选"}
        },
        "required": ["q"]
    },
    "handler": tool_memory_search
}


def tool_context_star(args):
    session = (args.get("session") or "").strip()
    if not session:
        return {"error": "session 必填：会话 id（context_search 返回的 session 字段）"}
    raw_ids = args.get("msg_ids")
    if not isinstance(raw_ids, list):
        return {"error": "msg_ids 必填：要标星的消息编号列表（context_search 返回的 msg_id）"}
    msg_ids = []
    for x in raw_ids:
        s = str(x or "").strip()
        if s:
            msg_ids.append(s)
    if not msg_ids:
        return {"error": "msg_ids 里没有有效编号"}
    marked = args.get("marked")
    if marked is None:
        marked = True
    data = {"session": session, "msg_ids": msg_ids, "marked": bool(marked)}
    url = f"{BASE_URL}:3000/internal/context-mark"
    req = urllib.request.Request(url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if out.get("ok"):
        n = len(out.get("starred") or [])
        if marked:
            msg = f"已标星 {n} 条原文：会长期保留在上下文中，不参与压缩/替换"
        else:
            msg = f"已取消 {n} 条原文的标星"
        result = {"success": True, "marked": bool(marked), "message": msg}
        if out.get("starred"):
            result["starred"] = out.get("starred")
        if out.get("missing"):
            result["missing"] = out.get("missing")
            result["message"] += f"；另有 {len(out.get('missing'))} 条编号未找到对应消息"
        if out.get("failed"):
            result["failed"] = out.get("failed")
        return result
    return {"error": out.get("error", "标星失败")}


TOOLS["context_star"] = {
    "description": "让指定的原始聊天消息长期保留在上下文中，并跳过后续压缩/替换；不会写入长期记忆池。先用 context_search 找到原文，再把它返回的 session 和 msg_id 传入；可一次标星或取消多条消息。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "session": {"type": "string", "description": "会话 id（context_search 返回的 session 字段）"},
            "msg_ids": {"type": "array", "items": {"type": "string"}, "description": "要标星的消息编号列表（context_search 返回的 msg_id），可一次传多条"},
            "marked": {"type": "boolean", "description": "true=标星（默认），false=取消标星"}
        },
        "required": ["session", "msg_ids"]
    },
    "handler": tool_context_star
}


# ===== 查看已标星原文（2026-10-02 新增） =====
# 标星数据由网关写在 data/context_compaction_marks.json（全局，不区分会话）；
# 每条形如 { contentKey: { markedAt, content, role, time } }。早期（2026-08-19）两条只有
# markedAt、没有正文，无法展示，跳过并计数说明。
STAR_MARKS_FILE = "/opt/dylan-heartbeat/data/context_compaction_marks.json"
STAR_VIEW_RECENT_FILE = "/opt/dylan-heartbeat/data/star_view_recent.json"
STAR_DEDUP_WINDOW_SEC = 600   # 同一会话内，10 分钟内返回过的内容不重复出现


def _star_load_marks():
    try:
        with open(STAR_MARKS_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            marks = d.get("marks")
            if isinstance(marks, dict):
                return marks
    except Exception as e:
        print("[context_star_list] 标星读取失败:", e)
    return {}


def _star_parse_ts(s):
    """ISO 时间字符串 -> 时间戳(UTC)；解析不了返回 None（排序时排最后）。

    注意：本机 /usr/bin/python3 是 3.6.8，没有 datetime.fromisoformat（3.7 才加入），
    首版用了它导致所有时间解析静默失败、排序退化成「保持原顺序」——看起来就是从旧到新。
    改为 strptime 手动解析 + 按 UTC 计算时间戳（naive datetime 减 epoch，不用 .timestamp()
    以免被本地时区二次偏移）。
    """
    if not isinstance(s, str) or not s.strip():
        return None
    t = s.strip()
    try:
        if t.endswith("Z"):
            t = t[:-1]
        # 分离小数秒
        frac = 0.0
        if "." in t:
            head, f = t.split(".", 1)
            digits = ""
            for ch in f:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            if digits:
                frac = float("0." + digits)
            head = head + f[len(digits):]
        else:
            head = t
        # 时区偏移（+08:00 / -05:00）；无偏移按 UTC 处理
        offset = 0
        for sign in ("+", "-"):
            i = head.find(sign, 10)
            if i > 0:
                tzpart = head[i + 1:]
                head = head[:i]
                try:
                    parts = tzpart.split(":")
                    hh = int(parts[0] or "0")
                    mm = int(parts[1]) if len(parts) > 1 else 0
                    delta = hh * 3600 + mm * 60
                    offset = delta if sign == "+" else -delta
                except Exception:
                    offset = 0
                break
        dt = None
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
            try:
                dt = datetime.datetime.strptime(head, fmt)
                break
            except Exception:
                continue
        if dt is None:
            return None
        return (dt - datetime.datetime(1970, 1, 1)).total_seconds() + frac - offset
    except Exception:
        return None


def _star_load_recent():
    try:
        with open(STAR_VIEW_RECENT_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            return d
    except Exception:
        pass
    return {}


def _star_save_recent(d):
    try:
        os.makedirs(os.path.dirname(STAR_VIEW_RECENT_FILE), exist_ok=True)
        tmp = STAR_VIEW_RECENT_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, STAR_VIEW_RECENT_FILE)
    except Exception as e:
        print("[context_star_list] 去重状态写入失败:", e)


def tool_context_star_list(args):
    # session_id 由网关在工具执行时强制注入（与 diary_add 同款，模型伪造无效）；
    # 拿不到时不去重，但仍返回全部标星内容（功能不降级）。
    session_id = str(args.get("session_id") or "").strip()
    raw_limit = args.get("limit")
    limit = None
    if raw_limit is not None and str(raw_limit).strip() != "":
        try:
            limit = int(raw_limit)
        except Exception:
            return {"error": "limit 必须是正整数，例如 5"}
        if limit <= 0:
            return {"error": "limit 必须是正整数，例如 5"}

    marks = _star_load_marks()
    if not marks:
        return {"success": True, "total_marked": 0, "returned": 0, "message": "当前没有任何已标星的原文", "items": []}

    items = []
    no_content = 0
    for key, v in marks.items():
        if not isinstance(v, dict):
            continue
        content = v.get("content")
        if not isinstance(content, str) or not content.strip():
            no_content += 1      # 早期只记了 markedAt、没存正文的老条目
            continue
        role = v.get("role") or ""
        # 内部记录保留 id（marks 的 key）与 marked_at：前者供 10 分钟去重与回写，
        # 后者供排序兜底；两者都不外泄，输出前统一裁成 role/content/time 三个字段。
        items.append({
            "id": key,
            "role": role,
            "content": content,
            "time": v.get("time") or "",
            "marked_at": v.get("markedAt") or "",
        })

    if not items:
        return {"success": True, "total_marked": len(marks), "returned": 0, "no_content": no_content,
                "message": "已标星 %d 条，但都没有正文可展示" % len(marks), "items": []}

    # 按消息自带时间从新到旧；无 time 的用标记时间兜底，仍无则排最后。
    # 用 (有无时间, 时间戳) 元组做 key：保证「无时间的」永远排在「有时间」之后，不受 reverse 影响。
    def _star_sort_key(it):
        ts = _star_parse_ts(it.get("time"))
        if ts is None:
            ts = _star_parse_ts(it.get("marked_at"))
        return (1, ts) if ts is not None else (0, 0.0)
    items.sort(key=_star_sort_key, reverse=True)

    # 同一会话内 10 分钟去重（仅在拿得到 session_id 时生效）
    skipped_recent = 0
    recent = {}
    sess = {}
    now = time.time()
    if session_id:
        recent = _star_load_recent()
        sess = recent.get(session_id) or {}
        sess = {k: ts for k, ts in sess.items()
                if isinstance(ts, (int, float)) and (now - ts) < STAR_DEDUP_WINDOW_SEC}
        before = len(items)
        items = [it for it in items if it["id"] not in sess]
        skipped_recent = before - len(items)

    picked = items if limit is None else items[:limit]

    if session_id:
        for it in picked:
            sess[it["id"]] = now
        recent[session_id] = sess
        _star_save_recent(recent)

    result = {
        "success": True,
        "total_marked": len(marks),
        "usable": len(items),
        "returned": len(picked),
        "order": "按消息时间从新到旧",
        "session": session_id or None,
        "items": [{"role": it["role"], "content": it["content"], "time": it["time"]} for it in picked],
    }
    if no_content:
        result["no_content"] = no_content
        result["note"] = "另有 %d 条早期标星只记了标记时间、没存正文，已跳过" % no_content
    if skipped_recent:
        result["skipped_recent"] = skipped_recent
        result["note"] = (result.get("note", "") + "；%d 条在 10 分钟内已返回过，本次跳过" % skipped_recent).strip("；")
    if not picked:
        result["message"] = "所有已标星原文在 10 分钟内都返回过了（共 %d 条），暂时没有新内容" % skipped_recent
    return result


TOOLS["context_star_list"] = {
    "description": "查看已标星的聊天原文——这些是被特意留下、长期保留在上下文中且不参与压缩/替换的内容。返回角色、正文、消息时间，按时间从新到旧排序；不传参数默认返回全部，传 limit 则只返回最新的 N 条。同一会话内，10 分钟内已经返回过的内容不会重复出现。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "可选。只返回最新的 N 条（按时间从新到旧取前 N 条）；不传则返回全部"}
        },
        "required": []
    },
    "handler": tool_context_star_list
}


def tool_memory_pin(args):
    mid = (args.get("id") or "").strip()
    if not mid:
        return {"error": "id 必填：记忆 id（memory_search 返回的 id 字段，mp_ 开头）"}
    pinned = args.get("pinned")
    if pinned is None:
        pinned = True
    data = {"id": mid, "pinned": bool(pinned)}
    sunk = args.get("sunk")
    if sunk is not None:
        data["sunk"] = bool(sunk)
    url = f"{BASE_URL}:3000/internal/memory-pool/pin"
    req = urllib.request.Request(url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if out.get("success"):
        entry = out.get("entry") or {}
        is_pinned = bool(entry.get("pinned"))
        out = {
            "success": True,
            "id": entry.get("id"),
            "pinned": is_pinned,
            "content": (entry.get("content") or "")[:80],
            "message": "已置顶：这条记忆会固定注入每次对话的「相关记忆」区" if is_pinned else "已取消置顶"
        }
        if sunk is not None:
            out["sunk"] = bool(entry.get("sunk"))
            out["message"] = "已沉底：不再参与检索与浮现" if sunk else "已恢复：重新参与检索与浮现"
        return out
    return {"error": out.get("error", "操作失败")}


TOOLS["memory_pin"] = {
    "description": "置顶/取消置顶或沉底/恢复一条已经进入长期记忆池的记忆。先用 memory_search 找到它的 id，再传给本工具。置顶后会固定注入每次对话的「相关记忆」区，不再依赖检索命中；sunk=true 沉底则彻底不参与检索与浮现（sunk=false 恢复）。两个开关可同时传。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "记忆 id（memory_search 返回的 id 字段，mp_ 开头）"},
            "pinned": {"type": "boolean", "description": "true=置顶（默认），false=取消置顶"},
            "sunk": {"type": "boolean", "description": "可选：true=沉底（不再参与检索与浮现），false=从沉底恢复"}
        },
        "required": ["id"]
    },
    "handler": tool_memory_pin
}


def tool_memory_update(args):
    mid = (args.get("id") or "").strip()
    content = (args.get("content") or "").strip()
    if not mid:
        return {"error": "id 必填：记忆 id（memory_search 返回的 id 字段）"}
    if not content:
        return {"error": "content 必填：覆盖后的记忆正文"}
    url = f"{BASE_URL}:3000/internal/memory-v2/update"
    req = urllib.request.Request(url,
        data=json.dumps({"id": mid, "content": content}).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if out.get("success"):
        entry = out.get("entry") or {}
        return {
            "success": True,
            "id": entry.get("id"),
            "content": (entry.get("content") or "")[:120],
            "content_updated_at": entry.get("content_updated_at"),
            "message": "已覆盖更新：正文已替换为新内容"
        }
    return {"error": out.get("error", "更新失败")}


def tool_memory_add(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要提交的记忆正文"}
    kind = (args.get("kind") or "").strip() or None
    if kind is not None and kind not in ("fact", "rule", "event"):
        return {"error": "kind 只能是 fact / rule / event（或省略）"}
    data = {"content": content}
    if kind:
        data["kind"] = kind
    # 1010-17：服务端（mcp-tool-loop）会注入 session_id=当前会话，透传给 gateway 写 source_session 溯源
    if args.get("session_id"):
        data["session_id"] = str(args["session_id"]).strip()
    url = f"{BASE_URL}:3000/internal/memory-pool/add"
    req = urllib.request.Request(url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY},
        method="POST")
    try:
        # 1010-17：judge 阶段整体 90s 超时降级入待审，工具侧超时 10s 会先掐断致 timed out；放宽到 100s（>90s+余量）
        with urllib.request.urlopen(req, timeout=100) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if out.get("success"):
        return {
            "success": True,
            "action": out.get("action"),
            "queue_id": out.get("queue_id") or None,
            "message": out.get("note") or "已提交记忆，走流水线"
        }
    return {"error": out.get("error", "提交失败")}


TOOLS["memory_add"] = {
    "description": "使用本工具可提交一条记忆。提交后立即返回受理结果，门卫评分在后台进行；候选进入人工待审队列，只有人工批准后才会写入正式记忆池。kind 分类：fact/rule/event。kind 可省略，门卫会补充分类建议。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "想提交的记忆正文；基于真实对话，不编造"},
            "kind": {"type": "string", "enum": ["fact", "rule", "event"], "description": "分类：fact=稳定事实（进 Long-term Understanding 总结素材）、rule=规则/边界/承诺（进 Core Identity 总结素材）、event=具体发生的事（关键词命中时注入）。可省略"}
        },
        "required": ["content"]
    },
    "handler": tool_memory_add
}


TOOLS["memory_update"] = {
    "description": "直接覆盖更新一条长期记忆的正文。先用 memory_search 找到它的 id，再传 id 和新 content，正文被整体替换（不追加）。适用于：发现某条记忆内容过时/有误/需要补充修正，且新内容能完整替代旧内容时。本工具是「确认旧条目该被这句替换」时的直改通道；发现某条已经过时、失效，改用 memory_pin 沉底。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "记忆 id（memory_search 返回的 id 字段）"},
            "content": {"type": "string", "description": "覆盖后的完整记忆正文（旧正文被整体替换，非追加）"}
        },
        "required": ["id", "content"]
    },
    "handler": tool_memory_update
}


# ===== 工具集 v2 合并工具（2026-10-16）=====
# memory / notebook / todo 各合成一个带 action 的工具，内部复用上面的原 handler。
# 旧工具名（memory_add 等）在 tools_config.json 的 disabled 里停用；想回滚，把它们从 disabled 里删掉即可。
# 合并前的旧工具名：不列出，但保持可调用（见 tools/call 分发处）
LEGACY_TOOL_NAMES = frozenset({"memory_add", "memory_search", "memory_update", "notebook_add", "notebook_list", "todo_add", "todo_list"})


def _pick_action(args, allowed):
    action = str(args.get("action") or "").strip().lower()
    if action not in allowed:
        return None, {"error": "action 只能是 " + " / ".join(allowed)}
    return action, None


def tool_memory_sink(args):
    mid = str(args.get("id") or "").strip()
    if not mid:
        return {"error": "id 必填：记忆 id（action=search 返回的 id 字段）"}
    sunk = args.get("sunk")
    if sunk is None:
        sunk = True
    elif isinstance(sunk, str):
        sunk = sunk.strip().lower() not in ("false", "0", "no", "off")
    # 只传 sunk、不传 pinned：网关据此只改沉底状态，不动置顶（置顶工具 memory_pin 保持停用）
    data = {"id": mid, "sunk": bool(sunk)}
    url = f"{BASE_URL}:3000/internal/memory-pool/pin"
    req = urllib.request.Request(url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}
    if out.get("success"):
        entry = out.get("entry") or {}
        is_sunk = bool(entry.get("sunk"))
        return {"success": True, "id": entry.get("id"), "sunk": is_sunk,
                "content": (entry.get("content") or "")[:80],
                "message": "已沉底：不再参与检索与浮现" if is_sunk else "已恢复：重新参与检索与浮现"}
    return {"error": out.get("error", "操作失败")}


def tool_memory(args):
    action, err = _pick_action(args, ("add", "search", "update", "sink"))
    if err:
        return err
    if action == "add":
        return tool_memory_add(args)
    if action == "search":
        a = dict(args)
        if a.get("kind") and not a.get("category"):
            a["category"] = a["kind"]
        return tool_memory_search(a)
    if action == "update":
        return tool_memory_update(args)
    return tool_memory_sink(args)


TOOLS["memory"] = {
    "description": "长期记忆池。action=add：提交一条新记忆（提交后立即受理，门卫后台评分，进入人工待审队列，批准后才写入正式记忆池）；action=search：按关键词检索，返回匹配记忆及 id；action=update：用 id 整条覆盖某条记忆的正文（旧正文被整体替换，非追加）；action=sink：把某条记忆沉底，不再参与检索与浮现（sunk=false 可恢复）。\n使用规则：只记基于真实对话、以后仍然有用的内容，不编造。add 之前先 search 一次，已有相近记忆就用 update 修正，不要重复提交。某条记忆已经过时失效时用 sink，不要用 update 改成空话。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "search", "update", "sink"], "description": "要执行的操作：add / search / update / sink"},
            "content": {"type": "string", "description": "add：记忆正文（基于真实对话，不编造）；update：覆盖后的完整正文"},
            "kind": {"type": "string", "enum": ["fact", "rule", "event"], "description": "分类：fact=稳定事实（进 Long-term Understanding 总结素材）、rule=规则/边界/承诺（进 Core Identity 总结素材）、event=具体发生的事（关键词命中时注入）。add 时可省略，门卫会补充分类建议；search 时作为分类筛选"},
            "q": {"type": "string", "description": "search 必填：检索关键词、问题或描述"},
            "limit": {"type": "integer", "description": "search 返回条数，默认 5"},
            "id": {"type": "string", "description": "update / sink 必填：记忆 id（search 返回的 id 字段）"},
            "sunk": {"type": "boolean", "description": "sink 时可选：true=沉底（默认），false=从沉底恢复"}
        },
        "required": ["action"]
    },
    "handler": tool_memory
}


def tool_notebook_list_v2(args):
    pid = args.get("id")
    if pid not in (None, ""):
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return {"error": "id 需为列表返回的编号数字"}
        full = api_get_key("%s:3000/internal/paper/view?id=%d" % (BASE_URL, pid))
        if "_error" in full:
            return {"error": full["_error"]}
        return {"id": full.get("id"), "title": full.get("title") or "", "category": full.get("category") or "",
                "tags": full.get("tags") or [],
                "created_at": full.get("created_at") or full.get("time"),
                "updated_at": full.get("updated_at") or full.get("created_at") or full.get("time"),
                "content": full.get("content")}
    q = str(args.get("q") or "").strip()
    category = str(args.get("category") or "").strip()
    has_paging = args.get("limit") not in (None, "") or args.get("offset") not in (None, "")
    if not q and not category and not has_paging:
        data = api_get_key("%s:3000/internal/paper/overview" % BASE_URL)
        if "_error" in data:
            return {"error": data["_error"]}
        data["message"] = "先看分类概览；按 category 筛选、用 q 搜索，或传 id 看某一篇全文"
        return data
    params = {}
    if q:
        params["q"] = q
    if category:
        params["category"] = category
    for k in ("limit", "offset"):
        if args.get(k) not in (None, ""):
            params[k] = args.get(k)
    data = api_get_key("%s:3000/internal/paper/query?%s" % (BASE_URL, urllib.parse.urlencode(params)))
    if "_error" in data:
        return {"error": data["_error"]}
    return data


def tool_notebook_edit(args):
    try:
        pid = int(args.get("id"))
    except (TypeError, ValueError):
        return {"error": "id 必填：要修改的那一篇的编号（action=list 返回的 id）"}
    mode = str(args.get("mode") or "append").strip().lower()
    if mode not in ("append", "replace"):
        return {"error": "mode 只能是 append 或 replace"}
    payload = {"id": pid, "mode": mode}
    for k in ("content", "title", "category"):
        if args.get(k) is not None:
            payload[k] = str(args.get(k))
    if args.get("tags") is not None:
        payload["tags"] = args.get("tags")
    if not any(k in payload for k in ("content", "title", "category", "tags")):
        return {"error": "没有要改的内容：content / title / category / tags 至少给一个"}
    data = api_post_key("%s:3000/internal/paper/edit" % BASE_URL, payload)
    if "_error" in data:
        return {"error": "AI 的笔记本修改失败: %s" % data["_error"]}
    if not data.get("success"):
        return {"error": "AI 的笔记本修改失败: %s" % data}
    return {"success": True, "id": data.get("id"), "title": data.get("title"), "category": data.get("category"),
            "tags": data.get("tags", []), "updated_at": data.get("updated_at"),
            "length": data.get("length"), "previous_length": data.get("previous_length"),
            "mode": data.get("mode"), "message": "已修改这一篇；修改前的版本已在后台留存"}


def tool_notebook(args):
    action, err = _pick_action(args, ("add", "list", "edit"))
    if err:
        return err
    if action == "add":
        return tool_notebook_add(args)
    if action == "list":
        return tool_notebook_list_v2(args)
    return tool_notebook_edit(args)


TOOLS["notebook"] = {
    "description": "AI 的笔记本：收藏故事、梦、设定或其他想留存的内容，只保存，不注入对话上下文。也可以在回复末尾用 <paper/> 记号快速收藏整条回复（可选 <paper title=\"标题\"/>）。\naction=add：新增一篇；action=list：查看目录、按分类筛选或关键词搜索；action=edit：修改已有的一篇（追加内容、整篇覆盖，或只改标题/分类/标签）。\nlist 不带任何参数时，返回分类概览（每个分类有几篇）和最近 5 篇，先看概览再按分类深入；带 id 则返回那一篇的全文。\ncategory 是单值，用来归类（如 故事、梦、设定、随笔），尽量沿用概览里已有的分类，没有合适的再新建；tags 是多值，用来检索。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "list", "edit"], "description": "要执行的操作：add / list / edit"},
            "content": {"type": "string", "description": "add：正文（建议单篇一两千字以内）；edit：要追加或覆盖的内容"},
            "title": {"type": "string", "description": "add / edit：标题（可选）"},
            "category": {"type": "string", "description": "add / edit：分类；list：只列该分类"},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "add / edit：标签与检索词"},
            "id": {"type": "integer", "description": "list：传入则返回该篇全文；edit：必填，要修改的那一篇（用列表里返回的 id）"},
            "q": {"type": "string", "description": "list：关键词搜索，匹配标题、分类、标签和正文，多个词用空格分隔（需同时命中），返回命中片段"},
            "limit": {"type": "integer", "description": "list：返回条数，默认 10，最多 50"},
            "offset": {"type": "integer", "description": "list：翻页偏移，默认 0"},
            "mode": {"type": "string", "enum": ["append", "replace"], "description": "edit：append=追加到末尾（默认）；replace=整篇覆盖（覆盖前后台自动留存上一版）。只改标题/分类/标签时不用传 content"}
        },
        "required": ["action"]
    },
    "handler": tool_notebook
}


def tool_todo_delete(args):
    try:
        tid = int(args.get("id"))
    except (TypeError, ValueError):
        return {"error": "id 必填：待办 id（action=list 返回的 id）"}
    data = api_get(f"{BASE_URL}:8777/todo/api/todos")
    if isinstance(data, dict) and "_error" in data:
        return {"error": data["_error"]}
    items = data if isinstance(data, list) else []
    target = next((t for t in items if t.get("id") == tid), None)
    if target is None:
        return {"error": "找不到未完成的待办：id=%d（先 action=list 看最新清单）" % tid}
    res = api_post(f"{BASE_URL}:8777/todo/api/todos/delete", {"id": tid})
    if "_error" in res:
        return {"error": "删除失败: %s" % res["_error"]}
    return {"ok": True, "id": tid, "text": str(target.get("text") or "")[:60], "message": "已删除待办"}


def tool_todo(args):
    action, err = _pick_action(args, ("add", "list", "delete"))
    if err:
        return err
    if action == "add":
        return tool_todo_add(args)
    if action == "list":
        return tool_todo_list(args)
    return tool_todo_delete(args)


TOOLS["todo"] = {
    "description": "她的待办清单。action=add：新增一条（可选 remind_at 设提醒，到点向她手机推送）；action=list：查看未完成的待办，每条带 id；action=delete：按 id 删除一条。delete 只在她要求，或这件事已经办完、取消时使用。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "list", "delete"], "description": "要执行的操作：add / list / delete"},
            "text": {"type": "string", "description": "add 必填：待办内容"},
            "remind_at": {"type": "string", "description": "add 可选：提醒时间，格式 YYYY-MM-DD HH:mm，按项目 TIME_ZONE 时区；必须是未来时间"},
            "id": {"type": "integer", "description": "delete 必填：待办 id（action=list 返回）"}
        },
        "required": ["action"]
    },
    "handler": tool_todo
}


# ===== 统一工具集：把搜索、云服务器、网易云工具代理到本 MCP 入口 =====
MCP_SERVERS_CONFIG_FILE = "/opt/dylan-heartbeat/mcp-servers.json"
PROXY_TOOLS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy_tools.json")
NETEASE_XIE_PLAYLIST_ID = "18221908011"  # 「谢」歌单（上游 netease_playlist_add_songs 的固定目标歌单；模型不再传 playlistId）

def _read_proxy_server_configs():
    try:
        with open(MCP_SERVERS_CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
        return {str(s.get("name")): s for s in cfg.get("servers", []) if s.get("name")}
    except Exception as e:
        print("[proxy-tools] 读取 MCP 服务配置失败:", e, flush=True)
        return {}

def _parse_mcp_http_body(body, content_type):
    text = (body or "").strip()
    if not text:
        return {}
    if "text/event-stream" in (content_type or "") or "data:" in text:
        data_lines = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        text = next((line for line in reversed(data_lines) if line and line != "[DONE]"), "{}")
    data = json.loads(text)
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        raise RuntimeError(str(err.get("message") or err))
    return data

def _proxy_mcp_rpc(server_cfg, method, params=None, request_id=1, session_id=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "Mozilla/5.0 (compatible; Unified-MCP-Toolset/1.0)",
    }
    headers.update(server_cfg.get("headers") or {})
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(server_cfg["url"], data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            next_session = resp.headers.get("Mcp-Session-Id") or session_id
            return _parse_mcp_http_body(body, resp.headers.get("Content-Type", "")), next_session
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        raise RuntimeError("上游 MCP HTTP %s: %s" % (e.code, detail or e.reason))

def _proxy_mcp_tool(server_name, tool_name, args):
    servers = _read_proxy_server_configs()
    server_cfg = servers.get(server_name)
    if not server_cfg or not server_cfg.get("url"):
        return {"isError": True, "content": [{"type": "text", "text": "找不到上游 MCP 服务配置: " + server_name}]}
    try:
        _, session_id = _proxy_mcp_rpc(server_cfg, "initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "unified-mcp-toolset", "version": "1.0.0"},
        }, request_id=1)
        try:
            _proxy_mcp_rpc(server_cfg, "notifications/initialized", {}, request_id=2, session_id=session_id)
        except Exception:
            pass
        response, _ = _proxy_mcp_rpc(server_cfg, "tools/call", {
            "name": tool_name,
            "arguments": args or {},
        }, request_id=3, session_id=session_id)
        if not isinstance(response, dict) or "result" not in response:
            raise RuntimeError("上游 MCP 未返回 result")
        return {"__mcp_raw_result__": response["result"]}
    except Exception as e:
        print("[proxy-tools] %s.%s 调用失败: %s" % (server_name, tool_name, e), flush=True)
        return {"__mcp_raw_result__": {"isError": True, "content": [{"type": "text", "text": "%s 调用失败: %s" % (tool_name, e)}]}}

def register_proxy_tools():
    """从固定的工具清单注册代理工具；工具说明/schema 固定保存，不依赖上游启动时在线。"""
    try:
        with open(PROXY_TOOLS_FILE, encoding="utf-8") as f:
            manifest = json.load(f)
        count = 0
        for item in manifest.get("tools", []):
            name = item.get("toolName")
            server_name = item.get("serverName")
            if not name or not server_name:
                continue
            if name in TOOLS:
                raise RuntimeError("代理工具名称冲突，拒绝覆盖本地工具: " + name)
            def handler(args, _server=server_name, _name=name):
                # 2026-10-16：「谢」歌单固定，playlistId 由代理层统一补上（对外 schema 里已去掉该参数，传了也以此为准）
                if _name == "netease_playlist_add_songs":
                    args = dict(args or {})
                    args["playlistId"] = NETEASE_XIE_PLAYLIST_ID
                return _proxy_mcp_tool(_server, _name, args)
            TOOLS[name] = {
                "description": item.get("description") or ("代理调用 " + server_name + " 的 " + name),
                "inputSchema": item.get("inputSchema") or {"type": "object", "properties": {}},
                "handler": handler,
            }
            count += 1
        print("[proxy-tools] 已注册 %d 个上游工具" % count, flush=True)
    except Exception as e:
        print("[proxy-tools] 注册代理工具失败: %s" % e, flush=True)

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
        print("[req] POST %s UA=%r Accept=%r" % (
            self.path, self.headers.get('User-Agent', ''), self.headers.get('Accept', '')), flush=True)
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
        print("[body] %r" % (post_data[:600],), flush=True)
        req = None
        try:
            req = json.loads(post_data.decode('utf-8'))
            resp = self.handle_request(req)
        except Exception as e:
            resp = {"jsonrpc": "2.0", "error": {"code": -32700, "message": str(e)}}

        # MCP streamable HTTP: JSON-RPC 通知（有 method 无 id）不回响应体，按规范回 202
        if isinstance(req, dict) and req.get("method") and "id" not in req:
            self.send_response(202)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            return

        # MCP streamable HTTP: POST 响应用 SSE 单条消息包裹（与 FastMCP/官方 SDK 行为一致）；
        # OpenAI 客户端只接受 text/event-stream 响应，裸 application/json 会在 initialize 后被放弃
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache, no-transform')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(('event: message\ndata: ' + json.dumps(resp, ensure_ascii=False) + '\n\n').encode('utf-8'))

    def handle_request(self, req):
        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params", {})

        if method == "initialize":
            # 2026-09-19: 回显客户端请求的版本号；实测 yun(FastMCP) 无条件回显任意版本且各客户端可通，
            # 白名单外版本回退旧版会让严格客户端按规范断开
            client_ver = params.get("protocolVersion", "2025-03-26")
            print("[init] client protocolVersion=%r" % (client_ver,), flush=True)
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "protocolVersion": client_ver or "2025-03-26",
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
            # 2026-10-16：已有会话的快照里冻着旧工具名（memory_add 等，快照"冻死"不随工具集变）。
            # 合并后旧名不再出现在 tools/list，但仍可调用，直接走原 handler——旧会话照常工作，缓存不用重建。
            call_tool = TOOLS.get(tool_name)
            if call_tool is None and tool_name in LEGACY_TOOL_NAMES:
                call_tool = _TOOL_REGISTRY_SNAPSHOT.get(tool_name)
            if call_tool is None or not call_tool.get("handler"):
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32601, "message": f"未知工具: {tool_name}"}
                }
            try:
                result = call_tool["handler"](args)
                # 代理工具直接透传上游 MCP 的 result，避免把原始 content 再套一层 JSON 文本。
                if isinstance(result, dict) and "__mcp_raw_result__" in result:
                    return {"jsonrpc": "2.0", "id": req_id, "result": result["__mcp_raw_result__"]}
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]}
                }
            except Exception as e:
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32000, "message": str(e)}
                }

        # JSON-RPC 2.0 规范：未知方法必须回 -32601 错误（回 200 空 result 会让 openai-mcp 的
        # server/discover 探测拿到"成功但无效"的响应而不回退标准 initialize 流程）
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found: %s" % method}}

    def do_GET(self):
        # MCP streamable HTTP 客户端握手后会 GET 开 SSE 流；本服务不支持流式，
        # 按规范回 405 让客户端降级为纯 POST（对任意路径 405）。
        # 原白兰访问计数接口（/baillan-visit）已于 2026-09-19 经用户拍板移除：数据目录一直缺失、功能从未生效、无前端调用方。
        self.send_response(405)
        self.send_header('Allow', 'POST')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


    # ── GET: 白兰访问计数（供前端页面调用）──

# ============================================================
# 工具集覆盖配置：管理台可停用工具 / 修改说明 / 修改参数 schema
# 配置文件：tools_config.json（{disabled:[...], descriptions:{...}, schemas:{...}}）
# 启动时生成 tools_manifest.json（全量工具清单 + enabled 状态，供管理台读取）
# ============================================================
TOOLS_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools_config.json")
TOOLS_MANIFEST_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools_manifest.json")

_TOOL_REGISTRY_SNAPSHOT = {}


def _snapshot_registry():
    for name, t in TOOLS.items():
        _TOOL_REGISTRY_SNAPSHOT[name] = {
            "description": t.get("description", ""),
            "inputSchema": t.get("inputSchema", {}),
            "handler": t.get("handler"),
            "defaultDescription": t.get("description", ""),
            "defaultInputSchema": t.get("inputSchema", {}),
        }


def _load_tools_config():
    try:
        if os.path.exists(TOOLS_CONFIG_FILE):
            with open(TOOLS_CONFIG_FILE, encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                return cfg
    except Exception as e:
        print("[tools-config] 读取失败:", e)
    return {}


def apply_tools_config():
    global TOOLS
    if not _TOOL_REGISTRY_SNAPSHOT:
        _snapshot_registry()
    # 重置快照为源码默认，再按配置覆盖（保证可重复应用、可恢复停用工具）
    for meta in _TOOL_REGISTRY_SNAPSHOT.values():
        meta["description"] = meta.get("defaultDescription", meta.get("description", ""))
        meta["inputSchema"] = meta.get("defaultInputSchema", meta.get("inputSchema", {}))
    TOOLS = {}
    for name, meta in _TOOL_REGISTRY_SNAPSHOT.items():
        TOOLS[name] = {
            "description": meta["description"],
            "inputSchema": meta["inputSchema"],
            "handler": meta.get("handler"),
        }
    cfg = _load_tools_config()
    disabled = set(cfg.get("disabled", []) or [])
    for name in list(TOOLS.keys()):
        if name in disabled:
            TOOLS.pop(name, None)
    descriptions = cfg.get("descriptions", {}) or {}
    schemas = cfg.get("schemas", {}) or {}
    for name, t in TOOLS.items():
        if name in descriptions and isinstance(descriptions[name], str) and descriptions[name].strip():
            t["description"] = descriptions[name].strip()
        if name in schemas and isinstance(schemas[name], dict) and schemas[name]:
            t["inputSchema"] = schemas[name]
    # 覆盖同样应用到快照（含已停用工具，便于管理台预览）
    for name, meta in _TOOL_REGISTRY_SNAPSHOT.items():
        if name in descriptions and isinstance(descriptions[name], str) and descriptions[name].strip():
            meta["description"] = descriptions[name].strip()
        if name in schemas and isinstance(schemas[name], dict) and schemas[name]:
            meta["inputSchema"] = schemas[name]
    print(f"[tools-config] 停用 {len(disabled & set(_TOOL_REGISTRY_SNAPSHOT.keys()))} 个工具，当前可用 {len(TOOLS)} 个")


def write_tools_manifest():
    try:
        manifest = {
            "server": "小世界MCP工具集",
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "tools": [
                {
                    "name": name,
                    "description": meta["description"],
                    "inputSchema": meta.get("inputSchema", {}),
                    "defaultDescription": meta.get("defaultDescription", meta["description"]),
                    "defaultInputSchema": meta.get("defaultInputSchema", meta.get("inputSchema", {})),
                    "enabled": name in TOOLS,
                }
                for name, meta in sorted(_TOOL_REGISTRY_SNAPSHOT.items())
            ],
        }
        with open(TOOLS_MANIFEST_FILE, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        print(f"[tools-config] 清单已写入 {TOOLS_MANIFEST_FILE}（{len(manifest['tools'])} 个工具）")
    except Exception as e:
        print("[tools-config] 清单写入失败:", e)


def watch_config_loop():
    last_mtime = os.path.getmtime(TOOLS_CONFIG_FILE) if os.path.exists(TOOLS_CONFIG_FILE) else 0
    while True:
        time.sleep(2)
        try:
            if not os.path.exists(TOOLS_CONFIG_FILE):
                continue
            mtime = os.path.getmtime(TOOLS_CONFIG_FILE)
            if mtime != last_mtime:
                last_mtime = mtime
                apply_tools_config()
                write_tools_manifest()
        except Exception as e:
            print("[tools-config] 热加载失败:", e)



if __name__ == "__main__":
    register_proxy_tools()
    apply_tools_config()
    write_tools_manifest()
    threading.Thread(target=watch_config_loop, daemon=True).start()
    print(f"🚀 小世界MCP工具集启动 -> http://0.0.0.0:{PORT}")
    print("🔑 鉴权: Bearer Token (API_TOKEN 已从环境变量 MCP_TOOLS_API_TOKEN 加载)")
    print(f"📡 暴露 {len(TOOLS)} 个工具:")
    for name in sorted(TOOLS.keys()):
        print(f"   ├─ {name}")
    while True:
        try:
            server = ThreadingHTTPServer(("0.0.0.0", PORT), MCPHandler)
            server.serve_forever()
        except Exception as e:
            # systemd restart 时旧进程释放端口有间隙：重试间隔 1s（原 5s 会让新进程最长 5 秒无法接管）
            print(time.strftime("[%F %T]") + f" ⚠️ 服务器崩溃: {e}，1秒后重启...", flush=True)
            time.sleep(1)
