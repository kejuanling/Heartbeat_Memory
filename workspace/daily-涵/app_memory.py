import os, json, datetime, subprocess
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')

MEM_BUCKET = '/root/Ombre-Brain/buckets/dynamic'

def _find_mem_file(mid):
    for d in os.listdir(MEM_BUCKET):
        dp = os.path.join(MEM_BUCKET, d)
        if not os.path.isdir(dp): continue
        for f in os.listdir(dp):
            if not f.endswith('.md'): continue
            fp = os.path.join(dp, f)
            if mid in f:
                return (d, f, fp)
            try:
                with open(fp) as fh:
                    head = fh.read(1024)
                sq = "'"
                dq = '"'
                if ('id: ' + mid) in head or ("id: " + sq + mid + sq) in head or ('id: ' + dq + mid + dq) in head:
                    return (d, f, fp)
            except:
                continue
    return None

def _read_mem(fp):
    with open(fp) as f:
        raw = f.read()
    meta = {}
    body = raw
    if raw.startswith('---'):
        parts = raw.split('---', 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split('\n'):
                if ':' in line:
                    k, _, v = line.partition(':')
                    k = k.strip()
                    v = v.strip()
                    if len(v) >= 2:
                        if (v[0] == '"' and v[-1] == '"') or (v[0] == "'" and v[-1] == "'"):
                            v = v[1:-1]
                    if not v or v == '[]':
                        # check if it has list items on next lines - handled in _load_all_memories only
                        pass
                    if v and v != '[]':
                        meta[k] = v
            body = parts[2].strip()
    return meta, body, raw


def _load_all_memories():
    """从 Ombre-Brain buckets 加载全量记忆 list[dict]，按 created/id 倒序"""
    results = []
    for d in sorted(os.listdir(MEM_BUCKET)):
        dp = os.path.join(MEM_BUCKET, d)
        if not os.path.isdir(dp):
            continue
        for fname in sorted(os.listdir(dp)):
            if not fname.endswith(".md"):
                continue
            fp_mem = os.path.join(dp, fname)
            try:
                with open(fp_mem) as fh:
                    raw = fh.read()
            except:
                continue
            meta = {"importance": 5, "valence": 0.5, "arousal": 0.3, "tags": [], "domain": ["未分类"], "created": ""}
            body = raw
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    fm_lines = parts[1].strip().split(chr(10))
                    i = 0
                    while i < len(fm_lines):
                        line = fm_lines[i]
                        if ":" in line:
                            k, _, v = line.partition(":")
                            k = k.strip()
                            v = v.strip()
                            if len(v) >= 2:
                                if (v[0] == '"' and v[-1] == '"') or (v[0] == "'" and v[-1] == "'"):
                                    v = v[1:-1]
                            # YAML 列表: key 后空值且下行以 - 开头
                            if not v and i + 1 < len(fm_lines) and fm_lines[i+1].strip().startswith("- "):
                                items = []
                                i += 1
                                while i < len(fm_lines) and fm_lines[i].strip().startswith("- "):
                                    t = fm_lines[i].strip()[2:].strip()
                                    if len(t) >= 2:
                                        if (t[0] == '"' and t[-1] == '"') or (t[0] == "'" and t[-1] == "'"):
                                            t = t[1:-1]
                                    items.append(t)
                                    i += 1
                                if k == "tags":
                                    meta["tags"] = items
                                elif k == "domain":
                                    meta["domain"] = items if items else ["未分类"]
                                continue
                            else:
                                if k == "importance":
                                    try: meta["importance"] = int(v)
                                    except: pass
                                elif k == "valence":
                                    try: meta["valence"] = float(v)
                                    except: pass
                                elif k == "arousal":
                                    try: meta["arousal"] = float(v)
                                    except: pass
                                elif k == "tags":
                                    if v.startswith("["):
                                        inside = v.strip("[]")
                                        meta["tags"] = [t.strip().strip("'\"[") for t in inside.split(",") if t.strip()]
                                    elif v:
                                        meta["tags"] = [v]
                                elif k == "domain":
                                    if v.startswith("["):
                                        inside = v.strip("[]")
                                        meta["domain"] = [t.strip().strip("'\"[") for t in inside.split(",") if t.strip()]
                                    elif v:
                                        meta["domain"] = [v]
                                elif k == "created":
                                    meta["created"] = v
                        i += 1
                    body = parts[2].strip()
            first_line = body.split(chr(10))[0] if body else ""
            name = ""
            if first_line.startswith("#"):
                name = first_line.replace("#", "").strip()
            display_body = body
            if first_line.startswith("#"):
                rest = body.split(chr(10))[1:]
                display_body = chr(10).join(rest).strip()
            results.append({
                "id": fname.replace(".md", ""),
                "domain": meta["domain"][0] if meta["domain"] else "未分类",
                "tags": meta["tags"],
                "importance": meta["importance"],
                "valence": meta["valence"],
                "arousal": meta["arousal"],
                "name": name or fname.replace(".md", "")[:60],
                "created": meta.get("created", ""),
                "content": display_body
            })
    results.sort(key=lambda m: (m.get("created") or "", m.get("id") or ""), reverse=True)
    return results


@app.route('/')
def idx():
    return send_from_directory('.', 'memory-browser.html')


@app.route('/api/memories')
def api_get_memories():
    """列表接口：支持?limit= N 或 -1全部；?domain=按域"""
    try:
        limit = int(request.args.get('limit', -1))
    except:
        limit = -1
    domain = request.args.get('domain', '').strip()
    all_mems = _load_all_memories()
    if domain:
        all_mems = [m for m in all_mems if (m.get('domain') or '').lower() == domain.lower()]
    total = len(all_mems)
    if limit and limit > 0:
        data = all_mems[:limit]
    else:
        data = all_mems
    return jsonify({"total": total, "returned": len(data), "limit": limit, "memories": data})


@app.route('/api/memories/search')
def api_search_memories():
    """机调专用搜索：匹配 name/content/tags/domain；可按 domain/tag/min_importance 过滤 + limit"""
    q = request.args.get('q', '').strip().lower()
    domain = request.args.get('domain', '').strip()
    min_importance = request.args.get('min_importance', None)
    tag = request.args.get('tag', '').strip()
    try:
        limit = int(request.args.get('limit', 50))
    except:
        limit = 50
    try:
        min_imp = int(min_importance) if min_importance else None
    except:
        min_imp = None

    all_mems = _load_all_memories()
    matched = []
    for m in all_mems:
        if min_imp is not None and (m.get('importance') or 0) < min_imp:
            continue
        if domain and (m.get('domain') or '').lower() != domain.lower():
            continue
        if tag and tag.lower() not in [t.lower() for t in (m.get('tags') or [])]:
            continue
        if q:
            haystack = ' '.join([
                m.get('name', ''),
                m.get('content', ''),
                ' '.join(m.get('tags') or []),
                m.get('domain', ''),
            ]).lower()
            if q not in haystack:
                continue
        matched.append(m)
    total = len(matched)
    if limit and limit > 0:
        data = matched[:limit]
    else:
        data = matched
    return jsonify({
        "total": total,
        "returned": len(data),
        "limit": limit,
        "query": q,
        "domain_filter": domain or None,
        "tag_filter": tag or None,
        "min_importance": min_imp,
        "memories": data
    })


@app.route('/api/memories/count')
def api_count_memories():
    """机调优先：记忆统计 + 按 domain/importance/tag 分组 + 最近 N 条预览"""
    all_mems = _load_all_memories()
    total = len(all_mems)

    try:
        preview = int(request.args.get('preview', 10))
    except:
        preview = 10

    by_domain = {}
    by_importance = {}
    tag_counter = {}
    for m in all_mems:
        d = m.get('domain') or '未分类'
        by_domain[d] = by_domain.get(d, 0) + 1
        imp = m.get('importance') or 0
        by_importance[str(imp)] = by_importance.get(str(imp), 0) + 1
        for t in (m.get('tags') or []):
            tag_counter[t] = tag_counter.get(t, 0) + 1

    by_domain = dict(sorted(by_domain.items(), key=lambda x: -x[1]))
    by_importance = dict(sorted(by_importance.items(), key=lambda x: x[0]))
    top_tags = dict(sorted(tag_counter.items(), key=lambda x: -x[1])[:20])

    imp_high = sum(1 for m in all_mems if (m.get('importance') or 0) >= 8)
    imp_mid  = sum(1 for m in all_mems if 4 <= (m.get('importance') or 0) <= 7)
    imp_low  = sum(1 for m in all_mems if (m.get('importance') or 0) <= 3)

    result = {
        "total": total,
        "importance_summary": {
            "high (>=8)": imp_high,
            "mid (4-7)": imp_mid,
            "low (<=3)": imp_low,
        },
        "by_importance": by_importance,
        "by_domain": by_domain,
        "top_tags": top_tags,
        "domain_count": len(by_domain),
        "unique_tag_count": len(tag_counter),
    }

    if preview and preview > 0:
        previews = []
        for m in all_mems[:preview]:
            content = m.get('content', '')
            content_short = content[:120] + ('...' if len(content) > 120 else '')
            previews.append({
                "id": m.get('id'),
                "name": m.get('name', ''),
                "content": content_short,
                "domain": m.get('domain', ''),
                "importance": m.get('importance'),
                "tags": m.get('tags', []),
                "created": m.get('created', ''),
            })
        result["preview"] = previews
        result["preview_count"] = len(previews)
    return jsonify(result)


@app.route('/api/memories/delete', methods=['POST'])
def api_delete_memory():
    mid = request.json.get('id', '').strip()
    if not mid:
        return jsonify({'ok': False, 'error': 'no id'}), 400
    found = _find_mem_file(mid)
    if not found:
        return jsonify({'ok': False, 'error': 'not found'}), 404
    _, _, fp = found
    os.remove(fp)
    mf = os.path.join(os.path.dirname(__file__), 'memory-data.json')
    if os.path.exists(mf):
        with open(mf) as f:
            data = json.load(f)
        data = [m for m in data if m.get('id') != mid]
        with open(mf, 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify({'ok': True})

@app.route('/api/memories/update', methods=['POST'])
def api_update_memory():
    body = request.json
    mid = body.get('id', '').strip()
    new_content = body.get('content')
    new_importance = body.get('importance')
    new_domain = body.get('domain')
    if not mid:
        return jsonify({'ok': False, 'error': 'no id'}), 400
    found = _find_mem_file(mid)
    if not found:
        return jsonify({'ok': False, 'error': 'not found'}), 404
    _, _, fp = found
    meta, _, raw = _read_mem(fp)
    if raw.startswith('---'):
        parts = raw.split('---', 2)
        fm_lines = parts[1].split('\n')
        if new_importance is not None:
            found_imp = False
            for i, line in enumerate(fm_lines):
                if line.strip().startswith('importance:'):
                    fm_lines[i] = f'importance: {new_importance}'
                    found_imp = True
                    break
            if not found_imp:
                fm_lines.append(f'importance: {new_importance}')
        if new_domain is not None:
            i = 0
            found_dom = False
            while i < len(fm_lines):
                if fm_lines[i].strip().startswith('domain:'):
                    fm_lines[i] = f'domain: {new_domain}'
                    i += 1
                    while i < len(fm_lines) and fm_lines[i].strip().startswith('- '):
                        del fm_lines[i]
                    found_dom = True
                    break
                i += 1
            if not found_dom:
                fm_lines.append(f'domain: {new_domain}')
        new_fm = '\n'.join(fm_lines)
        final_content = new_content if new_content is not None else (parts[2].lstrip('\n') if len(parts) > 2 else '')
        new_raw = f'---{new_fm}---\n\n{final_content}'
    else:
        new_raw = new_content if new_content else raw
    with open(fp, 'w') as f:
        f.write(new_raw)
    mf = os.path.join(os.path.dirname(__file__), 'memory-data.json')
    if os.path.exists(mf):
        with open(mf) as f:
            data = json.load(f)
        for m in data:
            if m.get('id') == mid:
                if new_content is not None:
                    m['content'] = new_content
                if new_importance is not None:
                    m['importance'] = new_importance
                if new_domain is not None:
                    m['domain'] = [new_domain]
                break
        with open(mf, 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify({'ok': True})


@app.route('/api/memories/domains')
def api_get_domains():
    """直接从Markdown源文件读取所有不重复的domain分类，供AI新建记忆时使用"""
    domains = set()
    for d in sorted(os.listdir(MEM_BUCKET)):
        dp = os.path.join(MEM_BUCKET, d)
        if not os.path.isdir(dp): continue
        for fname in sorted(os.listdir(dp)):
            if not fname.endswith(".md"): continue
            fp = os.path.join(dp, fname)
            with open(fp) as f:
                raw = f.read()
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    for line in parts[1].strip().split("\n"):
                        if line.strip().startswith("domain:"):
                            val = line.split(":", 1)[1].strip()
                            if len(val) >= 2:
                                if (val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'"):
                                    val = val[1:-1]
                            if val:
                                domains.add(val)
                            break
    return jsonify(sorted(domains))


@app.route('/api/memories/refresh')
def api_refresh_memories():
    subprocess.run(['python3', '/tmp/dump_memories.py'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    mf = os.path.join(os.path.dirname(__file__), 'memory-data.json')
    if os.path.exists(mf):
        with open(mf) as f:
            return jsonify(json.load(f))
    return jsonify([])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8770, debug=False)
