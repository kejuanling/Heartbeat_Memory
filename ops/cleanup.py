#!/usr/bin/env python3
# 清理 data/ 下应用自动生成的备份/临时文件，每组保留最近 2 份（维护运维）
import os, re, sys
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
print("groups=%d removed=%d freed=%.1fMB dry=%s" % (len(groups), removed, freed/1024/1024, "1" if dry else "0"))
