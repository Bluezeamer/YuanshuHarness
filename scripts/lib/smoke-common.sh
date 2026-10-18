#!/usr/bin/env bash
# 装包冒烟与镜像冒烟共用的小函数。只被 source，不单独运行。
# 只依赖 node，不依赖 curl：CI 与本地、容器内外行为一致。

# 调用方在这里登记失败时要打印的日志文件。
SMOKE_LOG=""

die() {
  printf '冒烟失败：%s\n' "$1" >&2
  if [[ -n "$SMOKE_LOG" && -f "$SMOKE_LOG" ]]; then
    printf -- '--- %s（末尾 20 行）---\n' "$SMOKE_LOG" >&2
    tail -n 20 "$SMOKE_LOG" >&2
  fi
  exit 1
}

# 向内核要一个当前空闲的回环端口
free_port() {
  node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# http_get <url>：第一行输出状态码，其余是响应体；连不上则以非零状态返回
http_get() {
  node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(async r=>{process.stdout.write(r.status+"\n"+await r.text())}).catch(()=>process.exit(1))' "$1"
}

# wait_http <url> <秒数>：轮询直到返回 200
wait_http() {
  local url="$1" tries=$(($2 * 10)) out
  while ((tries-- > 0)); do
    if out="$(http_get "$url" 2>/dev/null)" && [[ "${out%%$'\n'*}" == 200 ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# check_health <base-url> <期望版本>：状态 200，且响应体恰为约定的两个字段
check_health() {
  local out status body
  out="$(http_get "$1/healthz")" || die "$1/healthz 连不上"
  status="${out%%$'\n'*}"
  body="${out#*$'\n'}"
  [[ "$status" == 200 ]] || die "/healthz 状态码应为 200，实际 $status"
  [[ "$body" == "{\"status\":\"ok\",\"version\":\"$2\"}" ]] \
    || die "/healthz 响应体不符：$body（期望版本 $2）"
}

# check_web_page <base-url>：GET / 为 200，是前端应用页（有根节点、无旧占位文案），且它引用的第一个脚本能取到
check_web_page() {
  local out status body asset css
  out="$(http_get "$1/")" || die "$1/ 连不上"
  status="${out%%$'\n'*}"
  body="${out#*$'\n'}"
  [[ "$status" == 200 ]] || die "GET / 状态码应为 200，实际 $status"
  [[ "$body" == *'id="root"'* ]] || die "GET / 返回的不是前端应用页（缺少 #root）"
  [[ "$body" != *"占位页"* ]] || die "GET / 返回的还是旧占位页"
  asset="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/<script[^>]*\ssrc="([^"]+)"/);if(m)process.stdout.write(m[1])})')"
  [[ -n "$asset" ]] || die "GET / 没有引用任何脚本"
  out="$(http_get "$1$asset")" || die "$1$asset 连不上"
  [[ "${out%%$'\n'*}" == 200 ]] || die "页面引用的脚本 $asset 状态码应为 200，实际 ${out%%$'\n'*}"
  css="$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/);if(m)process.stdout.write(m[1])})')"
  [[ -n "$css" ]] || die "GET / 没有引用样式表"
  out="$(http_get "$1$css")" || die "$1$css 连不上"
  [[ "${out%%$'\n'*}" == 200 ]] || die "页面引用的样式 $css 状态码应为 200，实际 ${out%%$'\n'*}"
}

# wait_exit <pid> <秒数>：等进程在限定时间内退出；超时返回非零
wait_exit() {
  local pid="$1" tries=$(($2 * 10))
  while ((tries-- > 0)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}
