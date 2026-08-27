#!/usr/bin/env bash
# 清理 data/ 应用自动生成的备份/临时文件（默认每组保留最近2份）。加 --dry-run 只看不删。
set -u
python3 "$(dirname "$0")/cleanup.py" "$@"
