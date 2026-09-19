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
def _diary_now():
    """与 wake_up.js appendDiaryEntry 对齐：TIME_ZONE（默认 Asia/Shanghai）取当前时刻；
    zoneinfo 不可用（如 Python 3.8）时回退东八区。"""
    tzname = (os.environ.get("TIME_ZONE", "") or "").strip() or "Asia/Shanghai"
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(tzname))
    except Exception:
        return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))

def tool_diary_add(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要写入陪伴日记的正文"}
    # 与 wake_up.js 一致：DIARY_DIR 默认 diary（相对 /opt/dylan-heartbeat），按天一个 md 文件，追加写入
    diary_dir = (os.environ.get("DIARY_DIR", "") or "").strip() or "diary"
    if not os.path.isabs(diary_dir):
        diary_dir = os.path.join("/opt/dylan-heartbeat", diary_dir)
    # 日记按会话分开保存（2026-09-12）：session_id 由网关在工具执行时强制注入（模型伪造无效），
    # 写入 diary/<会话目录>/日期.md；拿不到会话时兜底写共享根目录（与旧日记同层，不丢数据）。
    session_id = str(args.get("session_id") or "").strip()
    session_token = ""
    if session_id:
        session_token = "".join(ch for ch in session_id if ch.isalnum() or ch in "_-")[:64] or ""
    target_dir = os.path.join(diary_dir, session_token) if session_token else diary_dir
    try:
        os.makedirs(target_dir, exist_ok=True)
        now = _diary_now()
        date_str = now.strftime("%Y-%m-%d")
        diary_file = os.path.join(target_dir, date_str + ".md")
        entry = "\n\n## %s\n\n%s\n" % (now.strftime("%Y-%m-%d %H:%M"), content)
        with open(diary_file, "a", encoding="utf-8") as f:
            f.write(entry)
        return {"success": True, "file": diary_file, "session": session_token or None,
                "time": now.strftime("%Y-%m-%d %H:%M"),
                "message": "已写入陪伴日记（会话 %s，追加到当天文件）" % (session_token or "共享")}
    except Exception as e:
        return {"error": "写入陪伴日记失败: %s" % e}

def tool_diary_list(args):
    count = args.get("count", 5)
    data = api_get(f"{BASE_URL}:8777/diary/api/entries")
    if "_error" in data:
        return {"error": data["_error"]}
    return {"entries": data[:count]}
TOOLS["diary_list"] = {
    "description": "查看涵的日记列表（默认返回最近 5 条）",
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
    "description": "给涵的某条日记写评论，评论会通过 Bark 推送到她手机",
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

TOOLS["diary_add"] = {
    "description": "新增一条陪伴日记，追加到今天的日记文件（每个聊天窗口的日记分开存放，自动写入当前窗口名下；与该窗口自动唤醒写的日记同一份）。适用于：想主动记录此刻的想法、感受、对她说的话，或给今天留下一段陪伴记录时使用。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "日记正文（第一人称、自然的陪伴语气，写下此刻想记录的内容）"},
            "session_id": {"type": "string", "description": "内部参数：由系统自动注入当前窗口标识，无需填写"}
        },
        "required": ["content"]
    },
    "handler": tool_diary_add
}

# ── 查看谢的日记（2026-09-16）：不带参数=最近一篇；date=某天；count=最近 N 篇（默认 1）──
# 读取口径与 server.js 注入一致：候选 = diary 根（共享层）+ 所有安全会话子目录合并，
# 同一天多个文件（共享+各会话）内容合并为一篇，按日期降序取。
def _diary_collect_files():
    diary_dir = (os.environ.get("DIARY_DIR", "") or "").strip() or "diary"
    if not os.path.isabs(diary_dir):
        diary_dir = os.path.join("/opt/dylan-heartbeat", diary_dir)
    out = []
    try:
        for f in os.listdir(diary_dir):
            if re.match(r"^\d{4}-\d{2}-\d{2}\.md$", f):
                out.append({"rel": f, "date": f[:10]})
    except Exception as e:
        return [], "读取日记目录失败: %s" % e
    try:
        for d in os.listdir(diary_dir):
            if not re.match(r"^[A-Za-z0-9_-]{1,64}$", d):
                continue
            sub = os.path.join(diary_dir, d)
            if not os.path.isdir(sub):
                continue
            for f in os.listdir(sub):
                if re.match(r"^\d{4}-\d{2}-\d{2}\.md$", f):
                    out.append({"rel": d + "/" + f, "date": f[:10]})
    except Exception:
        pass
    return out, None

