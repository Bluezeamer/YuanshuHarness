#!/usr/bin/env bash
# 把 server 打成 npm tarball，装包冒烟与镜像构建共用这一份。
# 先清掉全部构建产物再构建，不依赖工作目录里的残留；顺序显式写出：先 web，后 server，再把 web 产物复制进 server 包。
#
# 用法：scripts/pack.sh <输出目录>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?用法：scripts/pack.sh <输出目录>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

cd "$REPO"
rm -rf packages/web/dist packages/server/dist packages/server/web packages/server/NOTICE packages/server/licenses
pnpm --filter yuanshu-harness-web build
pnpm --filter yuanshu-harness-server build
cp -R packages/web/dist packages/server/web
# Apache-2.0 要求随分发件附许可证副本与 NOTICE（bash.ts 改写自 openai/codex）。
cp NOTICE packages/server/NOTICE
cp -R licenses packages/server/licenses

rm -f "$OUT"/*.tgz
(cd packages/server && pnpm pack --pack-destination "$OUT")

shopt -s nullglob
tarballs=("$OUT"/*.tgz)
((${#tarballs[@]} == 1)) || { echo "打包失败：$OUT 里应当恰好有一个 tarball，实际 ${#tarballs[@]} 个" >&2; exit 1; }
echo "tarball: ${tarballs[0]}"
