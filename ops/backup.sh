#!/usr/bin/env bash
# Dylan Heartbeat 关键数据备份 + 轮转（运维自动化）：排除应用自动生成的备份/临时文件，归档保持精简
set -u
BASE="/opt/dylan-heartbeat"
BK="$BASE/archives"
STAMP="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BK"
BODY=()
[ -d "$BASE/data" ] && BODY+=("data")
for f in "$BASE"/enhanced_messages.json "$BASE"/enhanced_messages_*.json; do
  [ -f "$f" ] && BODY+=("$(basename "$f")")
done
[ -d "$BASE/diary" ] && BODY+=("diary")
EXCLUDES=(--exclude='*.bak*' --exclude='*.tmp' --exclude='_fix_backup_*')
if [ ${#BODY[@]} -gt 0 ]; then
  tar czf "$BK/ops_$STAMP.tar.gz" -C "$BASE" "${EXCLUDES[@]}" "${BODY[@]}" 2>/dev/null
  echo "OK backup: ops_$STAMP.tar.gz ($(du -h "$BK/ops_$STAMP.tar.gz" | cut -f1))"
else
  echo "NO DATA to backup"
fi
if [ -f "$BASE/.env" ]; then
  cp "$BASE/.env" "$BK/env_$STAMP" && chmod 600 "$BK/env_$STAMP"
  ls -1t "$BK"/env_* 2>/dev/null | tail -n +2 | xargs -r rm -f
fi
ls -1t "$BK"/ops_*.tar.gz 2>/dev/null | tail -n +13 | xargs -r rm -f
echo "kept archives: $(ls -1 "$BK"/ops_*.tar.gz 2>/dev/null | wc -l)"