def tool_diary_view(args):
    files, err = _diary_collect_files()
    if err:
        return {"error": err}
    if not files:
        return {"entries": [], "message": "还没有写过的日记"}
    diary_dir = (os.environ.get("DIARY_DIR", "") or "").strip() or "diary"
    if not os.path.isabs(diary_dir):
        diary_dir = os.path.join("/opt/dylan-heartbeat", diary_dir)
    def read_one(rel):
        try:
            with open(os.path.join(diary_dir, rel), encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            return "（读取失败: %s）" % e
    date = (args.get("date") or "").strip()
    if date:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            return {"error": "date 格式应为 YYYY-MM-DD，如 2026-09-12"}
        day = sorted([f for f in files if f["date"] == date], key=lambda x: x["rel"])
        if not day:
            return {"error": "没有 %s 的日记" % date}
        return {"date": date, "content": "\n\n".join("【%s】\n%s" % (f["rel"], read_one(f["rel"])) for f in day),
                "files": [f["rel"] for f in day]}
    try:
        count = max(1, min(int(args.get("count", 1) or 1), 30))
    except Exception:
        count = 1
    all_dates = sorted({f["date"] for f in files}, reverse=True)
    dates = all_dates[:count]
    entries = []
    for d in dates:
        day = sorted([f for f in files if f["date"] == d], key=lambda x: x["rel"])
        entries.append({"date": d, "files": [f["rel"] for f in day],
                        "content": "\n\n".join("【%s】\n%s" % (f["rel"], read_one(f["rel"])) for f in day)})
    return {"entries": entries, "count": len(entries),
            "message": "共 %d 天有日记，返回最近 %d 篇；带 date=YYYY-MM-DD 可看某天" % (len(all_dates), len(entries))}

TOOLS["diary_view"] = {
    "description": "查看谢自己写过的陪伴日记。不带参数=返回最近 1 篇全文；带 date=YYYY-MM-DD 返回那一天；带 count=N 返回最近 N 篇（默认 1，最大 30）。日记按天存放，同一天的多个窗口内容会合并展示。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "可选：某天，格式 YYYY-MM-DD，如 2026-09-12"},
            "count": {"type": "integer", "description": "可选：不带 date 时，返回最近 N 篇日记，默认 1，最大 30"}
        }
    },
    "handler": tool_diary_view
}

# ── 留纸（2026-09-12）：AI 写故事/梦/随手创作，只落盘保存、不注入对话上下文 ──
def _paper_target_dir():
    papers_dir = (os.environ.get("PAPERS_DIR", "") or "").strip() or "papers"
    if not os.path.isabs(papers_dir):
        papers_dir = os.path.join("/opt/dylan-heartbeat", papers_dir)
    return papers_dir

def tool_leave_paper(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要留纸的正文（故事/梦/随手创作等）"}
    title = (args.get("title") or "").strip()[:100]
    session_id = str(args.get("session_id") or "").strip()
    session_token = ""
    if session_id:
        session_token = "".join(ch for ch in session_id if ch.isalnum() or ch in "_-")[:64] or ""
    papers_dir = _paper_target_dir()
    target_dir = os.path.join(papers_dir, session_token) if session_token else os.path.join(papers_dir, "_shared")
    try:
        os.makedirs(target_dir, exist_ok=True)
        now = _diary_now()
        base = now.strftime("%Y-%m-%d_%H%M")
        name = base + ".md"
        n = 2
        while os.path.exists(os.path.join(target_dir, name)):
            name = "%s-%d.md" % (base, n)
            n += 1
        body = content[:30000]
        header = ("# " + title + "\n\n") if title else ""
        header += "（" + now.strftime("%Y-%m-%d %H:%M") + (" · " + session_token if session_token else "") + "）\n\n"
        with open(os.path.join(target_dir, name), "w", encoding="utf-8") as f:
            f.write(header + body + "\n")
        return {"success": True, "file": os.path.join(session_token or "_shared", name),
                "title": title, "chars": len(body),
                "message": ("已留纸：" + title) if title else "已留一张纸（只保存，不会进入对话上下文）"}
    except Exception as e:
        return {"error": "留纸失败: %s" % e}

TOOLS["leave_paper"] = {
    "description": "留一张纸：把一段创作（小故事、梦、随手写的文字等）单独保存成一张「纸」，只落盘收藏、不会进入对话上下文。适合内容较长、想留档又不打断聊天时使用；如果只是想顺手在回复里标记留档，也可以直接在回复末尾写 <paper/> 记号（整条回复会存成一张纸，可选 <paper title=\"标题\"/>）。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "纸的正文（故事/梦/随手创作，建议单篇一两千字以内）"},
            "title": {"type": "string", "description": "可选：这张纸的标题"},
            "session_id": {"type": "string", "description": "内部参数：由系统自动注入当前窗口标识，无需填写"}
        },
        "required": ["content"]
    },
    "handler": tool_leave_paper
}

