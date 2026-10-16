import os, json, datetime
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')
DATA = os.path.join(os.path.dirname(__file__), 'data.json')

def load():
    if not os.path.exists(DATA):
        return {"todos": {}, "moments": []}
    with open(DATA) as f: return json.load(f)

def save(d):
    with open(DATA, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2)

@app.route('/')
def idx():
    return send_from_directory('.', 'index.html')

@app.route('/api/todos')
def get_todos():
    d = load()
    todos = d.get("todos", {})
    result = []
    seen = set()
    for date in sorted(todos.keys(), reverse=True):
        for t in todos[date]:
            if not t.get('done', False) and t['id'] not in seen:
                seen.add(t['id'])
                result.append(t)
    result.sort(key=lambda x: x['id'])
    return jsonify(result)

@app.route('/api/todos/delete', methods=['POST'])
def delete_todo():
    body = request.json
    tid = body.get("id")
    d = load()
    todos = d.get("todos", {})
    for date in list(todos.keys()):
        todos[date] = [t for t in todos[date] if t['id'] != tid]
        if not todos[date]:
            del todos[date]
    d['todos'] = todos
    save(d)
    return jsonify({"ok": True})

@app.route('/api/todos/add', methods=['POST'])
def add_todo_han():
    body = request.json
    text = body.get("text", "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    d = load()
    today = datetime.date.today().isoformat()
    if today not in d["todos"]:
        d["todos"][today] = []
    tid = max((t['id'] for day in d['todos'].values() for t in day), default=0) + 1
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    d["todos"][today].append({"id": tid, "text": f"{text} {now}", "done": False, "by": "han"})
    save(d)
    return jsonify({"ok": True})

@app.route('/api/todos/xie', methods=['POST'])
def xie_todo():
    body = request.json
    text = body.get("text", "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    d = load()
    today = datetime.date.today().isoformat()
    if today not in d["todos"]:
        d["todos"][today] = []
    tid = max((t['id'] for day in d['todos'].values() for t in day), default=0) + 1
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    d["todos"][today].append({"id": tid, "text": f"📌 {text} {now}", "done": False, "by": "xie"})
    save(d)
    return jsonify({"ok": True})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8768, debug=False)
