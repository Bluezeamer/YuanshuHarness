#!/usr/bin/env bash
# 唯一的检查入口：本地与 CI 跑同一份。任一步失败立即以非零状态退出。
#
# 用法：scripts/check.sh [阶段...]
#   不带参数：按顺序跑全部阶段（提交前在本地用这个）。
#   阶段：core（类型、lint、测试、构建、装包冒烟）、真机验收的各领域阶段、image（镜像冒烟，要 Docker），
#         完整清单见下面的 ALL_STAGES；CI 把它们拆成并行作业，每个作业跑一个阶段，调试时也可以只跑一个。
#   --list：列出每个真机验收阶段包含的脚本（tests/check/selfcheck.sh 用它核对没有脚本漏接）。
# CHECK_ROOT 可把工程目录指向别处，仅供 tests/check/selfcheck.sh 用临时工程驱动本脚本；此时不跑真机验收与自检。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd)"
ROOT="${CHECK_ROOT:-$REPO}"

step() { printf '\n== %s ==\n' "$1"; }
die() { printf '检查失败：%s\n' "$1" >&2; exit 1; }

# precheck <阶段...>：只有跑 image 阶段才要 Docker，且没有跳过开关。
precheck() {
  step "前置检查"
  local need_docker=0 st
  for st in "$@"; do [[ "$st" == image ]] && need_docker=1; done
  local missing=()
  command -v node >/dev/null 2>&1 || missing+=("node（需要 >=22.19）")
  command -v pnpm >/dev/null 2>&1 || missing+=("pnpm（需要 >=10，例如 \`npm install -g pnpm\`；在本仓库里它会自动切换到 package.json 锁定的版本）")
  if ((need_docker)); then
    command -v docker >/dev/null 2>&1 || missing+=("docker（镜像冒烟用，没有跳过开关）")
  fi
  ((${#missing[@]} == 0)) || die "缺少前置工具：${missing[*]}"

  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
    || die "node 版本过低：$(node -v)，需要 >=22.19"
  if ((need_docker)); then
    docker info >/dev/null 2>&1 \
      || die "docker 守护进程不可用：docker info 失败（守护进程没有启动，或当前用户没有权限）"
  fi

  # 不依赖 corepack（Node 25 起不再随发行包提供）：由 pnpm 自己按 packageManager 切换版本，
  # 过旧的 pnpm 不会切换，所以要核对实际版本。
  local want have
  want="$(cd "$ROOT" && node -p "require('./package.json').packageManager.split('@')[1]")"
  have="$(cd "$ROOT" && pnpm --version)" || die "pnpm 无法运行"
  [[ "$have" == "$want" ]] \
    || die "pnpm 版本与 package.json 锁定的不一致：实际 $have，需要 $want（pnpm 需要 >=10 才会自动切换）"
}

install_deps() {
  step "安装依赖（冻结锁文件）"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
}

# /tmp 的 inode 快满时测试会因 mkdtemp 报 ENOSPC 而大面积随机失败：先把原因摆出来，别让人去猜。
tmp_inodes() {
  local used
  used="$(df -i /tmp 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
  [[ "$used" =~ ^[0-9]+$ ]] || return 0
  if ((used >= 85)); then
    die "/tmp 的 inode 已用 ${used}%，测试会随机失败：先运行 scripts/clean-test-tmp.sh --yes 清理测试残留"
  fi
}

typecheck() { step "类型检查"; (cd "$ROOT" && pnpm typecheck); }
lint() { step "lint 与格式"; (cd "$ROOT" && pnpm lint); }

run_tests() {
  step "测试"
  [[ -d "$ROOT/packages" ]] || die "没有找到 packages 目录"
  local count
  count="$(find "$ROOT/packages" -path '*/node_modules' -prune -o -name '*.test.ts' -print | wc -l | tr -d ' ')"
  ((count > 0)) || die "packages 下没有找到任何测试文件（*.test.ts）"
  (cd "$ROOT" && pnpm test)
}

selfcheck() { step "检查脚本自检"; bash "$REPO/tests/check/selfcheck.sh"; }
build() { step "构建"; (cd "$ROOT" && pnpm build); }

# 验收脚本跑的是 packages/server 下的 dist 与 web 产物，装包冒烟（pack.sh）会生成它们；同一次运行里只打一次包。
PACKED=0
smoke_package() { step "装包冒烟"; (cd "$ROOT" && scripts/smoke-package.sh); PACKED=1; }
pack_once() {
  ((PACKED == 0)) || return 0
  step "打包（生成验收脚本用的产物）"
  local out
  out="$(mktemp -d "${TMPDIR:-/tmp}/yuanshu-check-pack.XXXXXX")"
  (cd "$ROOT" && scripts/pack.sh "$out") || { rm -rf "$out"; die "打包失败"; }
  rm -rf "$out"
  PACKED=1
}
smoke_image() { step "镜像冒烟"; (cd "$ROOT" && scripts/smoke-image.sh); }

# 真机验收脚本（scripts/verify-<名>.mjs）按领域分阶段，各约 3 到 4 分钟，便于 CI 并行。
# 新增的 verify 脚本必须归进某个阶段，否则 tests/check/selfcheck.sh 失败。
VERIFY_STAGES=(ui-settings ui-chat ui-workspace ui-canvas ui-mobile browser)
ALL_STAGES=(core "${VERIFY_STAGES[@]}" image)

verify_scripts() {
  case "$1" in
    ui-settings) echo "visual settings providers variables studio remote tools defaults review-prompt plugins" ;;
    ui-chat) echo "chat chat-scroll chat-copy foreground input jobs goal md" ;;
    ui-workspace) echo "shell workspace directories terminal state tab-zoom html-preview versions" ;;
    ui-canvas) echo "canvas" ;;
    ui-mobile) echo "mobile mobile-layout devices mobile-push" ;;
    # agent 浏览器、服务转发；浏览器本体取 YUANSHU_BROWSER，没设就用 playwright 装的那个。
    browser) echo "browser browser-tools browser-content browser-ui mobile-browser browser-show browser-replay browser-assets browser-downloads browser-uploads browser-dialog browser-user-downloads browser-user-uploads browser-file-reload browser-login browser-mirror browser-ports forward" ;;
  esac
}