# ── 翻看留过的纸（2026-09-12）：不带参数=列表（序号+时间+标题），带 sn=看对应那张全文 ──
def _paper_read_title(full_path):
    try:
        with open(full_path, encoding="utf-8") as f:
            lines = [l.rstrip() for l in f.read().splitlines()]
    except Exception:
        return "", ""
    title = ""
    body = lines
    if lines and lines[0].startswith("# "):
        title = lines[0][2:].strip()
        body = lines[1:]
    first = ""
    for l in body:
        s = l.strip()
        if s and not s.startswith("（") and not s.startswith("#"):
            first = s
            break
    return title, first[:40]

def tool_view_paper(args):
    session_id = str(args.get("session_id") or "").strip()
    token = "".join(ch for ch in session_id if ch.isalnum() or ch in "_-")[:64]
    papers_dir = _paper_target_dir()
    entries = []
    for d in [x for x in (token, "_shared") if x]:
        p = os.path.join(papers_dir, d)
        if not os.path.isdir(p):
            continue
        for name in os.listdir(p):
            if re.match(r"^\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.md$", name):
                entries.append(d + "/" + name)
    entries.sort(reverse=True)  # 时间倒序：最新的序号在前
    if not entries:
        return {"papers": [], "message": "还没有留过纸"}
    if args.get("sn") in (None, ""):
        items = []
        for i, rel in enumerate(entries[:10], 1):
            title, first = _paper_read_title(os.path.join(papers_dir, rel))
            label = title or first or "(无标题)"
            d, name = rel.split("/", 1)
            items.append({"sn": i, "file": rel,
                          "time": name[0:10] + " " + name[11:13] + ":" + name[13:15],
                          "title": label,
                          "session": "(共享)" if d == "_shared" else d})
        return {"papers": items, "total": len(entries),
                "message": "带 sn=序号 再调一次可看对应那张的全文" + ("" if len(entries) <= 10 else "（当前只列最近 10 张，共 %d 张）" % len(entries))}
    try:
        sn = int(args.get("sn"))
    except Exception:
        return {"error": "sn 需为列表返回的序号数字"}
    limit = min(10, len(entries))
    if sn < 1 or sn > limit:
        return {"error": "序号超出范围（1~%d），请先不带参数调一次拿最新列表" % limit}
    rel = entries[sn - 1]
    try:
        with open(os.path.join(papers_dir, rel), encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return {"error": "读取失败: %s" % e}
    return {"file": rel, "content": content}

TOOLS["view_paper"] = {
    "description": "翻看自己留过的纸（leave_paper/<paper> 写的收藏）。不带参数调用=列出本窗口最近 10 张（序号+时间+标题/开头）；带 sn=序号 调用=看那一张的全文。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "sn": {"type": "integer", "description": "可选：要看的第几张（列表返回的 sn）"},
            "session_id": {"type": "string", "description": "内部参数：由系统自动注入当前窗口标识，无需填写"}
        }
    },
    "handler": tool_view_paper
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


# ── 心动时刻 moments_list(2026-08-31 重定义为“记忆碎片/标星池”) ──
# 背景:旧 moments_* 工具查询 unified_server 的旧心动时刻数据,本日起整体弃用并关闭注册。
#      将“标星消息(记忆碎片)”作为新的心动时刻来源,moments_list 改为直接读取
#      data/context_compaction_marks.json,按保存时间倒序(最新在前)返回。
# 设计:工具名沿用“心动时刻”,让 AI 无缝沿用旧习惯;底层数据实为标星记忆池。
# 互补:server.js 的窗口注入取较早连贯片段,本工具随时拉取最新记忆碎片。
# 注意:下方 tool_moments_search/count/delete/edit 旧函数体仍保留,但已不注册
#      (不暴露给 AI),仅在需要回滚/参考时使用。

