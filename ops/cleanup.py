#!/usr/bin/env python3
# 清理 data/ 下应用自动生成的备份/临时文件，每组保留最近 2 份（维护运维）
# 批注 2026-09-13（审查 D4）：新增 uploads 超期清理（默认 365 天）与 bark_tasks 日志截断（>10MB 留末尾 1MB）。
# 加 --dry-run 只看不删。
import os, re, sys, time
d = "/opt/dylan-heartbeat/data"
dry = "--dry-run" in sys.argv
def base_of(f):
    m = re.match(r"^(.*)\.bak-", f)
    if m: return m.group(1)
    if f.startswith("_fix_backup_"): return "_fix_backup_"
    if f.endswith(".tmp"): return f[:-4]
    return None
groups = {}
for f in os.listdir(d):
    p = os.path.join(d, f)
    if not os.path.isfile(p): continue
    b = base_of(f)
    if b is None: continue
    groups.setdefault(b, []).append(f)
removed = 0; freed = 0
for b, fs in groups.items():
    fs.sort(reverse=True)
    for f in fs[2:]:
        p = os.path.join(d, f)
        try:
            sz = os.path.getsize(p)
            if not dry: os.remove(p)
            removed += 1; freed += sz
            if dry: print("would remove:", f)
        except Exception: pass

# ---- uploads 保留期清理（审查 D4：按 mtime 超过 N 天删除；注意老消息引用被删图片会 404）----
UPLOADS_DIR = os.path.join(d, "uploads")
UPLOAD_RETENTION_DAYS = 365
up_removed = 0; up_freed = 0
cutoff = time.time() - UPLOAD_RETENTION_DAYS * 86400
if os.path.isdir(UPLOADS_DIR):
    for f in os.listdir(UPLOADS_DIR):
        p = os.path.join(UPLOADS_DIR, f)
        if not os.path.isfile(p): continue
        try:
            st = os.stat(p)
            if st.st_mtime < cutoff:
                if not dry: os.remove(p)
                up_removed += 1; up_freed += st.st_size
                if dry: print("would remove upload:", f)
        except Exception: pass

# ---- bark_tasks 日志截断（审查 D4：排查用日志，>10MB 保留末尾 1MB）----
LOG_MAX = 10 * 1024 * 1024
LOG_KEEP = 1 * 1024 * 1024
BARK_LOGS = ["/opt/dylan-heartbeat/bark_tasks/log.txt", "/root/bark_tasks/log.txt"]
log_trunc = 0
for lp in BARK_LOGS:
    try:
        if os.path.isfile(lp) and os.path.getsize(lp) > LOG_MAX:
            if not dry:
                with open(lp, "rb") as fh:
                    fh.seek(-LOG_KEEP, os.SEEK_END)
                    tail = fh.read()
                tmp = lp + ".trunc"
                with open(tmp, "wb") as out:
                    out.write(("[log truncated %s]\n" % time.strftime("%Y-%m-%d %H:%M:%S")).encode())
                    out.write(tail)
                os.replace(tmp, lp)
            log_trunc += 1
            print("log truncated (dry=%s): %s" % ("1" if dry else "0", lp))
    except Exception as e:
        print("log truncate failed:", lp, e)

print("groups=%d removed=%d freed=%.1fMB uploads_removed=%d uploads_freed=%.1fMB log_trunc=%d dry=%s" % (
    len(groups), removed, freed / 1024 / 1024, up_removed, up_freed / 1024 / 1024, log_trunc, "1" if dry else "0"))
