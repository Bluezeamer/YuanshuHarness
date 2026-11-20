#!/usr/bin/env bash
# 清理 /tmp 里测试遗留的 yuanshu-* 目录，回收 inode（/tmp 是约 100 万 inode 的 tmpfs，占满后 mkdtemp 报 ENOSPC，
# 表现为全量测试大面积随机失败）。
#
# 用法：scripts/clean-test-tmp.sh          只列出会删什么（试运行）
#       scripts/clean-test-tmp.sh --yes    确认后删除
# 环境变量：AGE_MIN（默认 180，只清最后修改超过这么多分钟的）、TMP_ROOT（默认 /tmp）。
#
# 为什么不会误伤：只匹配 yuanshu-* 前缀、属于当前用户、顶层目录超过 AGE_MIN 分钟没改动，
# 并且一次性扫描所有进程的 cwd / root / 已打开文件，被占用的目录一律跳过。
# vitest、playwright、claude、tmux 等别家的目录名字都不匹配，不会碰。
set -euo pipefail

AGE_MIN="${AGE_MIN:-180}"
TMP_ROOT="${TMP_ROOT:-/tmp}"
YES=0
[[ "${1:-}" == "--yes" ]] && YES=1

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cand="$work/candidates"
busy="$work/busy"
todo="$work/todo"

inodes() { df -i "$TMP_ROOT" | awk 'NR==2 { printf "%s / %s (%s)", $3, $2, $5 }'; }

echo "清理前 inode：$(inodes)"

find "$TMP_ROOT" -maxdepth 1 -mindepth 1 -type d -user "$(id -un)" \
  -mmin "+$AGE_MIN" -name 'yuanshu-*' -print > "$cand"

# 一次扫描：谁把 TMP_ROOT 下的哪个顶层目录当 cwd / root / 打开着
for p in /proc/[0-9]*; do
  for l in "$p"/cwd "$p"/root "$p"/fd/*; do
    readlink "$l" 2>/dev/null || true
  done
done | sed 's/ (deleted)$//' \
  | awk -v t="$TMP_ROOT/" 'index($0, t) == 1 { split(substr($0, length(t) + 1), a, "/"); print t a[1] }' \
  | sort -u > "$busy"

grep -vxFf "$busy" "$cand" > "$todo" || true

total="$(wc -l < "$cand")"
skip="$(wc -l < "$busy")"
n="$(wc -l < "$todo")"
echo "候选 $total 个，被进程占用跳过 $((total - n)) 个（占用中的顶层目录 $skip 个），将清理 $n 个"
echo "按前缀："
sed 's|.*/\(yuanshu-[a-z0-9]*\)-.*|\1|' "$todo" | sort | uniq -c | sort -rn | sed 's/^/  /'
echo "样例："
head -3 "$todo" | sed 's/^/  /'

if ((YES == 0)); then
  echo "（试运行，什么都没删；确认后加 --yes）"
  exit 0
fi

if ((n > 0)); then
  # 并行删：目录数很多，单个 rm 太慢
  xargs -d '\n' -P 4 -n 200 rm -rf -- < "$todo"
fi
echo "清理后 inode：$(inodes)"