list_verify() {
  local st s
  for st in "${VERIFY_STAGES[@]}"; do
    for s in $(verify_scripts "$st"); do printf '%s\tverify-%s\n' "$st" "$s"; done
  done
}

# 验收脚本用服务端已依赖的 playwright-core 驱动 Chromium（scripts/lib/playwright.mjs）；浏览器本体没装就无法运行。
have_chromium() {
  (cd "$ROOT" && node --input-type=module -e '
    import { existsSync } from "node:fs";
    import { chromium } from "./scripts/lib/playwright.mjs";
    process.exit(existsSync(chromium.executablePath()) ? 0 : 1);
  ') >/dev/null 2>&1
}

# 一个阶段里的脚本各起一个真 Server，只能一个接一个跑；某个失败不中断，跑完再汇总，CI 上一次能看全。
verify_stage() {
  local stage="$1"
  step "真机验收：$stage"
  if [[ -n "${CHECK_ROOT:-}" ]]; then
    printf '提示：已设置 CHECK_ROOT，跳过真机验收\n'
    return 0
  fi
  have_chromium || die "没有找到 Chromium，真机验收无法运行。
装法：pnpm --filter yuanshu-harness-server exec playwright-core install chromium（网络受限时先设 PLAYWRIGHT_DOWNLOAD_HOST 指向镜像）"
  pack_once
  local failed=() s start
  for s in $(verify_scripts "$stage"); do
    start=$SECONDS
    printf '\n-- verify-%s\n' "$s"
    if (cd "$ROOT" && node "scripts/verify-$s.mjs"); then
      printf -- '-- verify-%s 通过（%s 秒）\n' "$s" "$((SECONDS - start))"
    else
      printf -- '-- verify-%s 失败（%s 秒）\n' "$s" "$((SECONDS - start))"
      failed+=("verify-$s")
    fi
  done
  ((${#failed[@]} == 0)) || die "真机验收未通过：${failed[*]}"
}

run_stage() {
  case "$1" in
    core)
      typecheck
      lint
      run_tests
      # 自检会以 CHECK_ROOT 指向临时工程，反过来驱动本脚本；那一层不再自检，避免递归。
      if [[ -z "${CHECK_ROOT:-}" ]]; then
        selfcheck
      else
        printf '\n提示：已设置 CHECK_ROOT，跳过检查脚本自检\n'
      fi
      build
      smoke_package
      ;;
    image) smoke_image ;;
    *) verify_stage "$1" ;;
  esac
}

if [[ "${1:-}" == "--list" ]]; then
  list_verify
  exit 0
fi

stages=("$@")
((${#stages[@]})) || stages=("${ALL_STAGES[@]}")
for st in "${stages[@]}"; do
  [[ " ${ALL_STAGES[*]} " == *" $st "* ]] || die "未知阶段：$st（可选：${ALL_STAGES[*]}）"
done

precheck "${stages[@]}"
tmp_inodes
install_deps
for st in "${stages[@]}"; do run_stage "$st"; done
printf '\n全部检查通过\n'
