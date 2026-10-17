#!/usr/bin/env bash
# 镜像冒烟：真的构建镜像、起容器，验证健康检查、停止行为、数据目录权限与镜像内容。不推送任何东西。
#
# 容器一律用 --network host 运行：本仓库的开发环境是 LXD 容器，默认 bridge 网络下 runc
# 无法给容器设置 sysctl（open sysctl net.ipv4.ip_unprivileged_port_start: permission denied）。
# 只走这一条路径，不加开关；host 网络下容器监听的端口就是宿主机上的端口。
#
# 用法：scripts/smoke-image.sh
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd -P)"
# shellcheck source=lib/smoke-common.sh
source "$SELF_DIR/lib/smoke-common.sh"

# 每条 docker run 都必须带它，见文件头注释。
RUN_OPTS=(--network host)
SUFFIX="$$-$RANDOM"
IMAGE="yuanshu-smoke:$SUFFIX"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/yuanshu-smoke-img.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
SMOKE_LOG="$WORK/build.log"

cleanup() {
  docker rm -f "$(cname app)" "$(cname idle)" >/dev/null 2>&1 || true
  docker volume rm -f "$(cname data)" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 容器名带本次运行的后缀，cleanup 按名字前缀清掉。
# 不能靠数组登记：在 $(...) 子 shell 里改数组，父 shell 看不到。
cname() { echo "yuanshu-smoke-$1-$SUFFIX"; }

# health_status <容器>
health_status() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1"; }

# wait_health <容器> <期望状态> <秒数>
wait_health() {
  local tries=$(($3 * 2))
  while ((tries-- > 0)); do
    [[ "$(health_status "$1")" == "$2" ]] && return 0
    sleep 0.5
  done
  return 1
}

echo "== 构建（先导出 tarball，再构建镜像）"
docker build --target tarball --output "type=local,dest=$WORK/tarball" "$REPO" > "$SMOKE_LOG" 2>&1 \
  || die "导出 tarball 失败"
TARBALL="$(ls "$WORK"/tarball/*.tgz)"
VERSION="$(tar -xzOf "$TARBALL" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
docker build -t "$IMAGE" "$REPO" > "$SMOKE_LOG" 2>&1 || die "构建镜像失败"

echo "== 镜像内容（一次 docker run 查完：本环境里每次启动容器要 7 秒以上）"
PKG_DIR=/usr/local/lib/node_modules/yuanshu-harness-server
docker run --rm "${RUN_OPTS[@]}" --entrypoint sh "$IMAGE" -c "
  echo uid=\$(id -u)
  if command -v pnpm >/dev/null 2>&1; then echo pnpm=present; else echo pnpm=absent; fi
  if [ -d $PKG_DIR ]; then echo pkg=present; else echo pkg=missing; fi
  if [ -e $PKG_DIR/src ]; then echo src=present; else echo src=absent; fi
  echo ---files
  cd $PKG_DIR && find . -path ./node_modules -prune -o -type f -print | sed 's|^\./||' | LC_ALL=C sort
" > "$WORK/inspect.txt" || die "查看镜像内容失败"
grep -qx 'uid=1000' "$WORK/inspect.txt" || die "运行用户 uid 应为 1000"
grep -qx 'pnpm=absent' "$WORK/inspect.txt" || die "最终镜像里不应有 pnpm"
grep -qx 'pkg=present' "$WORK/inspect.txt" || die "安装目录缺失"
grep -qx 'src=absent' "$WORK/inspect.txt" || die "最终镜像里存在 src 目录"
sed -n '/^---files$/,$p' "$WORK/inspect.txt" | tail -n +2 > "$WORK/installed.txt"
tar -tzf "$TARBALL" | sed 's|^package/||' | LC_ALL=C sort > "$WORK/tarball.txt"
diff -u "$WORK/tarball.txt" "$WORK/installed.txt" > "$WORK/diff.txt" \
  || die "镜像里安装的文件与 tarball 清单不一致：$(cat "$WORK/diff.txt")"

# 令牌只经环境变量传入容器，不出现在命令行（README 示例同样如此）。
YUANSHU_TOKEN="smoke-$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
export YUANSHU_TOKEN

echo "== 无令牌：容器监听 0.0.0.0 时必须启动失败并指明需要令牌"
out="$(docker run --rm "${RUN_OPTS[@]}" -e "YUANSHU_PORT=$(free_port)" "$IMAGE" 2>&1)" && rc=0 || rc=$?
((rc != 0)) || die "未提供 YUANSHU_TOKEN 时容器应当启动失败，实际退出码 0"
[[ "$out" == *"YUANSHU_TOKEN"* ]] || die "报错里应当指明需要 YUANSHU_TOKEN：$out"

echo "== 运行 README 里的 docker run 示例（命名卷）"
# 从 README 取出示例命令原样执行，只做三处必要的替换：镜像名、容器名/卷名（带本次后缀以便清理）、
# 以及把 -p 端口映射换成 host 网络（本环境 bridge 不可用，见文件头）。示例写坏了，这里就会失败。
PORT="$(free_port)"
VOL="$(cname data)"
APP="$(cname app)"
README_CMD="$(awk '/<!-- smoke:docker-run -->/{f=1;next} f&&/^```bash/{g=1;next} g&&/^```/{exit} g{print}' "$REPO/README.md")"
[[ "$README_CMD" == docker\ run\ * ]] || die "README 里没有找到 <!-- smoke:docker-run --> 标记的 docker run 示例"
[[ "$README_CMD" == *" -p 7420:7420 "* ]] || die "README 示例里应当有 -p 7420:7420"
[[ "$README_CMD" == *" --name yuanshu "* ]] || die "README 示例里应当有 --name yuanshu"
[[ "$README_CMD" == *" -e YUANSHU_TOKEN "* || "$README_CMD" == *' -e YUANSHU_TOKEN="$YUANSHU_TOKEN" '* ]] || die "README 示例里应当传入 YUANSHU_TOKEN"
[[ "$README_CMD" == *" -v yuanshu-data:/data "* ]] || die "README 示例里应当有 -v yuanshu-data:/data"
[[ "$README_CMD" == *" yuanshu" ]] || die "README 示例应当以镜像名 yuanshu 结尾"
CMD="${README_CMD//-p 7420:7420/--network host -e YUANSHU_PORT=$PORT}"
CMD="${CMD//--name yuanshu/--name $APP}"
CMD="${CMD//yuanshu-data:\/data/$VOL:\/data}"
CMD="${CMD% yuanshu} $IMAGE"
eval "$CMD" >/dev/null
wait_health "$APP" healthy 30 || { docker logs "$APP" >&2 || true; die "30 秒内容器没有变为 healthy（当前 $(health_status "$APP")）"; }
BASE="http://127.0.0.1:$PORT"
check_health "$BASE" "$VERSION"
check_placeholder_page "$BASE"

echo "== /healthz 与静态页免认证，/api/v1 要求令牌"
api_status() { # api_status [令牌]
  node -e '
const h = process.argv[2] ? { authorization: `Bearer ${process.argv[2]}` } : {};
fetch(process.argv[1] + "/api/v1/sessions", { headers: h, signal: AbortSignal.timeout(3000) })
  .then((r) => console.log(r.status), () => process.exit(1));
' "$BASE" "${1:-}"
}
[[ "$(api_status)" == 401 ]] || die "无令牌访问 /api/v1/sessions 应为 401"
[[ "$(api_status "$YUANSHU_TOKEN")" == 200 ]] || die "带正确令牌访问 /api/v1/sessions 应为 200"

echo "== 容器监听的是 0.0.0.0（经容器自己的非回环地址访问）"
docker exec "$APP" node -e '
const ip = Object.values(require("node:os").networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address;
if (!ip) { console.error("容器内没有非回环 IPv4 地址，无法验证监听 0.0.0.0"); process.exit(2); }
fetch(`http://${ip}:${process.env.YUANSHU_PORT}/healthz`, { signal: AbortSignal.timeout(3000) })
  .then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1));
