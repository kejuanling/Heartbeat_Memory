import os, json, datetime, urllib.request
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')
DATA = os.path.join(os.path.dirname(__file__), 'data.json')

def load():
    if not os.path.exists(DATA):
        return {"todos": {}, "moments": []}
    with open(DATA) as f: return json.load(f)

def save(d):
    with open(DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

# ---- 记忆池实时同步（心动时刻网页为真源，记忆池做检索镜像） ----
def _gateway_config():
    url = os.environ.get("HEARTBEAT_SYNC_URL", "http://127.0.0.1:3000/internal/moments/sync")
    rm_url = os.environ.get("HEARTBEAT_REMOVE_URL", "http://127.0.0.1:3000/internal/moments/remove")
    key = os.environ.get("HEARTBEAT_INTERNAL_KEY", "")
    if not key:
        try:
            with open("/opt/dylan-heartbeat/.env", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("INTERNAL_API_KEY="):
                        key = line.split("=", 1)[1].strip()
                        break
        except Exception:
            pass
    return url, rm_url, key

def _post_json(url, payload, key):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-key": key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()

def _sync_moments(items):
    if not items:
        return
    url, _, key = _gateway_config()
    try:
        _post_json(url, {"items": items}, key)
    except Exception as e:
        print("[heart-sync] sync failed:", e)

def _remove_moments(ids):
    if not ids:
        return
    _, rm_url, key = _gateway_config()
    try:
        _post_json(rm_url, {"source_moment_ids": ids}, key)
    except Exception as e:
        print("[heart-sync] remove failed:", e)

@app.route('/')
def idx():
    return send_from_directory('.', 'heart.html')

@app.route('/api/moments')
def get_moments():
    d = load()
    try:
        limit = int(request.args.get('limit', 200))
        if limit <= 0:
            limit = len(d["moments"])  # limit<=0 表示取全部
    except:
        limit = 200
    # add default fields for old data
    for m in d["moments"]:
        if "title" not in m: m["title"] = ""
        if "feelings" not in m: m["feelings"] = ""
        if "category" not in m: m["category"] = ""
        if "timeline_order" not in m: m["timeline_order"] = m["id"]
        if "is_defining" not in m: m["is_defining"] = False
        if "defining_note" not in m: m["defining_note"] = ""
        if "stage" not in m: m["stage"] = ""
        if "text_han" not in m: m["text_han"] = ""
        if "text_xie" not in m: m["text_xie"] = ""
    sorted_moments = sorted(d["moments"], key=lambda x: x["ts"], reverse=True)
    return jsonify(sorted_moments[:limit] if limit > 0 else sorted_moments)

@app.route('/api/moments/add', methods=['POST'])
def add_moment():
    body = request.json
    text = body.get("text", "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    d = load()
    max_id = max((m["id"] for m in d["moments"]), default=0)
    ts = datetime.datetime.now().isoformat()
    item = {
        "text": text,
        "text_han": body.get("text_han", "").strip(),
        "text_xie": body.get("text_xie", "").strip(),
        "title": body.get("title", "").strip(),
        "feelings": body.get("feelings", "").strip(),
        "category": body.get("category", ""),
        "timeline_order": body.get("timeline_order", max_id + 1),
        "is_defining": body.get("is_defining", False),
        "defining_note": body.get("defining_note", "").strip(),
        "stage": body.get("stage", ""),
        "ts": ts,
        "id": max_id + 1
    }
    d["moments"].append(item)
    save(d)
    _sync_moments([item])
    return jsonify({"ok": True})



@app.route("/api/moments/import", methods=["POST"])
def import_moments():
    """批量导入心动时刻对话"""
    body = request.json or {}
    items = body.get("items", [])
    if not items:
        return jsonify({"ok": False, "error": "no items"}), 400
    d = load()
    max_id = max((m["id"] for m in d["moments"]), default=0)
    imported = 0
    imported_items = []
    for item in items:
        text_han = (item.get("text_han") or "").strip()
        text_xie = (item.get("text_xie") or "").strip()
        if not text_han and not text_xie:
            continue
        # 构建 text 字段（兼容旧逻辑和搜索）
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = "\n".join(parts)
        max_id += 1
        ts = item.get("ts") or datetime.datetime.now().isoformat()
        d["moments"].append({
            "text": text,
            "text_han": text_han,
            "text_xie": text_xie,
            "title": (item.get("title") or "").strip(),
            "feelings": (item.get("feelings") or "").strip(),
            "category": item.get("category", ""),
            "thinking": (item.get("thinking") or "").strip(),
            "timeline_order": max_id,
            "is_defining": item.get("is_defining", False),
            "defining_note": (item.get("defining_note") or "").strip(),
            "stage": item.get("stage", ""),
            "ts": ts,
            "id": max_id
        })
        imported_items.append(d["moments"][-1])
        imported += 1
    save(d)
    _sync_moments(imported_items)
    return jsonify({"ok": True, "imported": imported})

@app.route("/api/moments/edit", methods=["POST"])
def edit_moment():
    body = request.json
    print("[EDIT] id=%s category=%s stage=%s title=%s" % (body.get("id"), repr(body.get("category","")), repr(body.get("stage","")), repr(body.get("title",""))))
    mid = body.get("id")
    text = body.get("text", "").strip()
    if not mid or not text:
        return jsonify({"error": "missing id or text"}), 400
    d = load()
    for m in d["moments"]:
        if m["id"] == mid:
            m["text"] = text
            if "text_han" in body: m["text_han"] = body.get("text_han", "").strip()
            if "text_xie" in body: m["text_xie"] = body.get("text_xie", "").strip()
            if "title" in body: m["title"] = body.get("title", "").strip()
            if "feelings" in body: m["feelings"] = body.get("feelings", "").strip()
            if "category" in body: m["category"] = body.get("category", "")
            if "timeline_order" in body:
                try: m["timeline_order"] = int(body["timeline_order"])
                except: pass
            if "is_defining" in body: m["is_defining"] = bool(body["is_defining"])
            if "defining_note" in body: m["defining_note"] = body.get("defining_note", "").strip()
            if "stage" in body: m["stage"] = body.get("stage", "")
            m["ts"] = datetime.datetime.now().isoformat()
            save(d)
            _sync_moments([m])
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404

@app.route("/api/moments/delete", methods=["POST"])
def delete_moment():
    body = request.json
    mid = body.get("id")
    if mid is None:
        return jsonify({"error": "missing id"}), 400
    d = load()
    d["moments"] = [m for m in d["moments"] if m["id"] != mid]
    save(d)
    _remove_moments([mid])
    return jsonify({"ok": True})

@app.route("/api/moments/reorder", methods=["POST"])
def reorder_moments():
    body = request.json
    order = body.get("order")
    if not order or not isinstance(order, list):
        return jsonify({"error": "invalid order"}), 400
    d = load()
    id_map = {m["id"]: m for m in d["moments"]}
    for i, mid in enumerate(order):
        if mid in id_map:
            id_map[mid]["timeline_order"] = i
    save(d)
    return jsonify({"ok": True})

@app.route("/api/moments/batch-update", methods=["POST"])
def batch_update_moments():
    body = request.json
    updates = body.get("updates", [])
    if not updates:
        return jsonify({"error": "no updates"}), 400
    d = load()
    id_map = {m["id"]: m for m in d["moments"]}
    touched = []
    for u in updates:
        mid = u.get("id")
        if mid not in id_map:
            continue
        m = id_map[mid]
        for k in ["title", "text", "text_han", "text_xie", "feelings", "category", "defining_note", "stage"]:
            if k in u:
                m[k] = u[k]
        if "timeline_order" in u:
            try: m["timeline_order"] = int(u["timeline_order"])
            except: pass
        if "is_defining" in u:
            m["is_defining"] = bool(u["is_defining"])
        touched.append(m)
    save(d)
    _sync_moments(touched)
    return jsonify({"ok": True})

@app.route('/api/moments/search')
def search_moments():
    q = request.args.get('q', '').strip().lower()
    if not q:
        return jsonify([])
    try:
        limit = int(request.args.get('limit', 50))
        if limit <= 0:
            limit = None  # limit<=0 表示取全部
    except:
        limit = 50
    d = load()
    results = []
    for m in d["moments"]:
        text = m.get("text","").lower()
        title = m.get("title","").lower()
        feelings = m.get("feelings","").lower()
        note = m.get("defining_note","").lower()
        if q in text or q in title or q in feelings or q in note:
            # add defaults
            if "title" not in m: m["title"] = ""
            if "feelings" not in m: m["feelings"] = ""
            if "category" not in m: m["category"] = ""
            if "timeline_order" not in m: m["timeline_order"] = m["id"]
            if "is_defining" not in m: m["is_defining"] = False
            if "defining_note" not in m: m["defining_note"] = ""
            if "stage" not in m: m["stage"] = ""
            if "text_han" not in m: m["text_han"] = ""
            if "text_xie" not in m: m["text_xie"] = ""
            results.append(m)
    sorted_results = sorted(results, key=lambda x: x["ts"], reverse=True)
    return jsonify(sorted_results[:limit] if limit and limit > 0 else sorted_results)


@app.route("/api/moments/count")
def api_moments_count():
    """机调优先：心动统计 - 总条数、分类/阶段/是否定义时刻 分组、最近N条预览"""
    # 取全部
    d = load()
    moments = d.get("moments", [])
    total = len(moments)
    try:
        preview = int(request.args.get('preview', 10))
    except:
        preview = 10

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

    by_category = dict(sorted(by_category.items(), key=lambda x: -x[1]))
    by_stage = dict(sorted(by_stage.items(), key=lambda x: -x[1]))

    # 按by / 作者统计（涵 vs xie）
    by_by = {}
    for m in moments:
        b = m.get("by") or m.get("text_han") and "涵" or "记录"
        # 简单统计：如果有 text_han 非空就算有涵贡献，text_xie 非空就算有 xie 贡献（可重复计数）
        pass
    # 更简单：统计含 is_defining 的数量已经算过，加上按有 title 的数量
    titled = sum(1 for m in moments if m.get("title"))
    with_feelings = sum(1 for m in moments if m.get("feelings"))

    result = {
        "total": total,
        "defining_count": defining_count,
        "non_defining_count": total - defining_count,
        "titled_count": titled,
        "with_feelings_count": with_feelings,
        "by_category": by_category,
        "by_stage": by_stage,
        "category_count": len(by_category),
        "stage_count": len(by_stage),
    }

    if preview and preview > 0:
        sorted_m = sorted(moments, key=lambda x: x.get("ts", ""), reverse=True)
        previews = []
        for m in sorted_m[:preview]:
            text = m.get("text", "")
            text_short = text[:120] + ("..." if len(text) > 120 else "")
            previews.append({
                "id": m.get("id"),
                "title": m.get("title", ""),
                "text": text_short,
                "category": m.get("category", ""),
                "stage": m.get("stage", ""),
                "is_defining": m.get("is_defining", False),
                "ts": m.get("ts", ""),
            })
        result["preview"] = previews
        result["preview_count"] = len(previews)

    # 可选：按某个 category 或 stage 单独统计数量
    only_cat = request.args.get('category', '').strip()
    if only_cat:
        matched = [m for m in moments if (m.get('category') or '') == only_cat]
        result[f'count_in_category_{only_cat}'] = len(matched)
    only_stg = request.args.get('stage', '').strip()
    if only_stg:
        matched = [m for m in moments if (m.get('stage') or '') == only_stg]
        result[f'count_in_stage_{only_stg}'] = len(matched)

    return jsonify(result)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8769, debug=False)
