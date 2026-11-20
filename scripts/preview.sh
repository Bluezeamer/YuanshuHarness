#!/usr/bin/env bash
# 把当前工作区的改动构建并应用到本机的预览服务，供人直接在浏览器里查看。
#
# 用法：scripts/preview.sh        （端口默认 7431，可用 YUANSHU_VIEW_PORT 改）
# 行为：构建 web + server → 同步 web/dist 到 server/web → 重启预览服务 → 等 /healthz。
# 预览服务使用独立数据目录 tmp/run-data，不碰 ~/.yuanshu；工作目录 tmp/work 与服务原有启动方式一致。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
PORT="${YUANSHU_VIEW_PORT:-7431}"
HOST="127.0.0.1"
DATA_DIR="$ROOT/tmp/run-data"
WORK_DIR="$ROOT/tmp/work"
LOG="$ROOT/tmp/run-server.log"
PID_FILE="$ROOT/tmp/run-server.pid"
WEB_DIST="$ROOT/packages/web/dist"
SERVER_WEB="$ROOT/packages/server/web"
BIN="$ROOT/packages/server/dist/bin.js"

step() { printf '\n== %s ==\n' "$1"; }
die() { printf 'preview 失败：%s\n' "$1" >&2; exit 1; }

step "构建 web"
pnpm --dir "$ROOT" --filter yuanshu-harness-web build

step "构建 server"
pnpm --dir "$ROOT" --filter yuanshu-harness-server build

step "同步 web 产物到 server/web"
[[ -f "$WEB_DIST/index.html" ]] || die "$WEB_DIST/index.html 不存在"
rm -rf "$SERVER_WEB"
cp -R "$WEB_DIST" "$SERVER_WEB"
[[ -f "$SERVER_WEB/index.html" ]] || die "$SERVER_WEB/index.html 不存在"

step "停止旧的预览服务"
mapfile -t old < <(pgrep -f "$ROOT/packages/server/dist/bin.js serve --host $HOST --port $PORT" || true)
if ((${#old[@]} > 0)); then
  kill "${old[@]}" 2>/dev/null || true
  for _ in $(seq 1 30); do
    pgrep -f "$ROOT/packages/server/dist/bin.js serve --host $HOST --port $PORT" >/dev/null || break
    sleep 0.2
  done
  # 优雅退出可能被 fs.watch 之类的句柄拖住，等不到就强杀
  if pgrep -f "$ROOT/packages/server/dist/bin.js serve --host $HOST --port $PORT" >/dev/null; then
    pkill -KILL -f "$ROOT/packages/server/dist/bin.js serve --host $HOST --port $PORT" || true
    sleep 0.5
  fi
  pgrep -f "$ROOT/packages/server/dist/bin.js serve --host $HOST --port $PORT" >/dev/null \
    && die "旧进程没有退出"
fi

step "启动预览服务"
mkdir -p "$WORK_DIR" "$DATA_DIR"
: > "$LOG"
(
  cd "$WORK_DIR"
  YUANSHU_DATA_DIR="$DATA_DIR" nohup node "$BIN" serve --host "$HOST" --port "$PORT" \
    >> "$LOG" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
)
for _ in $(seq 1 80); do
  if curl -sS --noproxy '*' -m 2 "http://$HOST:$PORT/healthz" 2>/dev/null | grep -q '"status":"ok"'; then
    step "已就绪"
    curl -sS --noproxy '*' "http://$HOST:$PORT/healthz"; echo
    printf 'pid=%s  data=%s\n' "$(cat "$PID_FILE")" "$DATA_DIR"
    exit 0
  fi
  sleep 0.5
done

tail -30 "$LOG" >&2 || true
die "服务在 40 秒内没有就绪，日志：$LOG"