' || die "经容器的非回环地址访问 /healthz 失败：服务没有监听 0.0.0.0"

echo "== docker stop"
t0="$(date +%s.%N)"
docker stop "$APP" >/dev/null
elapsed="$(node -p "(($(date +%s.%N) - $t0)).toFixed(1)")"
code="$(docker inspect -f '{{.State.ExitCode}}' "$APP")"
[[ "$code" == 0 ]] || die "docker stop 后退出码应为 0，实际 $code（137 说明 SIGTERM 没到 node）"
# 进程本身的 5 秒要求由退出码保证：Docker 默认 10 秒后强杀，退出码会变成 137。这里只防异常拖慢。
node -e "process.exit($elapsed < 8 ? 0 : 1)" || die "docker stop 用了 ${elapsed}s，应小于 8s"
echo "   用时 ${elapsed}s，退出码 0"

echo "== 健康检查对没有监听的端口必须判为 unhealthy"
IDLE="$(cname idle)"
docker run -d "${RUN_OPTS[@]}" --name "$IDLE" -e "YUANSHU_PORT=$(free_port)" \
  --health-interval=1s --health-timeout=3s --health-retries=1 --health-start-period=0s \
  --entrypoint node "$IMAGE" -e 'setInterval(() => {}, 1000)' >/dev/null
wait_health "$IDLE" unhealthy 20 || die "没有监听任何端口的容器没有被判为 unhealthy（当前 $(health_status "$IDLE")）"

echo "== 不可写的挂载目录：启动必须失败并说明原因"
RO="$WORK/ro-data"
mkdir "$RO"
chmod 0555 "$RO"
out="$(docker run --rm "${RUN_OPTS[@]}" -e "YUANSHU_PORT=$(free_port)" -e YUANSHU_TOKEN -v "$RO:/data" "$IMAGE" 2>&1)" && rc=0 || rc=$?
((rc != 0)) || die "挂载不可写目录时容器应当启动失败，实际退出码 0"
[[ "$out" == *"/data"* ]] || die "报错里应当指出 /data：$out"

echo "镜像冒烟通过（版本 $VERSION）"