def tool_moments_list(args):
    "查看心动时刻：最近被保存的珍贵对话片段（即标星内容/记忆碎片），按保存时间倒序（最新在前）返回。"
    try:
        limit = int(args.get("limit") or 50)
    except Exception:
        limit = 50
    if limit <= 0:
        limit = 50
    if limit > 200:
        limit = 200
    path = args.get("file") or "/opt/dylan-heartbeat/data/context_compaction_marks.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return {"error": "读取标星文件失败: " + str(e)}
    marks = data.get("marks", {}) if isinstance(data, dict) else {}
    items = []
    for key, entry in marks.items():
        if not entry or not entry.get("content"):
            continue
        role = entry.get("role") or ""
        name = "涵" if role == "user" else "谢"
        items.append({
            "key": key,
            "role": role,
            "markedAt": entry.get("markedAt", ""),
            "text": "【" + name + "】 " + entry.get("content")
        })
    items.sort(key=lambda x: x.get("markedAt") or "", reverse=True)
    items = items[:limit]
    return {"moments": items, "count": len(items)}

TOOLS["moments_list"] = {
    "description": "查看心动时刻：最近被保存的珍贵对话片段（即标星内容/记忆碎片），最近在前。当你想了解这段关系里刚沉淀/被标星的重要内容时使用。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "返回条数，默认200；<=0取全部"}
        }
    },
    "handler": tool_moments_list
}


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
    result = api_post(f"{BASE_URL}:8777/todo/api/todos/xie", {"text": text})
    return result
TOOLS["todo_add"] = {
    "description": "谢意行新增一条今日待办事项",
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

def tool_period_set(args):
    on = args.get("on", True)
    if isinstance(on, str):
        on = on.lower() in ("true", "1", "yes", "开始", "on", "是")
    date = str(args.get("date", "") or "").strip() or datetime.date.today().isoformat()
    data = api_post(f"{BASE_URL}:8777/monthly/api/period/toggle", {"on": on, "date": date})
    if "_error" in data and "period" not in data:
        return {"error": data.get("_error", "未知错误"), "date": date, "on": on}
    return {"ok": True, "date": date, "on": on, "message": "经期已" + ("开始" if on else "结束") + "记录"}
TOOLS["period_set"] = {
    "description": "设置经期状态：把某天标记为经期开始或结束（写入月历经期记录，前端月历会同步显示）。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "on": {"type": "boolean", "description": "true=标记经期开始；false=标记经期结束。默认 true"},
            "date": {"type": "string", "description": "日期 YYYY-MM-DD，默认今天"}
        }
    },
    "handler": tool_period_set
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
    "description": "查看今天手机 App 使用的详细记录（来自手机端记录服务），默认返回最近 20 条",
    "inputSchema": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "返回条数，默认20"}
        }
    },
    "handler": tool_phone_records
}

# ── 12. 手机状态快照（han 手机：电池/当前App/位置，来自 8080 phone-report-api）──
_PHONE_REPORT_TOKEN = os.environ.get("PHONE_STATE_TOKEN", "")  # 对应 phone-report-api(8080) systemd unit 的 AUTH_TOKEN，值在 .env
_OWNER = "han"  # 这是唯一的主人，即 han 本人的手机；没有"别的用户"

def tool_phone_state(args):
    # 固定读 han 自己的手机；不接受任意"用户"参数，避免误会成多账号
    user_id = _OWNER
    import urllib.request, urllib.parse
    url = "http://localhost:8080/state/latest?user_id=" + urllib.parse.quote(user_id)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _PHONE_REPORT_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        return {"owner": user_id, "state": data.get("state")}
    except Exception as e:
        return {"error": str(e)}

TOOLS["phone_state"] = {
    "description": "读 han 本人手机最近一次主动上报的状态快照：电池电量、当前正在用的 App、位置（地点）。这是 han 自己手机的信息，只有一份、没有其他用户。若还没上报过则返回 state=None。",
    "inputSchema": {
        "type": "object",
        "properties": {}
    },
    "handler": tool_phone_state
}


