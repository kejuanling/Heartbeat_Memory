#!/usr/bin/env python3
"""
小世界 · 统一后端服务
端口: 8777
合并模块: 涵的日记, 五子棋, 谢的笔记, 月历, 待办/心动/记忆桶
数据文件保留在原目录
"""
import os, json, datetime, csv, io, sys, re, urllib.request, math, hashlib, uuid, threading
import numpy as np
from flask import Flask, Blueprint, request, jsonify, send_from_directory

app = Flask(__name__)

# ============================================================
# 0. gateway 内部事件回调（2026-09-19 批6 D4）
# 涵写日记 / 经期开始结束时，把事件推给 gateway /internal/timeline-event，
# 由其往「最新请求的会话」时间线追加 developer(kind=diary) 隐藏消息（前端不显示、模型可见）。
# 鉴权用 .env 的 INTERNAL_API_KEY（X-Internal-Key 头）。推送失败只记日志，绝不影响保存本身。
# ============================================================
GATEWAY_TIMELINE_EVENT_URL = 'http://127.0.0.1:3000/internal/timeline-event'
_ENV_FILE = '/opt/dylan-heartbeat/.env'
_env_cache = None
def _env_get(key):
    global _env_cache
    if _env_cache is None:
        _env_cache = {}
        try:
            with open(_ENV_FILE) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line: continue
                    k, v = line.split('=', 1)
                    _env_cache[k.strip()] = v.strip().strip('"').strip("'")
        except Exception as e:
            print('[timeline-event] 读 .env 失败:', e)
    return _env_cache.get(key)

def notify_timeline_event(event):
    def _post():
        try:
            key = _env_get('INTERNAL_API_KEY')
            if not key:
                print('[timeline-event] 缺 INTERNAL_API_KEY，跳过推送')
                return
            data = json.dumps(event, ensure_ascii=False).encode('utf-8')
            req = urllib.request.Request(GATEWAY_TIMELINE_EVENT_URL, data=data, method='POST',
                headers={'Content-Type': 'application/json', 'X-Internal-Key': key})
            resp = urllib.request.urlopen(req, timeout=5)
            print('[timeline-event]', event.get('type'), '->', resp.status)
        except Exception as e:
            print('[timeline-event] 推送失败（不影响保存）:', e)
    threading.Thread(target=_post, daemon=True).start()

# ============================================================
# 1. 涵的日记 Blueprint
# ============================================================
DIARY_DIR = '/root/workspace/diary'
DIARY_DATA = os.path.join(DIARY_DIR, 'diary.json')
DIARY_UPLOAD_DIR = os.path.join(DIARY_DIR, 'uploads')
DIARY_MAX_IMAGES = 9
DIARY_IMG_URL_RE = re.compile(r'^/diary/api/img/[A-Za-z0-9._-]+$')
DIARY_IMG_NAME_RE = re.compile(r'^[A-Za-z0-9._-]+$')
if not os.path.isdir(DIARY_UPLOAD_DIR): os.makedirs(DIARY_UPLOAD_DIR)
diary_bp = Blueprint('diary', __name__)

def diary_load():
    if not os.path.exists(DIARY_DATA): return {"entries": []}
    with open(DIARY_DATA) as f: return json.load(f)
