#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云服务器 MCP 助手 v2 —— AI 友好的项目文件操作
=================================================
- 独立运行在 9010 端口，与旧版 9000 服务互不影响
- 提供：列目录 / 读文件 / 写文件 / 搜索 / 文件信息 / 执行命令 / 服务器状态 / git 只读操作
- 文件读写受 config.json 白名单限制（写操作只允许项目目录）
- 命令执行改为本地 subprocess，不再 SSH 绕回自己
"""

import fnmatch
import json
import os
import re
import stat
import subprocess
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs

import uvicorn
from fastmcp import FastMCP
from fastmcp.server.http import create_sse_app

# ===================== 配置加载 =====================
BASE_DIR = Path(__file__).resolve().parent


def _load_config() -> dict:
    with open(BASE_DIR / "config.json", "r", encoding="utf-8") as f:
        return json.load(f)


CONFIG = _load_config()

API_KEY = str(CONFIG.get("api_key", "Rsh200506@11111"))
DEFAULT_TIMEOUT = int(CONFIG.get("default_timeout", 30))
MAX_OUTPUT = int(CONFIG.get("max_output_chars", 200000))
MAX_LIST_ENTRIES = int(CONFIG.get("max_list_entries", 500))
READ_ROOTS = [Path(p).resolve() for p in CONFIG.get("read_dirs", [])]
WRITE_ROOTS = [Path(p).resolve() for p in CONFIG.get("write_dirs", [])]
DENY_WRITE_ROOTS = [Path(p).resolve() for p in CONFIG.get("deny_write_dirs", [])]

mcp = FastMCP("云服务器 MCP 助手 v2")

# ===================== 通用工具函数 =====================


def _fmt_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 ** 2:
        return f"{n / 1024:.1f} KB"
    if n < 1024 ** 3:
        return f"{n / 1024 ** 2:.1f} MB"
    return f"{n / 1024 ** 3:.1f} GB"


def _truncate(text: str, limit: int = MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（输出过长已截断：共 {len(text)} 字符，仅保留前 {limit} 字符）"


def _safe_resolve(path: str, for_write: bool = False) -> Path:
    """解析为绝对路径，并确保落在白名单内（防符号链接逃逸）。"""
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError("请使用绝对路径，例如 /root/workspace/xxx")
    missing = []
    cur = p
    while not cur.exists():
        missing.insert(0, cur.name)
        cur = cur.parent
    resolved = cur.resolve(strict=True)
    for part in missing:
        resolved = resolved / part
    roots = WRITE_ROOTS if for_write else (READ_ROOTS + WRITE_ROOTS)
    allowed = False
    for root in roots:
        try:
            resolved.relative_to(root)
            allowed = True
            break
        except ValueError:
            continue
    if not allowed:
        raise PermissionError(f"路径不在允许范围内（可编辑 config.json 调整白名单）: {path}")
    if for_write:
        for deny in DENY_WRITE_ROOTS:
            try:
                resolved.relative_to(deny)
            except ValueError:
                continue
            raise PermissionError(f"路径属于受保护的系统目录，禁止写入: {path}")
    return resolved


def _read_lines(p: Path, start_line: int, end_line: int, limit: int) -> str:
    start_line = max(1, int(start_line))
    out = []
    total = 0
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i < start_line:
                continue
            if end_line and i > end_line:
                break
            total += len(line)
            if total > limit:
                out.append(f"…（第 {i} 行起超出输出上限，请缩小行号范围）")
                break
            out.append(f"{i:>6} | {line.rstrip()}")
    return "\n".join(out)


# ===================== 文件操作工具 =====================


@mcp.tool()
def list_dir(path: str, depth: int = 1, show_hidden: bool = False) -> str:
    """列出目录内容，返回带类型和文件大小的树状列表。depth 最多 4 层。"""
    depth = max(1, min(int(depth), 4))
    root = _safe_resolve(path)
    if not root.is_dir():
        return f"错误: 不是目录: {root}"
    lines = []
    count = 0

    def walk(d: Path, level: int) -> None:
        nonlocal count
        indent = "  " * level
        try:
            entries = sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        except PermissionError:
            lines.append(f"{indent}[无权限读取]")
            return
        for entry in entries:
            if count >= MAX_LIST_ENTRIES:
                lines.append(f"{indent}…（条目过多已截断，建议用 search_text 或减小 depth）")
                return
            if entry.name.startswith(".") and not show_hidden:
                continue
            count += 1
            try:
                if entry.is_dir():
                    lines.append(f"{indent}📁 {entry.name}/")
                    if level < depth:
                        walk(entry, level + 1)
                else:
                    lines.append(f"{indent}📄 {entry.name}  ({_fmt_size(entry.stat().st_size)})")
            except OSError:
                lines.append(f"{indent}❓ {entry.name}")

    walk(root, 0)
    return _truncate(f"📂 {root}\n" + "\n".join(lines))


@mcp.tool()
def read_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
    """读取文件内容（带行号）。支持 start_line/end_line 分段读取大文件。"""
    p = _safe_resolve(path)
    if not p.is_file():
        return f"错误: 不是文件: {p}"
    size = p.stat().st_size
    if size > MAX_OUTPUT:
        note = f"⚠️ 文件较大（{_fmt_size(size)}），已限制读取量。建议先用 search_text 定位，再用 start_line/end_line 分段读取。\n\n"
    else:
        note = ""
    return note + _read_lines(p, start_line, end_line, MAX_OUTPUT)


@mcp.tool()
def write_file(path: str, content: str, mode: str = "overwrite") -> str:
    """写入或追加文件内容。除受保护的系统目录外均可写。mode: overwrite（覆盖）/ append（追加）/ create（仅新建）"""
    p = _safe_resolve(path, for_write=True)
    mode = mode.lower()
    try:
        if mode == "append":
            with open(p, "a", encoding="utf-8") as f:
                f.write(content)
        else:
            if mode == "create" and p.exists():
                return f"错误: 文件已存在，如需覆盖请用 overwrite: {p}"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
    except Exception as e:
        return f"写入失败: {e}"
    return f"✅ 已写入 {p}（{_fmt_size(p.stat().st_size)}）"


# 内容行时间戳识别与区间过滤（search_text 可选时间参数用）
_TS_RE = re.compile(r"(\d{4}[-/]\d{2}[-/]\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)")


def _parse_time_bound(s: str):
    """解析绝对时间字符串，支持 2026-08-01 或 2026-08-01 10:00:00。"""
    s = (s or "").strip().strip('"\'')
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
                "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _line_in_time_range(line: str, time_start, time_end) -> bool:
    """行内容里出现的时间戳是否落在 [time_start, time_end]（任一为空表示不限）。"""
    if time_start is None and time_end is None:
        return True
    m = _TS_RE.search(line)
    if not m:
        return False
    hms = m.group(2) if len(m.group(2)) == 8 else m.group(2) + ":00"
    try:
        ts = datetime.strptime(m.group(1).replace("/", "-") + " " + hms, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    if time_start is not None and ts < time_start:
        return False
    if time_end is not None and ts > time_end:
        return False
    return True


@mcp.tool()
def search_text(pattern: str, path: str = "/root/workspace", file_filter: str = "*", max_results: int = 100,
                start_time: str = "", end_time: str = "") -> str:
    """在目录或单个文件中搜索文本（支持正则），返回 文件:行号:内容。目录模式自动跳过 .git/node_modules 等目录。
    start_time/end_time 为可选绝对时间（如 2026-08-01 或 2026-08-01 10:00:00），传入后仅返回内容行时间戳落在区间内的匹配。"""
    target = _safe_resolve(path)
    try:
        regex = re.compile(pattern)
    except re.error as e:
        return f"正则表达式错误: {e}"
    max_results = max(1, min(int(max_results), 500))
    time_start = _parse_time_bound(start_time) if start_time else None
    time_end = _parse_time_bound(end_time) if end_time else None
    if start_time and time_start is None:
        return f"时间格式无法解析: {start_time!r}（支持 2026-08-01 或 2026-08-01 10:00:00）"
    if end_time and time_end is None:
        return f"时间格式无法解析: {end_time!r}（支持 2026-08-01 或 2026-08-01 10:00:00）"
    time_filter_on = time_start is not None or time_end is not None
    matches = []

    def scan_file(fp: Path) -> None:
        if len(matches) >= max_results:
            return
        if not fp.is_file():
            return
        try:
            if os.path.getsize(fp) > 2 * 1024 * 1024:
                return
            with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                for lineno, line in enumerate(f, 1):
                    if regex.search(line) and _line_in_time_range(line, time_start, time_end):
                        matches.append(f"{fp}:{lineno}: {line.rstrip()[:200]}")
                        if len(matches) >= max_results:
                            return
        except (OSError, UnicodeDecodeError):
            return

    if target.is_file():
        kind = "文件"
        scan_file(target)
    elif target.is_dir():
        kind = "目录"
        skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".cache", ".next", ".idea", ".vscode"}
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = sorted(d for d in dirnames if d not in skip_dirs)
            for name in sorted(filenames):
                if not fnmatch.fnmatch(name, file_filter):
                    continue
                scan_file(Path(dirpath) / name)
                if len(matches) >= max_results:
                    break
            if len(matches) >= max_results:
                break
    else:
        return f"错误: 路径不存在: {target}"
    time_note = ""
    if time_filter_on:
        time_note = f"（时间过滤: {start_time or '不限'} ~ {end_time or '不限'}）"
    head = f"🔍 在{kind} {target} 找到 {len(matches)} 处匹配" + ("（已达上限）" if len(matches) >= max_results else "") + time_note + chr(10)
    return _truncate(head + chr(10).join(matches))


@mcp.tool()
def file_info(path: str) -> str:
    """查看文件/目录信息：类型、大小、修改时间、权限。"""
    p = _safe_resolve(path)
    st = p.stat()
    kind = "📁 目录" if p.is_dir() else "📄 文件"
    return (
        f"路径: {p}\n"
        f"类型: {kind}\n"
        f"大小: {_fmt_size(st.st_size)}\n"
        f"修改时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))}\n"
        f"权限: {stat.filemode(st.st_mode)}"
    )


# ===================== 执行与状态工具 =====================


@mcp.tool()
def run_command(command: str, cwd: str = "", timeout: int = 30) -> str:
    """在服务器上执行 shell 命令（本地直接执行）。可用 cwd 指定工作目录、timeout 调整超时（最长 300 秒）。"""
    timeout = min(max(int(timeout), 1), 300)
    workdir = None
    if cwd:
        workdir = _safe_resolve(cwd)
        if not workdir.is_dir():
            return f"错误: 工作目录不存在: {workdir}"
    try:
        proc = subprocess.run(
            command, shell=True, cwd=workdir,
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        return f"⏱️ 命令超时（>{timeout} 秒）已终止。建议缩小操作范围或调大 timeout。"
    except Exception as e:
        return f"执行出错: {e}"
    out = proc.stdout or ""
    if proc.stderr:
        out += "\n[stderr]\n" + proc.stderr
    result = _truncate(out)
    if proc.returncode != 0:
        result += f"\n\n⚠️ 退出码: {proc.returncode}"
    return result


@mcp.tool()
def get_server_status() -> str:
    """查看服务器 CPU、内存、磁盘状态。"""
    return run_command("echo '=== CPU 负载 ===' && uptime && echo '=== 内存 ===' && free -h && echo '=== 磁盘 ===' && df -h /")


# ===================== git 只读工具 =====================


def _git_run(path: str, args: list) -> str:
    p = _safe_resolve(path)
    if not p.exists():
        return f"错误: 路径不存在: {p}"
    # 传单文件时定位到所在目录（git -C 会向上找仓库根），并把 diff/status/log 聚焦到该文件
    file_part = None
    if p.is_file():
        file_part = p.name
        p = p.parent
    try:
        proc = subprocess.run(
            ["git", "-C", str(p), *args] + (["--", file_part] if file_part else []),
            capture_output=True, text=True, timeout=20,
            encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        return "⏱️ git 操作超时"
    except Exception as e:
        return f"git 执行出错: {e}"
    out = proc.stdout or ""
    if proc.stderr:
        out += "\n[stderr]\n" + proc.stderr
    return _truncate(out)


@mcp.tool()
def git_status(path: str) -> str:
    """查看项目的 git 状态：当前分支、已修改/未跟踪文件（只读）。path 传项目目录或单文件（传文件时只显示该文件的状态）。"""
    return _git_run(path, ["status", "--short", "--branch"])


@mcp.tool()
def git_log(path: str, count: int = 10) -> str:
    """查看最近提交记录（只读）。count 为条数。path 传项目目录或单文件（传文件时只显示该文件的提交历史）。"""
    count = max(1, min(int(count), 100))
    return _git_run(path, ["log", "--oneline", "-n", str(count)])


@mcp.tool()
def git_diff(path: str, staged: bool = False) -> str:
    """查看工作区改动内容（只读）。staged=True 时查看已暂存（git add 过）的改动。path 传项目目录（整个仓库的改动）或单文件（只看该文件的改动）。"""
    args = ["diff"] + (["--cached"] if staged else [])
    return _git_run(path, args)


# ===================== 鉴权中间件 =====================


class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    @staticmethod
    def _extract_key(scope):
        headers = dict(scope.get("headers", []))
        for raw_k, raw_v in headers.items():
            if raw_k.decode().lower() == "x-api-key":
                return raw_v.decode()
        cookie_header = headers.get(b"cookie", b"").decode()
        for pair in cookie_header.split(";"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                if k.strip() == "X-API-Key":
                    return v.strip()
        qs = scope.get("query_string", b"").decode()
        params = parse_qs(qs)
        return (params.get("X-API-Key") or [None])[0]

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            method = scope.get("method", "")

            # 健康检查放行
            if path == "/health":
                pass
            # 传统 SSE 的消息端点需要鉴权
            elif path.startswith("/messages/"):
                if self._extract_key(scope) != API_KEY:
                    body = b'{"error":"Unauthorized"}'
                    await send({
                        "type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
                    })
                    await send({"type": "http.response.body", "body": body})
                    return
            # Streamable HTTP 的 /sse 端点
            elif path == "/sse":
                if method == "POST":
                    pass
                else:
                    qs = scope.get("query_string", b"").decode()
                    params = parse_qs(qs)
                    if "session_id" not in params and self._extract_key(scope) != API_KEY:
                        body = b'{"error":"Unauthorized"}'
                        await send({
                            "type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
                        })
                        await send({"type": "http.response.body", "body": body})
                        return

        await self.app(scope, receive, send)


# ===================== 路由与启动 =====================

if __name__ == "__main__":
    http_app = mcp.http_app(path="/sse", transport="streamable-http")
    sse_app = create_sse_app(mcp, sse_path="/sse", message_path="/messages/")

    class RouterApp:
        def __init__(self, http_app, sse_app):
            self.http_app = http_app
            self.sse_app = sse_app

        async def __call__(self, scope, receive, send):
            if scope["type"] == "lifespan":
                await self.http_app(scope, receive, send)
                return
            if scope["type"] == "http":
                path = scope.get("path", "")
                if path == "/sse":
                    await self.http_app(scope, receive, send)
                elif path.startswith("/messages/"):
                    await self.sse_app(scope, receive, send)
                elif path == "/health":
                    body = b'{"status":"ok"}'
                    await send({
                        "type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
                    })
                    await send({"type": "http.response.body", "body": body})
                else:
                    body = b'{"error":"Not Found"}'
                    await send({
                        "type": "http.response.start", "status": 404,
                        "headers": [(b"content-type", b"application/json")],
                    })
                    await send({"type": "http.response.body", "body": body})

    router = RouterApp(http_app, sse_app)
    app = AuthMiddleware(router)

    uvicorn.run(app, host="0.0.0.0", port=9010, log_level="info")
