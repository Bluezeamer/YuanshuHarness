#!/usr/bin/env bash
# scripts/check.sh 的自检：用已知坏输入证明它会失败（R4–R6）。
# 做法：造最小的临时工程，用 CHECK_ROOT 驱动 check.sh，每次只让一个步骤失败，整体必须失败。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$ROOT/scripts/check.sh"
WORK="$(mktemp -d)" || { echo "自检夹具失败：无法创建临时目录"; exit 2; }
trap 'rm -rf "$WORK"' EXIT
fails=0

# pnpm 12 只认 pnpm_config_ 前缀的环境变量；不设的话 store 可能建到仓库外。
export pnpm_config_store_dir="$WORK/store"

# expect_fail <名称> <输出中必须包含的字样> <命令...>
expect_fail() {
  local name="$1" needle="$2"
  shift 2
  local out
  if out="$("$@" 2>&1)"; then
    echo "FAIL  $name：应当失败，实际成功"
    fails=$((fails + 1))
  elif [[ "$out" != *"$needle"* ]]; then
    echo "FAIL  $name：已失败，但输出缺少「$needle」"
    echo "$out" | tail -8 | sed 's/^/      /'
    fails=$((fails + 1))
  else
    echo "ok    $name"
  fi
}

# expect_pass <名称> <命令...>：对照组，证明夹具本身是好的
expect_pass() {
  local name="$1"
  shift
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "FAIL  $name：应当成功，实际失败"
    echo "$out" | tail -8 | sed 's/^/      /'
    fails=$((fails + 1))
  elif [[ "$out" != *"全部检查通过"* ]]; then
    echo "FAIL  $name：已成功，但输出缺少「全部检查通过」"
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

PM="$(sed -n 's/.*"packageManager": "\([^"]*\)".*/\1/p' "$ROOT/package.json")"

# make_stub <目录> [坏掉的步骤]
# 坏掉的步骤：install | typecheck | lint | test | build | smokepkg | smokeimg | aisdlc | notests；留空则全部正常。
make_stub() {
  local dir="$1" bad="${2:-}"
  local c_typecheck=true c_lint=true c_test=true c_build=true
  [[ "$bad" =~ ^(typecheck|lint|test|build)$ ]] && printf -v "c_$bad" 'echo STUB-FAIL-%s; exit 1' "$bad"

  mkdir -p "$dir/packages/a" "$dir/docs/intent/active" "$dir/scripts"
  # 冒烟脚本的桩：check.sh 按 CHECK_ROOT 调用，所以临时工程里放自己的版本
  local sp="echo STUB-SMOKE-PACKAGE-RAN" si="echo STUB-SMOKE-IMAGE-RAN"
  [[ "$bad" == smokepkg ]] && sp="echo STUB-FAIL-smokepkg; exit 1"
  [[ "$bad" == smokeimg ]] && si="echo STUB-FAIL-smokeimg; exit 1"
  printf '#!/usr/bin/env bash\n%s\n' "$sp" > "$dir/scripts/smoke-package.sh"
  printf '#!/usr/bin/env bash\n%s\n' "$si" > "$dir/scripts/smoke-image.sh"
  chmod +x "$dir/scripts/smoke-package.sh" "$dir/scripts/smoke-image.sh"
  [[ "$bad" == notests ]] || touch "$dir/packages/a/stub.test.ts"
  # 包目录之外的测试文件不得被计入
  [[ "$bad" == notests ]] && touch "$dir/stray.test.ts"
  cat > "$dir/package.json" <<EOF
{ "name": "stub", "private": true, "packageManager": "$PM",
  "scripts": { "typecheck": "$c_typecheck", "lint": "$c_lint", "test": "$c_test", "build": "$c_build" } }
EOF
  (cd "$dir" && pnpm install --lockfile-only >/dev/null 2>&1) \
    || { echo "自检夹具失败：无法为临时工程生成锁文件"; exit 2; }
  # 锁文件生成之后再改依赖，造出 package.json 与锁文件不一致
  [[ "$bad" == install ]] \
    && sed -i 's/"private": true,/"private": true, "dependencies": { "left-pad": "1.3.0" },/' "$dir/package.json"
  ln -s "$ROOT/.agents" "$dir/.agents"
  if [[ "$bad" == aisdlc ]]; then
    mkdir -p "$dir/docs/intent/done/260101-stub"
    printf '# Intent: stub\nAuthor: a\nStatus: draft\nDate: 2026-01-01\nLane: build\n' \
      > "$dir/docs/intent/done/260101-stub/intent.md"
  fi
}

[[ -x "$CHECK" ]] || { echo "FAIL  scripts/check.sh 不存在或不可执行"; exit 1; }

make_stub "$WORK/ok"
expect_pass "对照：各步骤都正常的临时工程" env CHECK_ROOT="$WORK/ok" "$CHECK"

# R4、R6：任一步骤失败，整体必须失败
for pair in \
  "install:ERR_PNPM_OUTDATED_LOCKFILE" \
  "typecheck:STUB-FAIL-typecheck" \
  "lint:STUB-FAIL-lint" \
  "test:STUB-FAIL-test" \
  "build:STUB-FAIL-build" \
  "smokepkg:STUB-FAIL-smokepkg" \
  "smokeimg:STUB-FAIL-smokeimg" \
  "aisdlc:校验未通过" \
  "notests:没有找到任何测试文件"; do
  step_name="${pair%%:*}"
  make_stub "$WORK/$step_name" "$step_name"
  expect_fail "步骤失败：$step_name" "${pair#*:}" env CHECK_ROOT="$WORK/$step_name" "$CHECK"
done

# R5：缺失的前置工具必须被点名
base=(bash env dirname cat sed grep sort head tr docker)
expect_fail "缺 python3" "缺少前置工具：python3" \
  env PATH="$(restricted_path nopy "${base[@]}" node pnpm)" CHECK_ROOT="$WORK/ok" "$CHECK"
expect_fail "缺 pnpm" "缺少前置工具：pnpm" \
  env PATH="$(restricted_path nopnpm "${base[@]}" node python3)" CHECK_ROOT="$WORK/ok" "$CHECK"
expect_fail "缺 node" "缺少前置工具：node" \
  env PATH="$(restricted_path nonode "${base[@]}" python3 pnpm)" CHECK_ROOT="$WORK/ok" "$CHECK"

# R15：缺 docker、守护进程不可用，都必须失败并点名；也不得因此被"跳过"
nodocker_base=(bash env dirname cat sed grep sort head tr)
expect_fail "缺 docker" "缺少前置工具：docker" \
  env PATH="$(restricted_path nodocker "${nodocker_base[@]}" node pnpm python3)" CHECK_ROOT="$WORK/ok" "$CHECK"
brokendocker="$(restricted_path brokendocker "${nodocker_base[@]}" node pnpm python3)"
printf '#!/usr/bin/env bash\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n' > "$brokendocker/docker"
chmod +x "$brokendocker/docker"
expect_fail "docker 守护进程不可用" "docker 守护进程不可用" \
  env PATH="$brokendocker" CHECK_ROOT="$WORK/ok" "$CHECK"

# pnpm 实际版本与锁定不一致（例如过旧、不会自动切换的 pnpm）必须失败
fake="$(restricted_path badpnpm "${base[@]}" node python3)"
printf '#!/usr/bin/env bash\necho 0.0.1\n' > "$fake/pnpm"
chmod +x "$fake/pnpm"
expect_fail "pnpm 版本与锁定不符" "pnpm 版本与 package.json 锁定的不一致" \
  env PATH="$fake" CHECK_ROOT="$WORK/ok" "$CHECK"

if ((fails > 0)); then
  echo "自检失败：$fails 项"
  exit 1
fi
echo "自检通过"
