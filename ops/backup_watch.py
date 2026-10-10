#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""backup_watch.py — 每日备份守卫（2026-10-10 上线，事故后防再断档）

每天 04:15 由 cron 调用 check：扫描 archives/ 最新 ops_*.tar.gz，
若今天无新备份则 Bark 告警 + 落盘 data/sentinel_events.json（后台活动「后台提醒」栏可见）。

复用日志哨兵通道：BARK_KEY 取 .env，事件文件/冷却目录与 log_sentinel.py 同源。
独立脚本，不 import log_sentinel，职责单一（只检查备份，不动哨兵主循环）。

用法：
  python3 backup_watch.py check   # 常规检查（cron 每天 04:15）
  python3 backup_watch.py test    # 发一条测试推送
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime

ARCHIVES = "/opt/dylan-heartbeat/archives"
BARK_ENV = "/opt/dylan-heartbeat/.env"
BARK_GROUP = "yun"
STATE_DIR = "/root/.log_sentinel"
EVENTS_FILE = "/opt/dylan-heartbeat/data/sentinel_events.json"
EVENTS_KEEP = 50
COOLDOWN = 1800
OPS_PAT = re.compile(r"^ops_(\d{8})_\d{6}\.tar\.gz$")


def load_bark_key():
    try:
        with open(BARK_ENV, errors="replace") as f:
            for line in f:
                if line.strip().startswith("BARK_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def bark(title, body):
    key = load_bark_key()
    if not key:
        print("NO-BARK-KEY, suppressed:", title, "|", body)
        return
    payload = json.dumps({
        "title": title, "body": body,
        "device_key": key, "group": BARK_GROUP,
    }).encode()
    req = urllib.request.Request("https://api.day.app/push", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print("bark:", title, "->", r.status)
    except Exception as e:
        print("bark-fail:", e, "|", title, "|", body)


def cooled(rule):
    f = os.path.join(STATE_DIR, "last_" + rule)
    try:
        return time.time() - os.path.getmtime(f) < COOLDOWN
    except OSError:
        return False


def record_event(rule, title, body):
    try:
        with open(EVENTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("events"), list):
            data = {"events": []}
    except Exception:
        data = {"events": []}
    data["events"].append({"ts": int(time.time() * 1000), "rule": rule,
                           "title": title, "body": body})
    data["events"] = data["events"][-EVENTS_KEEP:]
    tmp = EVENTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, EVENTS_FILE)


def latest_backup():
    best = None
    try:
        for fn in os.listdir(ARCHIVES):
            m = OPS_PAT.match(fn)
            if not m:
                continue
            p = os.path.join(ARCHIVES, fn)
            st = os.stat(p)
            if best is None or st.st_mtime > best[2]:
                best = (fn, m.group(1), st.st_mtime, st.st_size)
    except OSError as e:
        print("scan-fail:", e)
        return None
    return best


def stale_alert(title, body, dry=False):
    if dry:
        print("DRY-STALE:", title, "|", body)
        return
    if cooled("backup-stale"):
        print("cooldown: backup-stale")
        return
    try:
        record_event("backup-stale", title, body)
    except Exception as e:
        print("record-fail:", e)
    bark(title, body)
    with open(os.path.join(STATE_DIR, "last_backup-stale"), "w") as f:
        f.write(str(time.time()))


def check(dry=False):
    lb = latest_backup()
    today = time.strftime("%Y%m%d")
    if lb is None:
        stale_alert("备份告警：从未产生备份",
                    "archives/ 下没有任何 ops_*.tar.gz，备份可能从未成功。请检查 crontab 与 backup.log。",
                    dry=dry)
        print("STALE: no backups at all")
        return 1
    fn, ymd, mt, sz = lb
    if ymd == today:
        print("OK: latest", fn, "is today")
        return 0
    try:
        d1 = datetime.strptime(ymd, "%Y%m%d")
        days = (datetime.now() - d1).days
    except ValueError:
        days = 0
    stale_alert("备份告警：%d 天无新备份" % days,
                "最近备份 %s（%.0f MB，%s）。每晚 4 点备份疑似失败，请检查 crontab 与 archives/backup.log。"
                % (fn, sz / 1048576.0, time.strftime("%m-%d %H:%M", time.localtime(mt))),
                dry=dry)
    print("STALE:", fn, days, "days since last backup")
    return 1


def test():
    bark("备份守卫测试", "看到这条说明备份告警通道已通（backup_watch）。")


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "check"
    dry = "--dry" in args
    if cmd == "check":
        sys.exit(check(dry=dry))
    elif cmd == "test":
        test()
    else:
        print("usage: backup_watch.py check [--dry] | test")
