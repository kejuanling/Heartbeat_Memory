#!/usr/bin/env bash
# Dylan Heartbeat 综合巡检（只读）
set -u
BASE="/opt/dylan-heartbeat"
echo "===================== Dylan Heartbeat 巡检 ====================="
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "------------------------------------------------------------"
echo "[1] 监听端口（外部）"
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep LISTEN | grep -vE '127[.]0[.]0[.]1:[0-9]+' | awk '{gsub(/[0-9]+\//, "/", $6); printf "  %-18s %-28s\n", $4, $6}'
echo ""
echo "[2] pm2 进程"
pm2 list 2>/dev/null | sed -n '1,14p'
echo ""
echo "[3] 关键服务探活 (HTTP code, 非2xx也算可达)"
probe(){ local n="$1" u="$2"; local c; c=$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$u" 2>/dev/null || echo FAIL); printf "  %-26s %s\n" "$n" "$c"; }
probe "gateway 3000"            "http://127.0.0.1:3000/"
probe "gateway /v1/models"      "http://127.0.0.1:3000/v1/models"
probe "unified 8777"            "http://127.0.0.1:8777/"
probe "tools_server 8771"       "http://127.0.0.1:8771/"
probe "yun-mcp 9010 /sse"       "http://127.0.0.1:9010/sse"
echo ""
echo "[4] 资源"
echo "  Load: $(cat /proc/loadavg 2>/dev/null)"
echo "  Mem : $(free -h 2>/dev/null | awk '/^Mem:/{print "used="$3"/"$2" avail="$7}') "
echo "  Disk: $(df -h / 2>/dev/null | awk 'NR==2{print "used="$3"/"$2" ("$5" used, avail="$4")"}') "
echo "[5] 最近备份"
ls -1t "$BASE/backups"/ops_*.tar.gz 2>/dev/null | head -5 | sed 's/^/  /' 
echo "============================================================"
