#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""log_sentinel.py — 轻量日志哨兵：异常即 Bark 推送（2026-09-18 上线）

盯四类（用户拍板"四类全套"）：
  1. 新来源 IP 成功 SSH 登录（最优先：有人进来了）
  2. SSH 认证失败激增（爆破）
  3. MCP 公网入口（dqbnv 密码路径）异常访问：非 200/202、陌生 IP、陌生 UA
  4. 关键服务掉线：gateway(pm2) / nginx / yun-mcp-v2 / unified-backend

纯只读分析日志；自身仅写 /root/.log_sentinel/（known_ips 种子 + 冷却时间戳）。
推送复用心跳系统通道：POST https://api.day.app/push，device_key 取 .env 的 BARK_KEY。

用法：
  python3 log_sentinel.py init   # 首次：从当前 /var/log/secure 初始化 known_ips
  python3 log_sentinel.py run    # 常规检查（cron 每 5 分钟）
  python3 log_sentinel.py test   # 发一条测试推送
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

# ---- 可调参数 ----
STATE_DIR = "/root/.log_sentinel"
SECURE_LOG = "/var/log/secure"
NGINX_LOG = "/var/log/nginx/access.log"
MCP_SECRETS = (
    "38498f044695328ba3ec99b9d94f233256913078",   # yun-mcp-v2 (9010) 密码路径段
    "9d51e15ba2380d086afed2d67052971f4d7621a0",   # mcp-tools (8771) 密码路径段
)
BARK_ENV = "/opt/dylan-heartbeat/.env"
BARK_GROUP = "yun"
COOLDOWN = 1800            # 同类告警 30 分钟冷却
BRUTE_THRESHOLD = 15       # WINDOW_SSH 内认证失败达到该值即告警
WINDOW_SSH = 600           # SSH 类检查窗口（秒）
WINDOW_NGINX = 300         # nginx 检查窗口（秒）
# 「已知」来源前缀：用户宽带/手机池、服务器自连、OpenAI/Azure 出口
KNOWN_IP_PREFIXES = ("223.160.", "120.76.99.224")
MCP_KNOWN_IP_PREFIXES = KNOWN_IP_PREFIXES + ("9.129.57.",)
MCP_KNOWN_UA_PREFIXES = ("openai-mcp/", "Trae/", "curl/")
PM2 = "/usr/local/bin/pm2"
SERVICES_SYSTEMD = ("nginx", "yun-mcp-v2", "unified-backend")
# -----------------