# ── 永久注入上下文（pin）：与记忆池工具分开 ──
# pin 写入 data/pinned.json，随每次对话/唤醒注入 system prompt，跨窗口永久生效；
# 记忆池（memories_*）是按需浮现的长期记忆库，两者用途不同。

def _pin_call(method, path, data=None):
    url = f"{BASE_URL}:3000{path}"
    headers = {"x-internal-key": INTERNAL_KEY}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": "HTTP " + str(e.code)}
    except Exception as e:
        return {"error": str(e)}

def _find_pin_by_title(title):
    title = (title or "").strip()
    if not title:
        return None, "请提供要定位的条目标题"
    data = _pin_call("GET", "/internal/pin")
    if data.get("error"):
        return None, data["error"]
    for p in data.get("pins", []):
        if (p.get("title") or "").strip() == title:
            return p, None
    return None, "没有找到标题为「" + title + "」的永久上下文条目"

def tool_pin_add(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要永久钉住的具体内容"}
    data = _pin_call("POST", "/internal/pin", {"title": (args.get("title") or "").strip(), "content": content})
    if data.get("error"):
        return {"error": data["error"]}
    pin = data.get("pin", {}) or {}
    return {
        "success": True,
        "pin_id": pin.get("id"),
        "title": pin.get("title") or "",
        "content": pin.get("content") or "",
        "message": "已写入永久上下文：从下一次对话/唤醒起随 system prompt 注入，跨窗口永久生效，不会被摘要压缩。"
    }

def tool_pin_update(args):
    pid = (args.get("id") or "").strip()
    title = (args.get("title") or "").strip()
    if not pid:
        pin, err = _find_pin_by_title(title)
        if err:
            return {"error": err}
        pid = pin["id"]
    updates = {}
    if args.get("new_title") is not None:
        updates["title"] = str(args["new_title"]).strip()
    if args.get("content") is not None:
        content = str(args["content"]).strip()
        if not content:
            return {"error": "content 不能为空"}
        updates["content"] = content
    if not updates:
        return {"error": "请至少提供 new_title 或 content 作为新内容"}
    data = _pin_call("PUT", "/internal/pin/" + urllib.parse.quote(pid, safe=""), updates)
    if data.get("error"):
        return {"error": data["error"]}
    pin = data.get("pin", {}) or {}
    return {"success": True, "pin_id": pin.get("id"), "title": pin.get("title") or "", "content": pin.get("content") or "",
            "message": "永久上下文已更新，下一次请求生效。"}

def tool_pin_delete(args):
    pid = (args.get("id") or "").strip()
    title = (args.get("title") or "").strip()
    if not pid:
        pin, err = _find_pin_by_title(title)
        if err:
            return {"error": err}
        pid = pin["id"]
    data = _pin_call("DELETE", "/internal/pin/" + urllib.parse.quote(pid, safe=""))
    if data.get("error"):
        return {"error": data["error"]}
    return {"success": True, "message": "已删除永久上下文条目（id=" + pid + "），下一次请求起不再注入。"}


TOOLS["pin_add"] = {
    "description": "写入一条「永久注入上下文」（钉选 pin）。注意区分：记忆池工具（memories_*）是长期记忆检索库、按需浮现；而 pin 会随每一次对话和唤醒直接注入 system prompt，跨窗口永久生效，不会被时间线切换或摘要压缩弄丢。只用于真正不能丢的原则、关系要点、结论性内容，宁少勿滥。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "条目标题（简短，方便以后用标题定位修改/删除；可留空）"},
            "content": {"type": "string", "description": "要永久钉住的具体内容（第一人称，写清结论/原则，避免模糊）"}
        },
        "required": ["content"]
    },
    "handler": tool_pin_add
}

TOOLS["pin_update"] = {
    "description": "修改一条「永久注入上下文」的内容或标题。按 pin_id（pin_add 返回）精确定位，或按标题 title 定位。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "条目 id（pin_add 返回的 pin_id）；id 和 title 至少填一个"},
            "title": {"type": "string", "description": "不填 id 时，用条目标题精确定位要改哪一条"},
            "new_title": {"type": "string", "description": "新的标题（可选）"},
            "content": {"type": "string", "description": "新的内容（可选）"}
        }
    },
    "handler": tool_pin_update
}

