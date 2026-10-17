#!/usr/bin/env bash
# 装包冒烟：把打好的 npm 包装进仓库之外的干净目录，真的启动一次并探测。
# 本仓库里能跑不代表装出去能跑（漏带文件、依赖放错位置、入口缺失），所以必须实际装一遍。
#
# 用法：scripts/smoke-package.sh
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd -P)"
# shellcheck source=lib/smoke-common.sh
source "$SELF_DIR/lib/smoke-common.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/yuanshu-smoke-pkg.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
SERVER_PID=""
SMOKE_LOG="$WORK/server.log"

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 安装目录必须在仓库目录树之外：否则 node 会沿父目录解析到仓库自己的 node_modules，
# 少声明的依赖也会"装得上、跑得起"，冒烟就成了假绿。
case "$WORK/" in
  "$REPO"/*) die "临时目录 $WORK 在仓库目录树内，会误用仓库的 node_modules；请换一个 TMPDIR" ;;
esac

echo "== 打包"
"$SELF_DIR/pack.sh" "$WORK/pack"
TARBALL="$(ls "$WORK"/pack/*.tgz)"

echo "== 核对 tarball 清单"
tar -tzf "$TARBALL" > "$WORK/list.txt"
grep -qx 'package/web/index.html' "$WORK/list.txt" || die "tarball 里没有 web/index.html"
grep -qx 'package/dist/bin.js' "$WORK/list.txt" || die "tarball 里没有 dist/bin.js"
if bad="$(grep -E '^package/(src/|tsconfig)|\.test\.' "$WORK/list.txt")"; then
  die "tarball 里不应出现源码、测试或 tsconfig：$bad"
fi
VERSION="$(tar -xzOf "$TARBALL" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"

echo "== 装到干净目录（$WORK/app）"
mkdir -p "$WORK/app"
(cd "$WORK/app" && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error "$TARBALL")

echo "== 启动 yuanshu serve"
PORT="$(free_port)"
BASE="http://127.0.0.1:$PORT"
"$WORK/app/node_modules/.bin/yuanshu" serve --port "$PORT" --data-dir "$WORK/data" > "$SMOKE_LOG" 2>&1 &
SERVER_PID=$!
wait_http "$BASE/healthz" 15 || die "15 秒内 /healthz 没有返回 200"

echo "== 探测"
check_health "$BASE" "$VERSION"
check_placeholder_page "$BASE"

echo "== SIGTERM"
kill -TERM "$SERVER_PID"
wait_exit "$SERVER_PID" 5 || die "收到 SIGTERM 后 5 秒内没有退出"
code=0
wait "$SERVER_PID" || code=$?
SERVER_PID=""
((code == 0)) || die "SIGTERM 后退出码应为 0，实际 $code"

[[ -d "$WORK/data" ]] || die "数据目录没有被创建"
[[ -z "$(ls -A "$WORK/data")" ]] || die "数据目录里不应有任何文件：$(ls -A "$WORK/data")"

echo "装包冒烟通过（版本 $VERSION）"