MONTHS = {m: i for i, m in enumerate(
    "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}
NGINX_LINE = re.compile(
    r'^(\S+) \S+ \S+ \[([^]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"')


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


def alert(rule, title, body):
    if cooled(rule):
        print("cooldown:", rule)
        return
    bark(title, body)
    with open(os.path.join(STATE_DIR, "last_" + rule), "w") as f:
        f.write(str(time.time()))


def syslog_epoch(line, now_dt):
    # "Sep 18 19:07:01 ..." -> epoch；手工解析避免 locale 影响
    try:
        mon = MONTHS[line[:3]]
        day = int(line[4:6])
        hh, mm, ss = int(line[7:9]), int(line[10:12]), int(line[13:15])
    except (KeyError, ValueError):
        return None
    try:
        dt = datetime(now_dt.year, mon, day, hh, mm, ss)
    except ValueError:
        return None
    if dt > now_dt:  # 跨年旧日志
        dt = dt.replace(year=now_dt.year - 1)
    return dt.timestamp()


def nginx_epoch(s, now_dt):
    # "18/Sep/2026:19:11:04" -> epoch
    try:
        day = int(s[0:2])
        mon = MONTHS[s[3:6]]
        hh, mm, ss = int(s[7:9]), int(s[10:12]), int(s[13:15])
        return datetime(now_dt.year, mon, day, hh, mm, ss).timestamp()
    except (KeyError, ValueError):
        return None


def iter_secure():
    try:
        with open(SECURE_LOG, errors="replace") as f:
            for line in f:
                yield line
    except OSError:
        return


def check_new_login(now_dt):
    """从未见过的来源 IP 成功登录 → 告警并记入种子（同 IP 只报一次）"""
    known = set()
    kf = os.path.join(STATE_DIR, "known_ips.txt")
    if os.path.exists(kf):
        with open(kf) as f:
            known = {x.strip() for x in f if x.strip()}
    news = []
    for line in iter_secure():
        if "Accepted" not in line or " from " not in line:
            continue
        t = syslog_epoch(line, now_dt)
        if t is None or now_dt.timestamp() - t > WINDOW_SSH:
            continue
        ip = line.split(" from ")[1].split()[0]
        if ip in known or ip.startswith(KNOWN_IP_PREFIXES):
            continue
        news.append("%s (%s)" % (ip, line.split("Accepted")[1].strip()[:60]))
        known.add(ip)
    if news:
        alert("new-ssh-login", "SSH 新来源登录",
              "；".join(news[:3]) + "。若非本人操作请立即处理")
        with open(kf, "a") as f:
            f.write("\n".join(n.split()[0] for n in news) + "\n")


def check_brute(now_dt):
    cnt, ips = 0, {}
    for line in iter_secure():
        if ("Failed " not in line and "Invalid user" not in line) or " from " not in line:
            continue
        t = syslog_epoch(line, now_dt)
        if t is None or now_dt.timestamp() - t > WINDOW_SSH:
            continue
        cnt += 1
        ip = line.split(" from ")[1].split()[0]
        ips[ip] = ips.get(ip, 0) + 1
    if cnt >= BRUTE_THRESHOLD:
        top = sorted(ips.items(), key=lambda x: -x[1])[:2]
        alert("ssh-brute", "SSH 爆破激增",
              "10分钟失败 %d 次，主要来源 %s" % (cnt, "，".join("%s×%d" % kv for kv in top)))


def check_mcp(now_dt):
    """密码路径：非 200/202、陌生 IP、陌生 UA 都算异常（这条 URL 是 root 级能力）"""
    bad, total = [], 0
    try:
        fh = open(NGINX_LOG, errors="replace")
    except OSError:
        return
    with fh:
        for line in fh:
            if not any(s in line for s in MCP_SECRETS):
                continue
            m = NGINX_LINE.match(line)
            if not m:
                continue
            t = nginx_epoch(m.group(2).split()[0], now_dt)
            if t is None or now_dt.timestamp() - t > WINDOW_NGINX:
                continue
            total += 1
            ip, method, path, code, ua = (m.group(1), m.group(3), m.group(4),
                                          m.group(5), m.group(6))
            if (code not in ("200", "202")
                    or not ip.startswith(MCP_KNOWN_IP_PREFIXES)
                    or not ua.startswith(MCP_KNOWN_UA_PREFIXES)):
                bad.append("%s %s %s %s %s" % (ip, method, path.split("?")[0][-12:], code, ua[:24]))
    if bad:
        alert("mcp-anomaly", "MCP 入口异常访问",
              "5分钟 %d 请求、异常 %d：%s" % (total, len(bad), "；".join(bad[:3])))


def run_cmd(cmd, timeout):
    # 服务器系统 python 为 3.6：不用 capture_output/text（3.7+）
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=timeout)
    return r.stdout


def check_services():
    down = []
    try:
        out = run_cmd([PM2, "jlist"], 20)
        for p in json.loads(out or "[]"):
            try:
                if p.get("name") == "gateway" and \
                        p.get("pm2_env", {}).get("status") != "online":
                    down.append("gateway(pm2)")
            except AttributeError:
                pass
    except Exception as e:
        down.append("pm2检查失败:%s" % e)
    for s in SERVICES_SYSTEMD:
        try:
            st = run_cmd(["systemctl", "is-active", s], 10).strip()
            if st != "active":
                down.append("%s=%s" % (s, st or "?"))
        except Exception as e:
            down.append("%s=检查失败:%s" % (s, e))
    if down:
        alert("services", "服务掉线", "，".join(down))


def init_known():
    kf = os.path.join(STATE_DIR, "known_ips.txt")
    ips = set()
    for line in iter_secure():
        if "Accepted" in line and " from " in line:
            ips.add(line.split(" from ")[1].split()[0])
    with open(kf, "w") as f:
        f.write("\n".join(sorted(ips)) + "\n")
    print("seeded known_ips:", len(ips))


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "init":
        init_known()
        return
    if cmd == "test":
        bark("哨兵部署测试", "看到这条说明告警通道已通（log_sentinel）。")
        return
    now_dt = datetime.now()
    check_new_login(now_dt)
    check_brute(now_dt)
    check_mcp(now_dt)
    check_services()
    print("ok", now_dt.strftime("%F %T"))


if __name__ == "__main__":
    main()