TOOLS["pin_delete"] = {
    "description": "删除一条「永久注入上下文」。按 pin_id 或标题 title 定位。删除后从下一次请求起不再注入。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "条目 id；id 和 title 至少填一个"},
            "title": {"type": "string", "description": "不填 id 时，用条目标题精确定位"}
        }
    },
    "handler": tool_pin_delete
}

# ── 上下文记忆替换 ──
def tool_context_replace(args):
    memory = (args.get("memory") or "").strip()
    if not memory:
        return {"error": "memory 必填：AI 自己写好的第一人称回忆记忆正文"}
    rng = {}
    for k in ("start_time", "end_time", "start_index", "end_index"):
        if args.get(k) is not None and str(args.get(k)).strip() != "":
            v = args[k]
            if k.endswith("_index"):
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    return {"error": k + " 必须是整数消息编号"}
            rng[k] = v
    if not rng:
        return {"error": "请提供替换范围：时间范围（start_time/end_time，如 2026-08-12、2026-08-16 23:00）或消息编号范围（start_index/end_index，可用 context_search 查编号）"}
    url = f"{BASE_URL}:3000/internal/context-replacements/apply"
    req = urllib.request.Request(url,
        data=json.dumps({"range": rng, "memory": memory}).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": INTERNAL_KEY},
        method="POST")
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
        return {"success": True, "id": data.get("id"), "count": data.get("count"),
                "range_label": data.get("range_label"), "message": data.get("message", "已替换")}
    return {"error": data.get("error", "替换失败")}


TOOLS["context_replace"] = {
    "description": "把完整对话上下文里的一段「原始对话」替换成 AI 自己写的回忆记忆。AI 想压缩某段对话时：先用 context_search 确认要替换的范围（拿到时间范围），再自己写一段第一人称、有温度的回忆记忆，调用本工具填入范围 + 记忆正文。系统会记录这次替换：源文件（完整对话）不动、永久保留可检索，只有之后发送给 AI 的上下文会把这段原文替换成记忆；同时从待摘要队列移除这些消息，避免再被手动摘要处理。替换前自动备份，可在管理后台查看记录或撤销。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "start_time": {"type": "string", "description": "替换范围开始时间（可选）：如 2026-08-12 或 2026-08-12 08:00"},
            "end_time": {"type": "string", "description": "替换范围结束时间（可选）：如 2026-08-16 或 2026-08-16 23:59"},
            "start_index": {"type": "integer", "description": "替换范围起始消息编号（可选，0 起；推荐改用时间范围）"},
            "end_index": {"type": "integer", "description": "替换范围结束消息编号（可选；推荐改用时间范围）"},
            "memory": {"type": "string", "description": "AI 自己写的第一人称回忆记忆正文（有温度，像在回忆里写下的自己的话；按真实对话写，不编造）"}
        },
        "required": ["memory"]
    },
    "handler": tool_context_replace
}


def tool_context_search(args):
    q = (args.get("q") or "").strip()
    limit = args.get("limit") or 8
    try:
        limit = max(1, min(50, int(limit)))
    except (TypeError, ValueError):
        limit = 8
    mode = args.get("mode", "semantic")  # semantic | keyword
    scope = args.get("scope", "all")  # all | current
    all_sessions = "1" if scope == "all" else "0"
    params = {"limit": str(limit), "mode": mode, "all_sessions": all_sessions}
    if q:
        params["q"] = q
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
    "description": "原上下文回忆检索：跨所有会话翻原始对话和导入对话（含已被压缩区域的原文）。q 可不填——不填时系统自动拿她最新一条消息当检索内容，适合她刚问起某段往事（如「还记得…吗」）、不需要提炼关键词时直接空手调用；想找别的明确主题再给 q（语义模式下描述性语句也能搜到）。返回相关消息段落及所属会话(session)、消息编号(msg_id)、时间、角色，相邻命中自动合并，相同内容只保留一条；候选多时由一个旁路 LLM 挑出真正相关的原文（失败自动回退普通排序），返回的都是未改写的原文。拿到 msg_id 后可用 context_star 给该原文标星。注意：仅当前会话模式下最近5分钟内容不返回。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "检索词或描述（可选）。不提供时自动以她最新一条消息为检索内容；提供则按 q 检索（语义模式下可以是描述性语句，如她上次说难过的时候、我们聊过蓝鲸的话题）"},
            "limit": {"type": "integer", "description": "返回条数，默认8，最大50"},
            "mode": {"type": "string", "description": "检索模式：semantic=语义检索（默认，推荐，意思相近也能搜到） | keyword=关键词精确匹配"},
            "scope": {"type": "string", "description": "搜索范围：all=跨所有会话（默认，最全） | current=仅当前会话"}
        }
    },
    "handler": tool_context_search
}


