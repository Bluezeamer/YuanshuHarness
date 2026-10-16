#!/usr/bin/env bash
# scripts/check.sh 的自检：用已知坏输入证明它会失败（R5、R6）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$ROOT/scripts/check.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

# expect_fail <名称> <输出中必须包含的字样> <命令...>
expect_fail() {
  local name="$1" needle="$2"
  shift 2
  local out
  if out="$("$@" 2>&1)"; then
    echo "FAIL  $name：应当失败，实际成功"
    fails=$((fails + 1))
  elif [[ -n "$needle" && "$out" != *"$needle"* ]]; then
    echo "FAIL  $name：已失败，但输出缺少「$needle」"
    echo "$out" | sed 's/^/      /'
    fails=$((fails + 1))
  else
    echo "ok    $name"
  fi
}

# 受限 PATH：只放入指定的命令，其余一律不可见
restricted_path() {
  local dir="$WORK/bin-$1"
  shift
  mkdir -p "$dir"
  local cmd
  for cmd in "$@"; do
    ln -sf "$(command -v "$cmd")" "$dir/$cmd"
  done
  echo "$dir"
}

[[ -x "$CHECK" ]] || { echo "FAIL  scripts/check.sh 不存在或不可执行"; exit 1; }

# R5：缺失的前置工具必须被点名
base=(bash env dirname cat sed grep sort head tr)
expect_fail "缺 python3" "缺少前置工具：python3" \
  env PATH="$(restricted_path nopy "${base[@]}" node corepack pnpm)" "$CHECK" --precheck-only
expect_fail "缺 pnpm" "缺少前置工具：pnpm" \
  env PATH="$(restricted_path nopnpm "${base[@]}" node python3 corepack)" "$CHECK" --precheck-only
expect_fail "缺 node" "缺少前置工具：node" \
  env PATH="$(restricted_path nonode "${base[@]}" python3 corepack pnpm)" "$CHECK" --precheck-only

# R6：零个测试文件必须失败
mkdir -p "$WORK/empty/src"
expect_fail "零个测试文件" "测试文件" \
  env CHECK_ROOT="$WORK/empty" "$CHECK" --tests-only

# R6：package.json 与锁文件不一致时，冻结安装必须失败
mkdir -p "$WORK/drift"
cp "$ROOT/package.json" "$ROOT/pnpm-workspace.yaml" "$ROOT/pnpm-lock.yaml" "$WORK/drift/"
mkdir -p "$WORK/drift/packages"
cp -r "$ROOT/packages/server" "$WORK/drift/packages/server"
cp -r "$ROOT/packages/web" "$WORK/drift/packages/web"
rm -rf "$WORK/drift/packages"/*/node_modules
sed -i 's/"@biomejs\/biome": "[^"]*"/"@biomejs\/biome": "2.5.14"/' "$WORK/drift/package.json"
expect_fail "锁文件漂移" "" \
  env CHECK_ROOT="$WORK/drift" "$CHECK" --install-only

if ((fails > 0)); then
  echo "自检失败：$fails 项"
  exit 1
fi
echo "自检通过"
