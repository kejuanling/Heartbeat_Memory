#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云服务器 MCP 助手 v2 —— AI 友好的项目文件操作
=================================================
- 独立运行在 9010 端口，与旧版 9000 服务互不影响
- 提供：列目录 / 读文件 / 写文件 / 搜索 / 文件信息 / 执行命令 / 服务器状态 / git 只读操作
- 文件读写受 config.json 白名单限制（写操作只允许项目目录）
- 命令执行改为本地 subprocess，不再 SSH 绕回自己
- 双协议对外：streamable-http（/mcp 标准）+ 传统 SSE（/sse + /messages/，/legacy-sse 为兼容别名）
- 全路径鉴权（X-API-Key / Bearer / Cookie / URL 参数 / 会话 ID）+ CORS，见 AuthMiddleware
"""

import contextlib
import fnmatch
import hmac
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
    # 先规范化 . / ..，再解析现存路径段，避免 relative_to 对未规范化路径误判。
    p = Path(os.path.abspath(str(p)))
    missing = []
    cur = p
    while not cur.exists() and not cur.is_symlink():
        if cur.parent == cur:
            raise FileNotFoundError(f"无法解析路径: {path}")
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
def list_dir(path: str, depth: int = 1, show_hidden: bool = False, max_entries: int = 200) -> str:
    """以紧凑树状结构列出目录。先列完当前目录，再展开子目录，避免大目录吞掉后续结果。
    depth 最多 4 层；max_entries 限制总条目数。默认跳过常见依赖/缓存目录的展开，不跟随符号链接。"""
    depth = max(1, min(int(depth), 4))
    max_entries = max(1, min(int(max_entries), MAX_LIST_ENTRIES))
    root = _safe_resolve(path)
    if not root.is_dir():
        return f"错误: 不是目录: {root}"

    # 这些目录通常体积巨大、对项目结构判断帮助不大；仍显示目录本身，但默认不递归展开。
    skip_expand = {
        'node_modules', '__pycache__', '.git', '.venv', 'venv', 'env',
        'site-packages', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
        '.next', 'coverage', 'dist', 'build'
    }
    lines = [f"目录: {root}"]
    count = 0
    truncated = False

    def get_entries(d: Path):
        try:
            entries = list(os.scandir(d))
        except (PermissionError, OSError):
            return None
        entries = [e for e in entries if show_hidden or not e.name.startswith('.')]
        def sort_key(e):
            try:
                if e.is_symlink():
                    kind = 1
                elif e.is_dir(follow_symlinks=False):
                    kind = 0
                else:
                    kind = 2
            except OSError:
                kind = 3
            name = e.name.casefold()
            backup_like = (
                name.startswith(('backup_', 'backup-', 'archive', 'recovery_'))
                or name.endswith(('.bak', '.old', '.orig', '.swp', '~', '.tar.gz', '.zip'))
                or '.bak-' in name or '.bak.' in name
            )
            return (kind, 1 if backup_like else 0, name)
        return sorted(entries, key=sort_key)

    def describe(entry, indent):
        nonlocal count, truncated
        if count >= max_entries:
            truncated = True
            return None
        count += 1
        prefix = '  ' * indent
        try:
            if entry.is_symlink():
                try:
                    target = os.readlink(entry.path)
                except OSError:
                    target = '?'
                lines.append(f"{prefix}[LINK] {entry.name} -> {target}")
                return None
            if entry.is_dir(follow_symlinks=False):
                suffix = '（默认不展开）' if entry.name in skip_expand else ''
                lines.append(f"{prefix}[DIR]  {entry.name}/{suffix}")
                return Path(entry.path) if entry.name not in skip_expand else None
            try:
                size = _fmt_size(entry.stat(follow_symlinks=False).st_size)
            except OSError:
                size = '大小未知'
            lines.append(f"{prefix}[FILE] {entry.name} ({size})")
        except OSError:
            lines.append(f"{prefix}[?]    {entry.name}")
        return None

    # 每层先列出所有直接子项，再进入子目录，防止第一个大目录占满整个输出。
    def walk(d: Path, level: int, indent: int):
        nonlocal truncated
        entries = get_entries(d)
        if entries is None:
            lines.append('  ' * indent + '[无法读取目录]')
            return
        children = []
        per_dir_limit = 80
        visible_entries = entries[:per_dir_limit]
        for entry in visible_entries:
            child = describe(entry, indent)
            if child is not None and level < depth:
                children.append((child, entry.name))
            if truncated:
                break
        if len(entries) > len(visible_entries) and not truncated:
            lines.append('  ' * indent + f'…本目录另有 {len(entries) - len(visible_entries)} 项未列出')
        for child, name in children:
            if truncated:
                break
            lines.append('  ' * indent + f'展开 {name}/')
            walk(child, level + 1, indent + 1)

    walk(root, 1, 0)
    if truncated:
        lines.append(f'…已达到 max_entries={max_entries} 条上限；可缩小 depth 或指定更具体的 path。')
    return _truncate('\n'.join(lines))

@mcp.tool()
def find_files(pattern: str, path: str = "/root/workspace", max_results: int = 100,
               include_hidden: bool = False, include_backups: bool = False) -> str:
    """按文件名或通配符查找文件/目录，不搜索文件内容。默认跳过依赖、缓存和备份；返回路径、类型、大小。"""
    target = _safe_resolve(path)
    if not target.exists():
        return f"错误: 路径不存在: {target}"
    try:
        matcher = re.compile(fnmatch.translate(pattern), re.IGNORECASE)
    except re.error as e:
        return f"文件名模式错误: {e}"
    max_results = max(1, min(int(max_results), 500))
    skip_dirs = {
        ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
        "site-packages", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
        ".next", "coverage", "dist", "build"
    }
    def is_backup(name: str) -> bool:
        n = name.casefold()
        return (n.startswith(("backup_", "backup-", "archive_", "recovery_"))
                or n.endswith((".bak", ".old", ".orig", ".swp", "~", ".tar.gz", ".zip"))
                or ".bak-" in n or ".bak." in n)
    found = []
    scanned = 0
    scan_limit = 20000

    def add_entry(p: Path, is_dir: bool):
        try:
            if is_dir:
                found.append(f"[DIR]  {p}/")
            else:
                st = p.stat(follow_symlinks=False)
                found.append(f"[FILE] {p} ({_fmt_size(st.st_size)})")
        except OSError:
            found.append(f"[?] {p}")

    if target.is_file():
        if matcher.fullmatch(target.name):
            add_entry(target, False)
    elif target.is_dir():
        for dirpath, dirnames, filenames in os.walk(target, followlinks=False):
            current = Path(dirpath)
            dirnames[:] = sorted(
                d for d in dirnames
                if (include_hidden or not d.startswith("."))
                and d not in skip_dirs
                and (include_backups or not is_backup(d))
                and not (current / d).is_symlink()
            )
            entries = [(name, True) for name in dirnames] + [(name, False) for name in filenames]
            entries.sort(key=lambda item: (0 if item[1] else 1, item[0].casefold()))
            for name, is_dir in entries:
                if not include_hidden and name.startswith("."):
                    continue
                if not include_backups and is_backup(name):
                    continue
                scanned += 1
                p = current / name
                if p.is_symlink():
                    continue
                if matcher.fullmatch(name):
                    add_entry(p, is_dir)
                    if len(found) >= max_results:
                        break
                if scanned >= scan_limit:
                    break
            if len(found) >= max_results or scanned >= scan_limit:
                break
    else:
        return f"错误: 不支持的路径类型: {target}"

    lines = [f"文件名匹配: {pattern}", f"搜索范围: {target}", f"匹配数量: {len(found)}"]
    lines.extend(found)
    if len(found) >= max_results:
        lines.append(f"…已达到 max_results={max_results} 上限")
    if scanned >= scan_limit:
        lines.append(f"…已扫描 {scan_limit} 项，搜索提前停止；可缩小 path 或使用更具体的 pattern")
    if not found:
        lines.append("没有找到匹配项")
    return _truncate("\\n".join(lines))


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
    mode = (mode or "overwrite").strip().lower()
    if mode not in {"overwrite", "append", "create"}:
        return "错误: mode 仅支持 overwrite、append、create"
    if p.exists() and p.is_dir():
        return f"错误: 目标是目录，不是文件: {p}"
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
        # 不读取符号链接文件，避免搜索范围意外越过指定目录。
        if fp.is_symlink() or not fp.is_file():
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
    try:
        p = _safe_resolve(path)
        st = p.stat()
    except FileNotFoundError:
        return f"错误: 路径不存在: {path}"
    except PermissionError as e:
        return f"错误: 无权访问路径: {path}（{e}）"
    except OSError as e:
        return f"读取路径信息失败: {path}（{e}）"
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
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    sections = []
    if stdout.strip():
        sections.append("[stdout]\\n" + stdout.rstrip())
    if stderr.strip():
        sections.append("[stderr]\\n" + stderr.rstrip())
    if not sections:
        sections.append("(命令未产生输出)")
    result = _truncate("\\n\\n".join(sections))
    result += f"\\n\\n退出码: {proc.returncode}"
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


# ===================== 鉴权与 CORS 中间件 =====================


def _cors_headers(scope) -> list:
    """按请求 Origin 回 CORS 头（无 Origin 则 *），供浏览器类 agent 直连。"""
    origin = None
    for raw_k, raw_v in scope.get("headers", []):
        if raw_k.decode().lower() == "origin":
            origin = raw_v.decode()
            break
    return [
        (b"access-control-allow-origin", (origin or "*").encode()),
        (b"access-control-allow-methods", b"GET, POST, DELETE, OPTIONS"),
        (b"access-control-allow-headers",
         b"content-type, accept, x-api-key, authorization, mcp-session-id, last-event-id"),
        (b"access-control-expose-headers", b"mcp-session-id"),
        (b"access-control-max-age", b"86400"),
        (b"vary", b"Origin"),
    ]


class AuthMiddleware:
    """最外层中间件：CORS 预检放行 + 业务路径统一鉴权 + 响应补 CORS 头。

    鉴权任选其一：X-API-Key 头 / Authorization: Bearer / Cookie X-API-Key / URL 参数 X-API-Key；
    带 mcp-session-id 头的请求视为 initialize 时已通过鉴权建立的会话，直接放行。
    """

    def __init__(self, app):
        self.app = app

    @staticmethod
    def _extract_key(scope):
        headers = dict(scope.get("headers", []))
        for raw_k, raw_v in headers.items():
            k = raw_k.decode().lower()
            if k == "x-api-key":
                return raw_v.decode()
            if k == "authorization":
                v = raw_v.decode().strip()
                return v[7:].strip() if v.lower().startswith("bearer ") else v
        cookie_header = headers.get(b"cookie", b"").decode()
        for pair in cookie_header.split(";"):
            if "=" in pair:
                ck, cv = pair.split("=", 1)
                if ck.strip() == "X-API-Key":
                    return cv.strip()
        params = parse_qs(scope.get("query_string", b"").decode())
        return (params.get("X-API-Key") or [None])[0]

    def _authorized(self, scope) -> bool:
        headers = dict(scope.get("headers", []))
        if any(k.decode().lower() == "mcp-session-id" and v for k, v in headers.items()):
            return True
        key = self._extract_key(scope)
        if not isinstance(key, str):
            return False
        try:
            return hmac.compare_digest(key, API_KEY)
        except TypeError:
            return False

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "")

        # CORS 预检不带凭据，直接放行
        if method == "OPTIONS":
            headers = _cors_headers(scope) + [(b"content-length", b"0")]
            await send({"type": "http.response.start", "status": 204, "headers": headers})
            await send({"type": "http.response.body", "body": b""})
            return

        # 除 /health 外所有路径都要鉴权（堵住此前 POST /sse 匿名直进的洞）
        if path != "/health" and not self._authorized(scope):
            body = b'{"error":"Unauthorized"}'
            headers = [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ] + _cors_headers(scope)
            await send({"type": "http.response.start", "status": 401, "headers": headers})
            await send({"type": "http.response.body", "body": body})
            return

        async def send_with_cors(event):
            if event["type"] == "http.response.start":
                event = dict(event)
                event["headers"] = list(event.get("headers", [])) + _cors_headers(scope)
            await send(event)

        await self.app(scope, receive, send_with_cors)


# ===================== 路由与启动 =====================

if __name__ == "__main__":
    # streamable-http：标准路径 /mcp
    http_app = mcp.http_app(path="/mcp", transport="streamable-http")
    # 传统 SSE（2024-11-05 协议客户端用）：GET /sse 建立事件流，POST /messages/ 收消息（/legacy-sse 为兼容别名）
    sse_app = create_sse_app(mcp, sse_path="/sse", message_path="/messages/")

    class RouterApp:
        def __init__(self, http_app, sse_app):
            self.http_app = http_app
            self.sse_app = sse_app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return
            path = scope.get("path", "")
            if path == "/mcp":
                await self.http_app(scope, receive, send)
            elif path in ("/sse", "/legacy-sse") or path.startswith("/messages/"):
                if path == "/legacy-sse":
                    scope = dict(scope)
                    scope["path"] = "/sse"
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

    class LifespanApp:
        """合并两个子应用的 lifespan（各拉起各的会话管理器），请求全部转给 router。"""

        def __init__(self, router):
            self.router = router
            self._stack = None

        async def __call__(self, scope, receive, send):
            if scope["type"] == "lifespan":
                await self._lifespan(receive, send)
                return
            await self.router(scope, receive, send)

        async def _lifespan(self, receive, send):
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    break
            try:
                stack = contextlib.AsyncExitStack()
                await stack.enter_async_context(http_app.lifespan(http_app))
                await stack.enter_async_context(sse_app.lifespan(sse_app))
                self._stack = stack
                await send({"type": "lifespan.startup.complete"})
            except Exception as e:
                await send({"type": "lifespan.startup.failed", "message": str(e)})
                return
            while True:
                message = await receive()
                if message["type"] == "lifespan.shutdown":
                    break
            try:
                await self._stack.aclose()
                await send({"type": "lifespan.shutdown.complete"})
            except Exception as e:
                await send({"type": "lifespan.shutdown.failed", "message": str(e)})

    router = RouterApp(http_app, sse_app)
    app = AuthMiddleware(LifespanApp(router))

    uvicorn.run(app, host="0.0.0.0", port=9010, log_level="info")