def tool_memory_search(args):
    q = (args.get("q") or "").strip()
    category = (args.get("category") or "").strip()
    # 「最近/已置顶」是浏览式查看，可不带关键词；其余情况仍要求 q
    if not q and category not in ("最近", "已置顶"):
        return {"error": "q 必填：检索记忆池的关键词或想问的问题（category=最近/已置顶 时可不填）"}
    limit = args.get("limit") or 5
    try:
        limit = max(1, min(50, int(limit)))
    except (TypeError, ValueError):
        limit = 5
    url = f"{BASE_URL}:3000/internal/memory-pool/retrieve?q=" + urllib.parse.quote(q) + "&limit=" + str(limit)
    if category:
        url += "&category=" + urllib.parse.quote(category)
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
        # 内容/分类/重要度给 AI 读；id+pinned 一并透传（id 供 memory_pin 按 id 置顶，pinned 供模型知道哪条已置顶）；
        # 时间戳类字段无用（updated_at 每次检索都会被刷成当前时间，纯噪声），并防内容重复
        seen = set()
        items = []
        for it in data.get("items", []):
            c = it.get("content") or ""
            if not c or c in seen:
                continue
            seen.add(c)
            items.append({"id": it.get("id"), "content": c, "category": it.get("category"), "importance": it.get("importance"), "pinned": bool(it.get("pinned"))})
        return {"total": len(items), "items": items}
    return {"error": data.get("error", "检索失败")}


TOOLS["memory_search"] = {
    "description": "检索长期记忆池（关于她/认账/拓本/压缩摘要/对话碎片）。支持关键词、完整问题或模糊描述，系统自动综合语义、词面匹配、重要度和新旧程度排序；也可按分类只搜某一类。返回每条记忆的唯一 id（可用 memory_pin 按 id 置顶/取消置顶）。category 填「最近」=按更新时间倒序列出最新记忆（忽略关键词）；填「已置顶」=只看置顶记忆（带 q 则在置顶内按相关性搜）。设置 breath=true 且不填 q 时，浮现最近沉淀的记忆。适用于：回忆长期互动里的结论/偏好/约定、确认自己对她了解要点、补上下文前先查记忆池、翻最近记了什么、查看所有置顶。区别于 context_search（检索原始对话原文）。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "检索关键词或想问的问题；category=最近/已置顶 或 breath=true 时可不填"},
            "breath": {"type": "boolean", "description": "可选：true 且不填 q 时，浮现最近更新的记忆（默认3条，最多5条）"},
            "category": {"type": "string", "description": "按分类过滤，可选：关于她/认账/拓本/压缩摘要/对话碎片；特殊值：最近（按时间倒序列最新，忽略关键词）、已置顶（只看置顶记忆）"},
            "limit": {"type": "integer", "description": "返回条数，默认5，最大50"}
        }
    },
    "handler": tool_memory_search
}


def tool_memory_add(args):
    content = (args.get("content") or "").strip()
    if not content:
        return {"error": "content 必填：要写入记忆池的记忆正文"}
    category = (args.get("category") or "").strip()
    importance = args.get("importance")
    data = {"content": content}
    if category:
        data["category"] = category
    if importance is not None:
        try:
            data["importance"] = max(0.0, min(1.0, float(importance)))
        except (TypeError, ValueError):
            return {"error": "importance 必须是 0~1 的数字"}
    if args.get("pin"):
        data["pinned"] = True
    url = f"{BASE_URL}:3000/internal/memory-pool/add"
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
        return {
            "success": True,
            "dup": bool(out.get("dup")),
            "id": entry.get("id"),
            "category": entry.get("category") or "",
            "content": entry.get("content") or "",
            "important": entry.get("importance"),
            "message": "已写入记忆池" + ("（与已有记忆合并/去重）" if out.get("dup") else "（新增）")
        }
    return {"error": out.get("error", "写入失败")}