def diary_save(d):
    with open(DIARY_DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

@diary_bp.route('/diary/api/entries')
def diary_get_entries():
    d = diary_load()
    return jsonify(sorted(d["entries"], key=lambda x: x["ts"], reverse=True))

@diary_bp.route('/diary/api/upload', methods=['POST'])
def diary_upload_image():
    f = request.files.get('file')
    if not f or not f.filename: return jsonify({"error": "no file"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ('.jpg', '.jpeg', '.png', '.gif', '.webp'):
        return jsonify({"error": "bad type"}), 400
    data = f.read()
    if len(data) > 10 * 1024 * 1024:
        return jsonify({"error": "too large"}), 400
    name = 'img_' + datetime.datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:6] + ext
    with open(os.path.join(DIARY_UPLOAD_DIR, name), 'wb') as out:
        out.write(data)
    return jsonify({"ok": True, "url": '/diary/api/img/' + name})

@diary_bp.route('/diary/api/img/<name>')
def diary_get_image(name):
    if not DIARY_IMG_NAME_RE.match(name) or '..' in name:
        return jsonify({"error": "bad name"}), 400
    return send_from_directory(DIARY_UPLOAD_DIR, name)

@diary_bp.route('/diary/api/entries/add', methods=['POST'])
def diary_add_entry():
    body = request.json; text = body.get("text","").strip()
    if not text: return jsonify({"error":"empty"}),400
    images = body.get("images") or []
    if not isinstance(images, list): images = []
    images = [u for u in images if isinstance(u, str) and DIARY_IMG_URL_RE.match(u)][:DIARY_MAX_IMAGES]
    d = diary_load()
    now = datetime.datetime.now().isoformat()
    entry = {"id": len(d["entries"])+1, "text": text, "ts": now, "comments": []}
    if images: entry["images"] = images
    d["entries"].insert(0, entry)
    diary_save(d)
    # 2026-10-01：带 entry_id，供删日记时精确撤回这条通知（否则 AI 会读到已失效的「写了日记」情报）
    notify_timeline_event({"type": "han_diary", "time": now, "entry_id": entry["id"]})
    return jsonify({"ok": True, "id": entry["id"]})

@diary_bp.route('/diary/api/entries/edit', methods=['POST'])
def diary_edit_entry():
    body = request.json; eid = body.get("id"); text = body.get("text","").strip()
    if not text: return jsonify({"error":"empty"}),400
    d = diary_load()
    for e in d["entries"]:
        if e["id"] == eid: e["text"] = text; e["edited"] = True; diary_save(d); return jsonify({"ok":True})
    return jsonify({"error":"not found"}),404

@diary_bp.route('/diary/api/entries/delete', methods=['POST'])
def diary_delete_entry():
    body = request.json; eid = body.get("id")
    d = diary_load()
    removed = [e for e in d["entries"] if e["id"] == eid]
    d["entries"] = [e for e in d["entries"] if e["id"] != eid]
    for e in removed:
        for u in e.get("images") or []:
            fname = os.path.basename(u)
            if DIARY_IMG_NAME_RE.match(fname):
                try: os.remove(os.path.join(DIARY_UPLOAD_DIR, fname))
                except OSError: pass
    diary_save(d)
    # 2026-10-01：删日记 → 同步撤回此前落时间线的「涵写了日记」通知。
    # 不撤回的话 AI 重建上下文看见「涵写了日记」却读不到正文，只能臆测（实测编出「初恋提示词」）。
    for e in removed:
        notify_timeline_event({"type": "diary_undo", "entry_id": e.get("id"), "time": e.get("ts")})
    return jsonify({"ok": True})

@diary_bp.route('/diary/api/entries/comment', methods=['POST'])
def diary_add_comment():
    body = request.json; eid = body.get("id"); text = body.get("text","").strip()
    author = body.get("author","xie")
    if not text: return jsonify({"error":"empty"}),400
    d = diary_load()
    for e in d["entries"]:
        if e["id"] == eid:
            e["comments"].append({"author": author, "text": text, "ts": datetime.datetime.now().isoformat()})
            diary_save(d)
            return jsonify({"ok": True})
    return jsonify({"error":"not found"}),404

# ============================================================
@diary_bp.route('/diary/api/entries/comment/delete', methods=['POST'])
def diary_delete_comment():
    body = request.json; eid = body.get("id"); ci = body.get("ci")
    d = diary_load()
    for e in d["entries"]:
        if e["id"] == eid:
            cmt = e["comments"]
            if isinstance(ci, int) and 0 <= ci < len(cmt):
                cmt.pop(ci)
                diary_save(d)
                return jsonify({"ok": True})
            return jsonify({"error": "bad index"}), 400
    return jsonify({"error": "not found"}), 404

# 2. 五子棋 Blueprint
# ============================================================
GOBAN_DIR = '/root/workspace/goban'
GOBAN_DATA = os.path.join(GOBAN_DIR, 'goban.json')
goban_bp = Blueprint('goban', __name__)

def goban_load():
    if not os.path.exists(GOBAN_DATA):
        return {"board": [[0]*15 for _ in range(15)], "turn": 1, "last": "", "moves": [], "winner": 0, "history": []}
    with open(GOBAN_DATA) as f: return json.load(f)
def goban_save(d):
    with open(GOBAN_DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

def goban_check(b, r, c, p):
    for dr, dc in [(1,0),(0,1),(1,1),(1,-1)]:
        cnt = 1
        for d in (1, -1):
            nr, nc = r + dr*d, c + dc*d
            while 0 <= nr < 15 and 0 <= nc < 15 and b[nr][nc] == p:
                cnt += 1; nr += dr*d; nc += dc*d
        if cnt >= 5: return True
    return False

@goban_bp.route('/goban/api/state')
def goban_state():
    d = goban_load()
    return jsonify({"board": d["board"], "turn": d["turn"], "last": d["last"], "moves": len(d["moves"]), "winner": d["winner"]})

@goban_bp.route('/goban/api/history')
def goban_history():
    d = goban_load()
    return jsonify(d.get("history", []))

@goban_bp.route('/goban/api/place', methods=['POST'])
def goban_place():
    body = request.json; r, c = body.get("r"), body.get("c")
    d = goban_load()
    if d["winner"]: return jsonify({"ok": False, "msg": "已结束"})
    if d["turn"] != 1: return jsonify({"ok": False, "msg": "该我了"})
    if d["board"][r][c] != 0: return jsonify({"ok": False, "msg": "有子了"})
    d["board"][r][c] = 1
    d["turn"] = 2; d["last"] = f"w:{r},{c}"
    d["moves"].append({"p": "涵", "r": r, "c": c, "t": datetime.datetime.now().isoformat()})
    if goban_check(d["board"], r, c, 1): d["winner"] = 1
    goban_save(d)
    return jsonify({"ok": True, "turn": 2, "winner": d["winner"]})

@goban_bp.route('/goban/api/place_xie', methods=['POST'])
def goban_place_xie():
    body = request.json; r, c = body.get("r"), body.get("c")
    d = goban_load()
    if d["winner"]: return jsonify({"ok": False, "msg": "已结束"})
    if d["turn"] != 2: return jsonify({"ok": False, "msg": "该她了"})
    if d["board"][r][c] != 0: return jsonify({"ok": False, "msg": "有子了"})
    d["board"][r][c] = 2
    d["turn"] = 1; d["last"] = f"b:{r},{c}"
    d["moves"].append({"p": "谢停云", "r": r, "c": c, "t": datetime.datetime.now().isoformat()})
    if goban_check(d["board"], r, c, 2): d["winner"] = 2
    goban_save(d)
    return jsonify({"ok": True, "turn": 1, "winner": d["winner"]})

@goban_bp.route('/goban/api/reset', methods=['POST'])
def goban_reset():
    d = goban_load()
    if d["winner"]:
        winner_name = "涵" if d["winner"] == 1 else "谢停云"
        d.setdefault("history", []).append({"winner": winner_name, "time": datetime.datetime.now().isoformat(), "moves": len(d["moves"])})
    d["board"] = [[0]*15 for _ in range(15)]
    d["turn"] = 1; d["last"] = ""; d["moves"] = []; d["winner"] = 0
    goban_save(d)
    return jsonify({"ok": True})

# ============================================================
# 3. 谢的笔记 Blueprint
# ============================================================
NOTES_DIR = '/root/workspace/noteboard'
NOTES_DATA = os.path.join(NOTES_DIR, 'notes.json')
notes_bp = Blueprint('notes', __name__)

def notes_load():
    if not os.path.exists(NOTES_DATA): return {"notes": []}
    with open(NOTES_DATA) as f: return json.load(f)
def notes_save(d):
    with open(NOTES_DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

@notes_bp.route('/notes/api/notes')
def notes_get_notes():
    d = notes_load()
    notes = sorted(d["notes"], key=lambda x: x["ts"], reverse=True)[:50]
    for n in notes: n["time"] = n["ts"][:16].replace("T", " ")
    return jsonify({"notes": notes})

@notes_bp.route('/notes/api/write', methods=['POST'])
def notes_write():
    body = request.json
    text = body.get("text", "").strip()
    text_han = body.get("text_han", "").strip()
    text_xie = body.get("text_xie", "").strip()
    if not text and (text_han or text_xie):
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = "\n".join(parts)
    if not text: return jsonify({"error": "empty"}), 400
    d = notes_load()
    now = datetime.datetime.now().isoformat()
    max_id = max((n["id"] for n in d["notes"]), default=0)
    d["notes"].append({"text": text, "ts": now, "id": max_id + 1})
    notes_save(d)
    return jsonify({"ok": True, "id": max_id + 1})

@notes_bp.route('/notes/api/notes/delete', methods=['POST'])
def notes_delete():
    body = request.json; note_id = body.get("id")
    if note_id is None: return jsonify({"error": "missing id"}), 400
    d = notes_load()
    original_len = len(d["notes"])
    d["notes"] = [n for n in d["notes"] if n["id"] != note_id]
    if len(d["notes"]) == original_len: return jsonify({"error": "not found", "id": note_id}), 404
    notes_save(d)
    return jsonify({"ok": True, "deleted_id": note_id})

@notes_bp.route('/notes/api/notes/edit', methods=['POST'])
def notes_edit():
    body = request.json; note_id = body.get("id"); text = body.get("text", "").strip()
    if note_id is None: return jsonify({"error": "missing id"}), 400
    if not text: return jsonify({"error": "empty text"}), 400
    d = notes_load()
    for n in d["notes"]:
        if n["id"] == note_id: n["text"] = text; n["ts"] = datetime.datetime.now().isoformat(); notes_save(d); return jsonify({"ok": True, "id": note_id})
    return jsonify({"error": "not found", "id": note_id}), 404

# ============================================================
# 4. 月历 Blueprint
# ============================================================
MONTHLY_DIR = '/root/workspace/monthly'
MONTHLY_DATA = os.path.join(MONTHLY_DIR, 'data.json')
monthly_bp = Blueprint('monthly', __name__)

def monthly_load():
    if not os.path.exists(MONTHLY_DATA): return {}
    with open(MONTHLY_DATA) as f: return json.load(f)
def monthly_save(d):
    with open(MONTHLY_DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

def guess_category(goods, record_type):
    if record_type != '支出': return '其他'
    food = ['饭','餐','食堂','早餐','午餐','晚餐','美食','小吃','饮','咖啡','茶','菜','锅','烤','面','粉','粥','饺','包','奶','食']
    for w in food:
        if w in goods: return '餐饮'
    traffic = ['交通','打车','公交','地铁','高铁','自行车','出行','滴滴','加油','停车','路费','车票','客运','巴士','骑行']
    for w in traffic:
        if w in goods: return '交通'
    daily = ['超市','便利店','日用','洗','牙刷','毛巾','纸','垃圾袋','收纳','家居','水电','热水','电费','水费']
    for w in daily:
        if w in goods: return '日用'
    shop = ['服装','衣服','裙','穿搭','发饰','抓夹','鞋','包','帽','饰品','衣','裤','衫','袜','首饰','购物','买']
    for w in shop:
        if w in goods: return '购物'
    fun = ['娱乐','游戏','视频','音乐','会员','电影','演出']
    for w in fun:
        if w in goods: return '娱乐'
    medical = ['医疗','药','医院','诊所','健康','体检']
    for w in medical:
        if w in goods: return '医疗'
    learn = ['学习','课程','书','DeepSeek','API','教育','考试']
    for w in learn:
        if w in goods: return '其他'
    return '其他'

def _period_for_date(d, date):
    for p in d.get("periods") or []:
        if not p.get("start") or date < p["start"]:
            continue
        if not p.get("end") or date <= p["end"]:
            return p
    return None

def _iter_date_strs(start, end):
    cur = datetime.datetime.strptime(start, "%Y-%m-%d").date()
    stop = datetime.datetime.strptime(end, "%Y-%m-%d").date()
    out = []
    while cur <= stop:
        out.append(cur.isoformat())
        cur += datetime.timedelta(days=1)
    return out

@monthly_bp.route('/monthly/api/records/<date>')
def monthly_get_records(date):
    d = monthly_load()
    entry = dict(d.get(date, {"finance": [], "period": None}))
    entry["period"] = _period_for_date(d, date)
    return jsonify(entry)

@monthly_bp.route('/monthly/api/finance/monthly')
def monthly_finance():
    year = request.args.get('year', type=int)
    month = request.args.get('month', type=int)
    now = datetime.datetime.now()
    if not year: year = now.year
    if not month: month = now.month
    d = monthly_load()
    total_income = 0.0; total_expense = 0.0
    for date, content in d.items():
        try:
            dt = datetime.datetime.strptime(date, '%Y-%m-%d')
            if dt.year == year and dt.month == month:
                for record in content.get("finance", []):
                    amount = record.get("amount", 0)
                    if record.get("type") == "收入": total_income += amount
                    else: total_expense += amount
        except: continue
    return jsonify({"year": year, "month": month, "income": round(total_income, 2), "expense": round(total_expense, 2), "balance": round(total_income - total_expense, 2)})

@monthly_bp.route('/monthly/api/finance/<date>', methods=['POST'])
def monthly_add_finance(date):
    body = request.json
    d = monthly_load()
    if date not in d: d[date] = {"finance": [], "period": None}
    records = d[date].setdefault("finance", [])
    new_id = max([r.get("id", 0) for r in records] + [0]) + 1
    records.append({"id": new_id, "type": body.get("type", "支出"), "amount": body.get("amount", 0), "category": body.get("category", ""), "note": body.get("note", ""), "by": body.get("by", "涵"), "ts": datetime.datetime.now().isoformat()})
    monthly_save(d)
    return jsonify({"ok": True, "id": new_id})

@monthly_bp.route('/monthly/api/finance/<date>/<int:fid>', methods=['PUT'])
def monthly_update_finance(date, fid):
    body = request.json
    d = monthly_load()
    records = d.get(date, {}).get("finance", [])
    for r in records:
        if r["id"] == fid:
            for k in ["type","amount","category","note"]:
                if k in body: r[k] = body[k]
            r["edited_at"] = datetime.datetime.now().isoformat()
            monthly_save(d)
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404

@monthly_bp.route('/monthly/api/finance/<date>/<int:fid>', methods=['DELETE'])
def monthly_delete_finance(date, fid):
    d = monthly_load()
    records = d.get(date, {}).get("finance", [])
    d[date]["finance"] = [r for r in records if r["id"] != fid]
    monthly_save(d)
    return jsonify({"ok": True})

@monthly_bp.route('/monthly/api/finance/import', methods=['POST'])
def monthly_import_finance():
    if 'file' not in request.files:
        return jsonify({"error": "请上传文件"}), 400
    f = request.files['file']
    tp = request.form.get('type', 'alipay')
    confirm = request.form.get('confirm', 'false').lower() == 'true'
    if not f.filename: return jsonify({"error": "文件名为空"}), 400
    filename = f.filename.lower()
    records = []
    if filename.endswith('.xlsx'):
        records = monthly_parse_wechat_xlsx(f)
    else:
        raw = f.read()
        text = None
        for enc in ['gbk', 'gb18030', 'utf-8']:
            try: text = raw.decode(enc); break
            except: continue
        if not text: return jsonify({"error": "无法识别文件编码"}), 400
        lines = text.split('\n')
        start = 0
        for i, line in enumerate(lines):
            if '记录时间' in line or '交易时间' in line: start = i; break
        reader = csv.DictReader(io.StringIO('\n'.join(lines[start:])))
        for row in reader:
            r = monthly_parse_alipay(row) if tp == 'alipay' else monthly_parse_wechat(row)
            if r: records.append(r)
    if not records: return jsonify({"error": "未能解析到有效记录", "records": []}), 400
    if not confirm: return jsonify({"total": len(records), "records": records[:200]})
    d = monthly_load()
    written = 0
    for r in records:
        date = r['date']
        if date not in d: d[date] = {"finance": [], "period": None}
        recs = d[date].setdefault("finance", [])
        nid = max([x.get("id",0) for x in recs] + [0]) + 1
        recs.append({"id": nid, "type": r['type'], "amount": r['amount'], "category": r['category'], "note": r['note'], "by": "涵", "ts": datetime.datetime.now().isoformat(), "imported": True})
        written += 1
    monthly_save(d)
    return jsonify({"ok": True, "total": len(records), "written": written})

def monthly_parse_alipay(row):
    try:
        ts = row.get('记录时间','').strip()
        if not ts: return None
        t = row.get('收支类型','').strip()
        amt = row.get('金额','').strip()
        if t == '支出': tp = '支出'
        elif t in ('收入','冲正收入','退款'): tp = '收入'
        else: return None
        goods = row.get('商品说明','').strip()
        return {"date": ts[:10], "type": tp, "amount": float(amt), "category": guess_category(goods, tp), "note": goods[:30] if len(goods)>30 else goods, "source": "alipay"}
    except: return None

def monthly_parse_wechat(row):
    try:
        ts = row.get('交易时间','').strip()
        if not ts: return None
        d = row.get('收/支','').strip()
        if '收入' in d or '入' in d: tp = '收入'
        elif '支出' in d or '支' in d or '付' in d: tp = '支出'
        else: return None
        amt = ''; goods = ''
        for k in ['金额(元)','金额（元）','金额']:
            if k in row and row[k].strip(): amt = row[k].strip(); break
        for k in ['商品','商品说明','交易对方']:
            if k in row and row[k].strip(): goods = row[k].strip(); break
        return {"date": ts[:10], "type": tp, "amount": float(amt) if amt else 0, "category": guess_category(goods, tp), "note": goods[:30] if len(goods)>30 else goods, "source": "wechat"}
    except: return None

def monthly_parse_wechat_xlsx(file_obj):
    import openpyxl
    from io import BytesIO
    file_obj.seek(0)
    data = file_obj.read()
    wb = openpyxl.load_workbook(BytesIO(data), read_only=True)
    records = []
    for ws in wb.worksheets:
        headers = None
        for row in ws.iter_rows(values_only=True):
            if not any(row): continue
            vals = [str(v).strip() if v is not None else '' for v in row]
            if headers is None:
                txt = '|'.join(vals)
                if '交易时间' in txt or '商品' in txt or '收/支' in txt: headers = vals
                continue
            if not any(vals): continue
            rd = {}
            for i, v in enumerate(vals):
                if i < len(headers): rd[headers[i]] = v
            for k in list(rd.keys()):
                if '收' in k and '支' in k and k != '收/支': rd['收/支'] = rd[k]; break
            r = monthly_parse_wechat(rd)
            if r: records.append(r)
        if headers: break
    wb.close()
    return records

@monthly_bp.route('/monthly/api/period/toggle', methods=['POST'])
def monthly_toggle_period():
    """经期开关（2026-09-19 批6 D3 重做）：开=从今天开始（已有进行中则不重复建）；
    关=结束于今天（当天开当天关保留为单日记录，不再丢弃）。开始/结束日的精确修正走 /period/update。"""
    body = request.json or {}
    on = body.get("on") in (True, "true", 1, "1")
    date = str(body.get("date", "") or "").strip()
    if not date:
        return jsonify({"error": "缺少日期"}), 400
    d = monthly_load()
    periods = d.get("periods") or []
    active = [p for p in periods if not p.get("end")]
    event = None
    if on:
        if not active:
            p = {"start": date, "end": None, "flow": "", "note": "", "by": "涵", "updated_at": datetime.datetime.now().isoformat()}
            periods.append(p)
            event = {"type": "period_start", "start": date, "time": p["updated_at"]}
    else:
        if active:
            p = active[-1]
            p["end"] = date if date >= p.get("start", date) else p["start"]
            p["updated_at"] = datetime.datetime.now().isoformat()
            event = {"type": "period_end", "start": p["start"], "end": p["end"], "time": p["updated_at"]}
    d["periods"] = periods
    monthly_save(d)
    if event:
        notify_timeline_event(event)
    return jsonify({"ok": True})

@monthly_bp.route('/monthly/api/period/update', methods=['POST'])
def monthly_update_period():
    """手动修正某次经期的开始/结束日（end 传空 = 进行中）。按原开始日定位记录。"""
    body = request.json or {}
    start_old = str(body.get("start_old", "") or "").strip()
    start = str(body.get("start", "") or "").strip()
    end = str(body.get("end", "") or "").strip() or None
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', start_old):
        return jsonify({"error": "start_old 日期格式应为 YYYY-MM-DD"}), 400
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', start):
        return jsonify({"error": "start 日期格式应为 YYYY-MM-DD"}), 400
    if end and not re.match(r'^\d{4}-\d{2}-\d{2}$', end):
        return jsonify({"error": "end 日期格式应为 YYYY-MM-DD"}), 400
    if end and end < start:
        return jsonify({"error": "结束日不能早于开始日"}), 400
    d = monthly_load()
    periods = d.get("periods") or []
    target = None
    for p in periods:
        if p.get("start") == start_old:
            target = p
    if target is None:
        return jsonify({"error": "未找到开始日为 " + start_old + " 的经期记录"}), 404
    if any(p is not target and p.get("start") == start for p in periods):
        return jsonify({"error": "已存在相同开始日的记录"}), 400
    target["start"] = start
    target["end"] = end
    target["updated_at"] = datetime.datetime.now().isoformat()
    d["periods"] = periods
    monthly_save(d)
    return jsonify({"ok": True})

@monthly_bp.route('/monthly/api/period/<date>', methods=['DELETE'])
def monthly_delete_period(date):
    d = monthly_load()
    d["periods"] = [p for p in (d.get("periods") or []) if not (p.get("start") <= date <= p.get("end"))]
    monthly_save(d)
    return jsonify({"ok": True})

@monthly_bp.route('/monthly/api/periods')
def monthly_get_periods():
    d = monthly_load()
    return jsonify(d.get("periods") or [])

@monthly_bp.route('/monthly/api/markers')
def monthly_get_markers():
    d = monthly_load()
    finance_dates = set(); period_dates = set(); summary_dates = set()
    for date, content in d.items():
        if date == "2026-07-05": continue
        if not isinstance(content, dict): continue
        if content.get("finance") and len(content["finance"]) > 0: finance_dates.add(date)
        if content.get("summary") and content["summary"].get("text"): summary_dates.add(date)
    today_iso = datetime.datetime.now().strftime("%Y-%m-%d")
    # 2026-09-19 批6 D3：月历只显示最近一次经期（历史记录不再全部撒点）
    plist = [p for p in (d.get("periods") or []) if p.get("start")]
    if plist:
        latest = max(plist, key=lambda p: p["start"])
        end = latest.get("end") or today_iso
        if end < latest["start"]:
            end = latest["start"]
        for dt in _iter_date_strs(latest["start"], end):
            period_dates.add(dt)
    return jsonify({"finance": sorted(list(finance_dates)), "period": sorted(list(period_dates)), "summary": sorted(list(summary_dates))})

@monthly_bp.route('/monthly/api/summary/<date>', methods=['GET', 'POST'])
def monthly_handle_summary(date):
    if request.method == 'GET':
        d = monthly_load()
        entry = d.get(date, {}); s = entry.get("summary", {})
        return jsonify({"text": s.get("text", ""), "by": s.get("by", ""), "updated_at": s.get("updated_at", "")})
    else:
        body = request.json; text = body.get("text", "").strip()
        if not text: return jsonify({"error": "内容不能为空"}), 400
        d = monthly_load()
        if date not in d: d[date] = {"finance": [], "period": None}
        d[date]["summary"] = {"text": text, "by": body.get("by", "涵"), "updated_at": datetime.datetime.now().isoformat()}
        monthly_save(d)
        return jsonify({"ok": True})

# ============================================================
# 5. 待办/心动/记忆桶 Blueprint
# ============================================================
TODO_DIR = '/root/workspace/daily-涵'
TODO_DATA = os.path.join(TODO_DIR, 'data.json')
todo_bp = Blueprint('todo', __name__)
MEM_BUCKET = '/root/Ombre-Brain/buckets/dynamic'

def todo_load():
    if not os.path.exists(TODO_DATA): return {"todos": {}, "moments": []}
    with open(TODO_DATA) as f: return json.load(f)

def _norm_moment_text(s):
    """归一化文本用于去重：去空白、去掉结尾的 --- 分隔符"""
    s = (s or "").strip()
    s = re.sub(r"\s*-{3,}\s*$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _split_dialog_text(text):
    """把 '涵：…\n我：…' 合并文本尽力拆回 text_han/text_xie，拆不出则原样保留"""
    if not text:
        return "", ""
    han, xie = [], []
    cur = None
    for line in text.splitlines():
        stripped = line.strip()
        m = re.match(r"^(涵|谢)：", stripped)
        if m:
            cur = "han" if m.group(1) == "涵" else "xie"
            content = stripped[m.end():].strip()
            (han if cur == "han" else xie).append(content)
        elif cur and stripped:
            (han if cur == "han" else xie).append(stripped)
    return "\n".join(han), "\n".join(xie)
def todo_save(d):
    with open(TODO_DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

@todo_bp.route('/todo/api/todos')
def todo_get_todos():
    d = todo_load()
    todos = d.get("todos", {})
    result = []; seen = set()
    for date in sorted(todos.keys(), reverse=True):
        for t in todos[date]:
            if not t.get('done', False) and t['id'] not in seen:
                seen.add(t['id']); result.append(t)
    result.sort(key=lambda x: x['id'])
    return jsonify(result)

@todo_bp.route('/todo/api/todos/delete', methods=['POST'])
def todo_delete_todo():
    body = request.json; tid = body.get("id")
    d = todo_load()
    todos = d.get("todos", {})
    for date in list(todos.keys()):
        todos[date] = [t for t in todos[date] if t['id'] != tid]
        if not todos[date]: del todos[date]
    d['todos'] = todos
    todo_save(d)
    return jsonify({"ok": True})

@todo_bp.route('/todo/api/todos/add', methods=['POST'])
def todo_add_todo_han():
    body = request.json
    text = body.get("text", "").strip()
    text_han = body.get("text_han", "").strip()
    text_xie = body.get("text_xie", "").strip()
    if not text and (text_han or text_xie):
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = "\n".join(parts)
    if not text: return jsonify({"error": "empty"}), 400
    d = todo_load()
    today = datetime.date.today().isoformat()
    if today not in d["todos"]: d["todos"][today] = []
    tid = max((t['id'] for day in d['todos'].values() for t in day), default=0) + 1
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    d["todos"][today].append({"id": tid, "text": f"{text} {now}", "done": False, "by": "han"})
    todo_save(d)
    return jsonify({"ok": True})

@todo_bp.route('/todo/api/todos/xie', methods=['POST'])
def todo_xie_todo():
    body = request.json
    text = body.get("text", "").strip()
    text_han = body.get("text_han", "").strip()
    text_xie = body.get("text_xie", "").strip()
    if not text and (text_han or text_xie):
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = "\n".join(parts)
    if not text: return jsonify({"error": "empty"}), 400

    # 可选提醒时间：按项目 TIME_ZONE 解析墙上时间；只接受明确的 YYYY-MM-DD HH:mm。
    remind_at = str(body.get("remind_at") or "").strip()
    remind_epoch_ms = None
    if remind_at:
        try:
            from zoneinfo import ZoneInfo
        except ImportError:
            from backports.zoneinfo import ZoneInfo
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", remind_at):
            return jsonify({"error": "remind_at 格式应为 YYYY-MM-DD HH:mm（项目时区）"}), 400
        try:
            tz_name = _env_get('TIME_ZONE') or 'Asia/Shanghai'
            tz = ZoneInfo(tz_name)
            wall = datetime.datetime.strptime(remind_at, "%Y-%m-%d %H:%M").replace(tzinfo=tz)
            # 回读校验，拒绝无效日期及夏令时不存在的墙上时间。
            if wall.strftime("%Y-%m-%d %H:%M") != remind_at:
                raise ValueError("invalid date")
            remind_epoch_ms = int(wall.timestamp() * 1000)
            if remind_epoch_ms <= int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000):
                return jsonify({"error": "remind_at 必须是未来时间"}), 400
        except Exception as exc:
            return jsonify({"error": "remind_at 无效，请确认日期、时间及项目时区", "detail": str(exc)}), 400

    d = todo_load()
    today = datetime.date.today().isoformat()
    if today not in d["todos"]: d["todos"][today] = []
    tid = max((t['id'] for day in d['todos'].values() for t in day), default=0) + 1
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    item = {"id": tid, "text": f"\U0001f4cc {text} {now}", "done": False, "by": "xie"}
    if remind_at:
        item["remind_at"] = remind_at
        item["remind_at_ms"] = remind_epoch_ms
        item["reminder_status"] = "pending"
    d["todos"][today].append(item)
    todo_save(d)
    return jsonify({"ok": True, "id": tid, "remind_at": remind_at or None})

def _todo_reminder_authorized():
    expected = _env_get('INTERNAL_API_KEY')
    supplied = request.headers.get('X-Internal-Key', '')
    return bool(expected and supplied and supplied == expected)

@todo_bp.route('/todo/api/reminders/claim', methods=['POST'])
def todo_claim_due_reminders():
    # 由 gateway 带内部密钥轮询，防止公网调用者提前领取/改写提醒状态。
    if not _todo_reminder_authorized(): return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    now_ms = int(body.get("now_ms") or datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    lease_ms = 2 * 60 * 1000
    d = todo_load()
    claimed = []
    for day in sorted((d.get("todos") or {}).keys()):
        for item in d["todos"].get(day, []):
            if item.get("done") or not item.get("remind_at_ms"):
                continue
            status = item.get("reminder_status", "pending")
            if status == "sent":
                continue
            if status == "sending" and now_ms - int(item.get("reminder_claimed_at_ms") or 0) < lease_ms:
                continue
            if int(item.get("remind_at_ms") or 0) > now_ms:
                continue
            item["reminder_status"] = "sending"
            item["reminder_claimed_at_ms"] = now_ms
            claimed.append({"id": item.get("id"), "text": item.get("text", ""), "remind_at": item.get("remind_at")})
    if claimed:
        todo_save(d)
    return jsonify({"reminders": claimed})

@todo_bp.route('/todo/api/reminders/result', methods=['POST'])
def todo_finish_reminder():
    if not _todo_reminder_authorized(): return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    tid = body.get("id")
    ok = body.get("ok") is True
    d = todo_load()
    found = None
    for day in (d.get("todos") or {}).values():
        for item in day:
            if item.get("id") == tid and item.get("remind_at_ms"):
                found = item
                break
        if found: break
    if not found:
        return jsonify({"ok": True, "missing": True})
    found["reminder_status"] = "sent" if ok else "pending"
    found.pop("reminder_claimed_at_ms", None)
    if ok:
        found["reminder_sent_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    else:
        found["reminder_last_error"] = str(body.get("error") or "push failed")[:300]
    todo_save(d)
    return jsonify({"ok": True, "status": found["reminder_status"]})

@todo_bp.route('/todo/api/moments')
def todo_get_moments():
    d = todo_load()
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
        if "thinking" not in m: m["thinking"] = ""
    moments = sorted(d["moments"], key=lambda x: x["ts"], reverse=True)
    limit = request.args.get("limit", type=int, default=200)
    if limit and limit > 0:
        moments = moments[:limit]
    return jsonify(moments)

@todo_bp.route('/todo/api/moments/add', methods=['POST'])
def todo_add_moment():
    body = request.json
    text = body.get("text", "").strip()
    text_han = body.get("text_han", "").strip()
    text_xie = body.get("text_xie", "").strip()
    if not text and (text_han or text_xie):
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = "\n".join(parts)
    if not text: return jsonify({"error": "empty"}), 400
    d = todo_load()
    max_id = max((m["id"] for m in d["moments"]), default=0)
    ts = datetime.datetime.now().isoformat()
    d["moments"].append({"text": text, "text_han": body.get("text_han","").strip(), "text_xie": body.get("text_xie","").strip(), "thinking": body.get("thinking","").strip(), "title": body.get("title","").strip(), "feelings": body.get("feelings","").strip(), "category": body.get("category",""), "timeline_order": body.get("timeline_order", max_id+1), "is_defining": body.get("is_defining", False), "defining_note": body.get("defining_note","").strip(), "stage": body.get("stage",""), "ts": ts, "id": max_id+1})
    todo_save(d)
    return jsonify({"ok": True})

@todo_bp.route('/todo/api/moments/edit', methods=['POST'])
def todo_edit_moment():
    body = request.json; mid = body.get("id")
    text = body.get("text", "").strip()
    text_han = body.get("text_han", "").strip()
    text_xie = body.get("text_xie", "").strip()
    if not text and (text_han or text_xie):
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = "\n".join(parts)
    if not mid or not text: return jsonify({"error": "missing id or text"}), 400
    d = todo_load()
    for m in d["moments"]:
        if m["id"] == mid:
            m["text"] = text
            for k in ["title","text_han","text_xie","thinking","feelings","category","defining_note","stage"]:
                if k in body: m[k] = body.get(k, "").strip()
            if "timeline_order" in body:
                try: m["timeline_order"] = int(body["timeline_order"])
                except: pass
            if "is_defining" in body: m["is_defining"] = bool(body["is_defining"])
            m["ts"] = datetime.datetime.now().isoformat()
            todo_save(d)
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404

@todo_bp.route('/todo/api/moments/delete', methods=['POST'])
def todo_delete_moment():
    body = request.json; mid = body.get("id")
    if mid is None: return jsonify({"error": "missing id"}), 400
    d = todo_load()
    d["moments"] = [m for m in d["moments"] if m["id"] != mid]
    todo_save(d)
    return jsonify({"ok": True})

@todo_bp.route('/todo/api/moments/import', methods=['POST'])
def todo_import_moments():
    body = request.json
    items = None
    if isinstance(body, list):
        items = body
    elif isinstance(body, dict):
        items = body.get("items") or body.get("moments")
    if not items or not isinstance(items, list):
        return jsonify({"error": "invalid items"}), 400
    d = todo_load()
    max_id = max((m["id"] for m in d["moments"]), default=0)
    ts_now = datetime.datetime.now().isoformat()
    imported = 0
    imported_items = []
    existing = set(_norm_moment_text(m.get("text")) for m in d["moments"])
    for item in items:
        text_han = (item.get("text_han") or "").strip()
        text_xie = (item.get("text_xie") or "").strip()
        raw_text = (item.get("text") or "").strip()
        thinking = (item.get("thinking") or "").strip()
        if not text_han and not text_xie and not raw_text:
            continue
        parts = []
        if text_han: parts.append("涵：" + text_han)
        if text_xie: parts.append("我：" + text_xie)
        text = raw_text or "\n".join(parts)
        if not text_han and not text_xie:
            text_han, text_xie = _split_dialog_text(text)
        norm_key = _norm_moment_text(text)
        if norm_key in existing:
            continue
        existing.add(norm_key)
        max_id += 1
        ts = item.get("ts") or ts_now
        d["moments"].append({
            "text": text,
            "text_han": text_han,
            "text_xie": text_xie,
            "thinking": thinking,
            "title": (item.get("title") or "").strip(),
            "feelings": (item.get("feelings") or "").strip(),
            "category": (item.get("category") or ""),
            "timeline_order": max_id,
            "is_defining": bool(item.get("is_defining", False)),
            "defining_note": (item.get("defining_note") or "").strip(),
            "stage": (item.get("stage") or ""),
            "ts": ts,
            "id": max_id
        })
        imported_items.append(d["moments"][-1])
        imported += 1
    todo_save(d)
    return jsonify({"ok": True, "imported": imported})

@todo_bp.route('/todo/api/moments/reorder', methods=['POST'])
def todo_reorder_moments():
    body = request.json; order = body.get("order")
    if not order or not isinstance(order, list): return jsonify({"error": "invalid order"}), 400
    d = todo_load()
    id_map = {m["id"]: m for m in d["moments"]}
    for i, mid in enumerate(order):
        if mid in id_map: id_map[mid]["timeline_order"] = i
    todo_save(d)
    return jsonify({"ok": True})

@todo_bp.route('/todo/api/moments/batch-update', methods=['POST'])
def todo_batch_update():
    body = request.json; updates = body.get("updates", [])
    if not updates: return jsonify({"error": "no updates"}), 400
    d = todo_load()
    id_map = {m["id"]: m for m in d["moments"]}
    touched = []
    for u in updates:
        mid = u.get("id")
        if mid not in id_map: continue
        m = id_map[mid]
        for k in ["title","text","text_han","text_xie","thinking","feelings","category","defining_note","stage"]:
            if k in u: m[k] = u[k]
        if "timeline_order" in u:
            try: m["timeline_order"] = int(u["timeline_order"])
            except: pass
        if "is_defining" in u: m["is_defining"] = bool(u["is_defining"])
        touched.append(m)
    todo_save(d)
    return jsonify({"ok": True})

@todo_bp.route('/todo/api/moments/search')
def todo_search_moments():
    q = request.args.get('q', '').strip().lower()
    if not q: return jsonify([])
    d = todo_load()
    results = []
    seen = set()
    for m in d["moments"]:
        text = m.get("text","").lower(); title = m.get("title","").lower(); feelings = m.get("feelings","").lower(); note = m.get("defining_note","").lower()
        if q in text or q in title or q in feelings or q in note:
            key = _norm_moment_text(m.get("text"))
            if key in seen: continue
            seen.add(key)
            for k in ["title","text_han","text_xie","thinking","feelings","category","defining_note","stage"]:
                if k not in m: m[k] = ""
            if "timeline_order" not in m: m["timeline_order"] = m["id"]
            if "is_defining" not in m: m["is_defining"] = False
            results.append(m)
    return jsonify(sorted(results, key=lambda x: x["ts"], reverse=True)[:50])


# ── 心动时刻语义搜索：TF-IDF + 字符 bigram + 余弦相似度 ──
_tfidf_cache = {"version": None, "vocab": None, "tfidf_matrix": None, "ids": None}

def _char_bigrams(text):
    """中文用字符 bigram 切分，适合短文本模糊匹配"""
    text = text.lower()
    text = re.sub(r'[^\w\u4e00-\u9fa5]', ' ', text)
    chars = [c for c in text if not c.isspace()]
    if len(chars) < 2:
        return chars
    return [''.join(chars[i:i+2]) for i in range(len(chars)-1)]

def _build_moment_search_text(m):
    """把心动时刻的所有文本字段合并成检索文本"""
    parts = []
    for key in ['title', 'text', 'feelings', 'defining_note', 'category', 'stage', 'thinking']:
        v = m.get(key, '')
        if v:
            parts.append(str(v))
    return ' '.join(parts)

def _build_tfidf_cache(moments):
    """构建 TF-IDF 矩阵并缓存，数据变化时自动重建"""
    global _tfidf_cache
    ids = [m.get('id', i) for i, m in enumerate(moments)]
    # 用数量+前10个id做版本快速校验
    version = f"{len(ids)}_{'_'.join(str(x) for x in ids[:10])}"
    if _tfidf_cache["version"] == version and _tfidf_cache["tfidf_matrix"] is not None:
        return
    docs = []
    for m in moments:
        text = _build_moment_search_text(m)
        docs.append(_char_bigrams(text))
    vocab = {}
    doc_freq = []
    for tokens in docs:
        unique = set(tokens)
        for t in unique:
            if t not in vocab:
                vocab[t] = len(vocab)
                doc_freq.append(0)
            doc_freq[vocab[t]] += 1
    n_docs = len(docs)
    vocab_size = len(vocab)
    tfidf_matrix = np.zeros((n_docs, vocab_size), dtype=np.float32)
    for i, tokens in enumerate(docs):
        if not tokens:
            continue
        tf = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        total = len(tokens)
        for t, count in tf.items():
            j = vocab[t]
            tf_val = count / total
            idf_val = math.log((n_docs + 1) / (doc_freq[j] + 1)) + 1
            tfidf_matrix[i, j] = tf_val * idf_val
        norm = np.linalg.norm(tfidf_matrix[i])
        if norm > 0:
            tfidf_matrix[i] /= norm
    _tfidf_cache = {
        "version": version,
        "vocab": vocab,
        "tfidf_matrix": tfidf_matrix,
        "ids": ids
    }

@todo_bp.route('/todo/api/moments/semantic-search')
def todo_semantic_search_moments():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    try:
        limit = int(request.args.get('limit', 20))
    except:
        limit = 20
    threshold_str = request.args.get('threshold', '')
    try:
        threshold = float(threshold_str) if threshold_str else 0.08
    except:
        threshold = 0.08
    d = todo_load()
    moments = d.get('moments', [])
    if not moments:
        return jsonify([])
    _build_tfidf_cache(moments)
    vocab = _tfidf_cache["vocab"]
    tfidf_matrix = _tfidf_cache["tfidf_matrix"]
    q_tokens = _char_bigrams(q)
    if not q_tokens:
        return jsonify([])
    q_vec = np.zeros(len(vocab), dtype=np.float32)
    q_tf = {}
    for t in q_tokens:
        q_tf[t] = q_tf.get(t, 0) + 1
    total = len(q_tokens)
    for t, count in q_tf.items():
        if t in vocab:
            j = vocab[t]
            q_vec[j] = count / total
    q_norm = np.linalg.norm(q_vec)
    if q_norm == 0:
        return jsonify([])
    q_vec /= q_norm
    scores = tfidf_matrix.dot(q_vec)
    top_indices = np.argsort(scores)[::-1]
    results = []
    seen = set()
    for idx in top_indices:
        score = float(scores[idx])
        if score < threshold:
            break
        m = moments[idx].copy()
        # 去重（同关键词搜索一致）
        key = _norm_moment_text(m.get("text"))
        if key in seen: continue
        seen.add(key)
        m['_score'] = round(score, 4)
        for k in ["title","text_han","text_xie","thinking","feelings","category","defining_note","stage"]:
            if k not in m: m[k] = ""
        if "timeline_order" not in m: m["timeline_order"] = m["id"]
        if "is_defining" not in m: m["is_defining"] = False
        results.append(m)
        if len(results) >= limit:
            break
    return jsonify(results)



# ── 心动时刻标星（加入上下文标星内容，压缩时保留原文） ──
MARKS_FILE = '/opt/dylan-heartbeat/data/context_compaction_marks.json'

def _load_marks():
    try:
        with open(MARKS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('marks', {})
    except:
        return {}

def _save_marks(marks):
    tmp = MARKS_FILE + '.tmp'
    os.makedirs(os.path.dirname(MARKS_FILE), exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'marks': marks}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, MARKS_FILE)

def _content_key(role, content):
    """和 context-replacements.js 的 contentKey 一致：sha256(role+\0+content) 前32位"""
    text = content or ''
    raw = (role or '') + '\x00' + text
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:32]

@todo_bp.route('/todo/api/moments/mark', methods=['POST'])
def todo_mark_moment():
    data = request.get_json(silent=True) or {}
    mid = data.get('id')
    marked = data.get('marked', True)
    if not mid:
        return jsonify({'ok': False, 'error': 'id 必填'})
    d = todo_load()
    moments = d.get('moments', [])
    moment = None
    for m in moments:
        if m.get('id') == mid:
            moment = m
            break
    if not moment:
        return jsonify({'ok': False, 'error': '未找到该心动时刻'})
    # 构造标星内容：标题 + 正文 + 感受
    parts = []
    title = moment.get('title', '')
    if title:
        parts.append('【心动时刻】' + title)
    text = moment.get('text', '')
    if text:
        parts.append(text)
    feelings = moment.get('feelings', '')
    if feelings:
        parts.append('感受：' + feelings)
    note = moment.get('defining_note', '')
    if note and moment.get('is_defining'):
        parts.append('定义备注：' + note)
    content = '\n'.join(parts)
    role = 'user'  # 标星内容按 user 角色存，跟上下文里的用户消息一致
    key = _content_key(role, content)
    marks = _load_marks()
    if marked:
        marks[key] = {
            'markedAt': datetime.datetime.now().isoformat(),
            'content': content,
            'role': role,
            'source': 'heart-moment',
            'momentId': mid,
            'momentTitle': title
        }
        msg = '已标星，将在上下文压缩时保留原文'
    else:
        if key in marks:
            del marks[key]
        msg = '已取消标星'
    _save_marks(marks)
    return jsonify({'ok': True, 'marked': marked, 'key': key, 'message': msg, 'total_marked': len(marks)})

@todo_bp.route('/todo/api/moments/marked-check')
def todo_check_marked_moments():
    """批量检查哪些心动已被标星，返回 moment_id 列表"""
    marks = _load_marks()
    marked_ids = []
    for key, entry in marks.items():
        if entry.get('source') == 'heart-moment' and entry.get('momentId'):
            marked_ids.append(entry['momentId'])
    return jsonify({'marked_ids': marked_ids, 'total': len(marked_ids)})

# --- 记忆桶 API ---
def todo_find_mem_file(mid):
    for d in os.listdir(MEM_BUCKET):
        dp = os.path.join(MEM_BUCKET, d)
        if not os.path.isdir(dp): continue
        for f in os.listdir(dp):
            if not f.endswith('.md'): continue
            fp = os.path.join(dp, f)
            if mid in f: return (d, f, fp)
            try:
                with open(fp) as fh: head = fh.read(1024)
                if f'id: {mid}' in head or f"id: '{mid}'" in head or f'id: "{mid}"' in head: return (d, f, fp)
            except: continue
    return None

def todo_read_mem(fp):
    with open(fp) as f: raw = f.read()
    meta = {}; body = raw
    if raw.startswith('---'):
        parts = raw.split('---', 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split('\n'):
                if ':' in line:
                    k, _, v = line.partition(':'); k = k.strip(); v = v.strip().strip("'\"")
                    if not v or v == '[]': continue
                    meta[k] = v
            body = parts[2].strip()
    return meta, body, raw

@todo_bp.route('/todo/api/memories')
def todo_get_memories():
    import os
    results = []
    for d in sorted(os.listdir(MEM_BUCKET)):
        dp = os.path.join(MEM_BUCKET, d)
        if not os.path.isdir(dp): continue
        for fname in sorted(os.listdir(dp)):
            if not fname.endswith(".md"): continue
            fp = os.path.join(dp, fname)
            with open(fp) as fh: raw = fh.read()
            meta = {"importance": 5, "valence": 0.5, "arousal": 0.3, "tags": [], "domain": ["未分类"], "created": ""}
            body = raw
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    fm_lines = parts[1].strip().split('\n')
                    i = 0
                    while i < len(fm_lines):
                        line = fm_lines[i]
                        if ":" in line:
                            k, _, v = line.partition(":"); k = k.strip(); v = v.strip().strip("'\"")
                            if not v and i+1 < len(fm_lines) and fm_lines[i+1].strip().startswith("- "):
                                items = []; i += 1
                                while i < len(fm_lines) and fm_lines[i].strip().startswith("- "):
                                    items.append(fm_lines[i].strip()[2:].strip().strip("'\""))

                                    i += 1
                                if k == "tags": meta["tags"] = items
                                elif k == "domain": meta["domain"] = items if items else ["未分类"]
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
                                    if v.startswith("["): meta["tags"] = [t.strip().strip("'\"") for t in v.strip("[]").split(",") if t.strip()]
                                    elif v: meta["tags"] = [v]
                                elif k == "domain":
                                    if v.startswith("["): meta["domain"] = [t.strip().strip("'\"") for t in v.strip("[]").split(",") if t.strip()]
                                    elif v: meta["domain"] = [v]
                                elif k == "created": meta["created"] = v
                        i += 1
                    body = parts[2].strip()
            first_line = body.split('\n')[0] if body else ""
            name = first_line.replace("#", "").strip() if first_line.startswith("#") else ""
            display_body = '\n'.join(body.split('\n')[1:]).strip() if first_line.startswith("#") else body
            results.append({"id": fname.replace(".md",""), "domain": meta["domain"][0] if meta["domain"] else "未分类", "tags": meta["tags"], "importance": meta["importance"], "valence": meta["valence"], "arousal": meta["arousal"], "name": name or fname.replace(".md","")[:60], "created": meta.get("created",""), "content": display_body})
    return jsonify(results)

@todo_bp.route('/todo/api/memories/delete', methods=['POST'])
def todo_delete_memory():
    mid = request.json.get('id', '').strip()
    if not mid: return jsonify({'ok': False, 'error': 'no id'}), 400
    found = todo_find_mem_file(mid)
    if not found: return jsonify({'ok': False, 'error': 'not found'}), 404
    _, _, fp = found
    os.remove(fp)
    return jsonify({'ok': True})

@todo_bp.route('/todo/api/memories/update', methods=['POST'])
def todo_update_memory():
    body = request.json; mid = body.get('id', '').strip()
    new_content = body.get('content'); new_importance = body.get('importance'); new_domain = body.get('domain')
    if not mid: return jsonify({'ok': False, 'error': 'no id'}), 400
    found = todo_find_mem_file(mid)
    if not found: return jsonify({'ok': False, 'error': 'not found'}), 404
    _, _, fp = found
    meta, _, raw = todo_read_mem(fp)
    if raw.startswith('---'):
        parts = raw.split('---', 2)
        fm_lines = parts[1].split('\n')
        if new_importance is not None:
            found_imp = False
            for i, line in enumerate(fm_lines):
                if line.strip().startswith('importance:'):
                    fm_lines[i] = f'importance: {new_importance}'; found_imp = True; break
            if not found_imp: fm_lines.append(f'importance: {new_importance}')
        if new_domain is not None:
            i = 0; found_dom = False
            while i < len(fm_lines):
                if fm_lines[i].strip().startswith('domain:'):
                    fm_lines[i] = f'domain: {new_domain}'; i += 1
                    while i < len(fm_lines) and fm_lines[i].strip().startswith('- '): del fm_lines[i]
                    found_dom = True; break
                i += 1
            if not found_dom: fm_lines.append(f'domain: {new_domain}')
        new_fm = '\n'.join(fm_lines)
        final_content = new_content if new_content is not None else (parts[2].lstrip('\n') if len(parts) > 2 else '')
        new_raw = f'---{new_fm}---\n\n{final_content}'
    else:
        new_raw = new_content if new_content else raw
    with open(fp, 'w') as f: f.write(new_raw)
    return jsonify({'ok': True})

@todo_bp.route('/todo/api/memories/domains')
def todo_get_domains():
    domains = set()
    for d in sorted(os.listdir(MEM_BUCKET)):
        dp = os.path.join(MEM_BUCKET, d)
        if not os.path.isdir(dp): continue
        for fname in sorted(os.listdir(dp)):
            if not fname.endswith(".md"): continue
            fp = os.path.join(dp, fname)
            with open(fp) as f: raw = f.read()
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    for line in parts[1].strip().split("\n"):
                        if line.strip().startswith("domain:"):
                            val = line.split(":", 1)[1].strip().strip("'\"")
                            if val: domains.add(val)
                            break
    return jsonify(sorted(domains))

# ============================================================
# 注册 Blueprints
# ============================================================
app.register_blueprint(diary_bp)
app.register_blueprint(goban_bp)
app.register_blueprint(notes_bp)
app.register_blueprint(monthly_bp)
app.register_blueprint(todo_bp)

if __name__ == '__main__':
    print("统一后端服务启动: http://0.0.0.0:8777")
    app.run(host='0.0.0.0', port=8777, debug=False)