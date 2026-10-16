#!/usr/bin/env bash
# 唯一的检查入口：本地与 CI 跑同一份。任一步失败立即以非零状态退出。
#
# 用法：scripts/check.sh [--precheck-only | --install-only | --tests-only]
# 单步参数供 tests/check/selfcheck.sh 调用；CHECK_ROOT 可把工程目录指向别处。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd)"
ROOT="${CHECK_ROOT:-$REPO}"

step() { printf '\n== %s ==\n' "$1"; }
die() { printf '检查失败：%s\n' "$1" >&2; exit 1; }

precheck() {
  step "前置检查"
  local missing=()
  command -v node >/dev/null 2>&1 || missing+=("node（需要 >=22.19）")
  command -v corepack >/dev/null 2>&1 || missing+=("corepack（随 Node 提供，用来取得锁定版本的 pnpm）")
  command -v pnpm >/dev/null 2>&1 || missing+=("pnpm（经 corepack 使用）")
  command -v python3 >/dev/null 2>&1 || missing+=("python3（需要 >=3.11，aisdlc 校验用）")
  ((${#missing[@]} == 0)) || die "缺少前置工具：${missing[*]}"

  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
    || die "node 版本过低：$(node -v)，需要 >=22.19"
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
    || die "python3 版本过低：$(python3 --version)，需要 >=3.11"
}

install_deps() {
  step "安装依赖（冻结锁文件）"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
}

typecheck() { step "类型检查"; (cd "$ROOT" && pnpm typecheck); }
lint() { step "lint 与格式"; (cd "$ROOT" && pnpm lint); }

run_tests() {
  step "测试"
  local count
  count="$(find "$ROOT" -path '*/node_modules' -prune -o -name '*.test.ts' -print | wc -l | tr -d ' ')"
  ((count > 0)) || die "没有找到任何测试文件（*.test.ts）"
  (cd "$ROOT" && pnpm test)
}

selfcheck() { step "检查脚本自检"; bash "$REPO/tests/check/selfcheck.sh"; }
build() { step "构建"; (cd "$ROOT" && pnpm build); }

aisdlc_check() {
  step "aisdlc 校验"
  (cd "$ROOT" && python3 -I .agents/skills/aisdlc/scripts/aisdlc_index.py --check)
}

case "${1:-all}" in
  --precheck-only) precheck ;;
  --install-only) precheck; install_deps ;;
  --tests-only) run_tests ;;
  all)
    precheck
    install_deps
    typecheck
    lint
    run_tests
    selfcheck
    build
    aisdlc_check
    printf '\n全部检查通过\n'
    ;;
  *) die "未知参数：$1" ;;
esac