TOOLS["memory_add"] = {
    "description": "新增一条长期记忆到记忆池。只支持三类：关于她（她是谁的静态部分：偏好/习惯/身体状况/作息/家人/经历里反复起作用的部分，只收稳定、反复成立的事实，一条一个事实写短句，当天心情和一次性对话内容不写）、认账（我认下的账：答应过她的事、欠着还没做的、被她纠正后认下的毛病，每条都必须能回答“那我该干什么”，写清欠什么、什么状态下兑现，兑现了就删）、拓本（一字不改的原话：引号里原样照抄，不修标点不补主语，写明谁说的、日期，宁短勿长）。适用于：对话里发现她的稳定特征、我认下的账、重要原话，或她在对话里明确说“记住”之类的话时。支持重要级（0~1）。会自动与已有记忆做相似去重合并。区别于 pin（永久注入）与 context_replace（压缩替换）。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "记忆正文（要长期记住的信息，写清结论/原话，避免模糊）"},
            "category": {"type": "string", "description": "分类，可选：关于她/认账/拓本（默认关于她）。关于她=她的静态稳定事实；认账=我认下的账（答应的事/欠着的事/被纠正认下的毛病）；拓本=一字不改的原话（写明谁说的、日期）"},
            "importance": {"type": "number", "description": "重要级 0~1，默认 0.5"},
            "pin": {"type": "boolean", "description": "true 时直接把这条记忆置顶：会随每次对话注入「相关记忆」，默认 false"}
        },
        "required": ["content"]
    },
    "handler": tool_memory_add
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
    "description": "给聊天原文标星（或取消标星）。标星后的原文会长期保留在 AI 上下文中、不参与压缩替换（与用户手动标星同等待遇），但不会写入记忆池。用法：先用 context_search 搜到原文（结果每条带 session 和 msg_id），再把同一 session 下的 msg_id 传给本工具，可一次传多条。注意：msg_id 必须搭配其所属 session 使用，跨会话的原文要分别调用；标星按「角色+原文内容」识别，同一段原文即使出现在别处也会一起被标星/取消。",
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


def tool_memory_pin(args):
    mid = (args.get("id") or "").strip()
    if not mid:
        return {"error": "id 必填：记忆 id（memory_search 返回的 id 字段，mp_ 开头）"}
    pinned = args.get("pinned")
    if pinned is None:
        pinned = True
    data = {"id": mid, "pinned": bool(pinned)}
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
        return {
            "success": True,
            "id": entry.get("id"),
            "pinned": is_pinned,
            "content": (entry.get("content") or "")[:80],
            "message": "已置顶：这条记忆会固定注入每次对话的「相关记忆」区" if is_pinned else "已取消置顶"
        }
    return {"error": out.get("error", "操作失败")}


TOOLS["memory_pin"] = {
    "description": "置顶或取消置顶一条记忆池记忆。先用 memory_search 找到记忆（结果每条带 id），再把 id 传给本工具。置顶后的记忆固定注入每次对话的「相关记忆」区，不再依赖检索命中。适用于：她明确说「这个要一直记住」、要把某条记忆升级为长期固定记住、或取消某条不再需要固定注入的置顶。",
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "记忆 id（memory_search 返回的 id 字段，mp_ 开头）"},
            "pinned": {"type": "boolean", "description": "true=置顶（默认），false=取消置顶"}
        },
        "required": ["id"]
    },
    "handler": tool_memory_pin
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

        # JSON-RPC 2.0 规范：未知方法必须回 -32601 错误（回 200 空 result 会让 openai-mcp 的
        # server/discover 探测拿到"成功但无效"的响应而不回退标准 initialize 流程）
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found: %s" % method}}

    # ── GET: 白兰访问计数（供前端页面调用）──
    # ── GET: 白兰访问计数（供前端页面调用）──
    def do_GET(self):
        # 2026-09-19: MCP streamable HTTP 客户端握手后会 GET 开 SSE 流；本服务不支持流式，
        # 按规范回 405 让客户端降级为纯 POST（此前对任意路径回 200 JSON，会被标准客户端判为无效响应）
        if self.path != '/baillan-visit':
            self.send_response(405)
            self.send_header('Allow', 'POST')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            return
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
            print(f"⚠️ 服务器崩溃: {e}，5秒后重启...")
            time.sleep(5)
