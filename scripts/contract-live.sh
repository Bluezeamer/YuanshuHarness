#!/usr/bin/env bash
# 手动冒烟：对真实 OpenAI 兼容端点跑一次最小会话，确认 SDK 在真实端点上能走通。
# 不进 CI。契约用例本身（对着本地 stub）由 scripts/check.sh 覆盖。升级 pi SDK 前后建议跑一次。
#
# 用法：
#   YUANSHU_LIVE_BASE_URL=<端点，含 /v1> YUANSHU_LIVE_MODEL=<模型 id> [YUANSHU_LIVE_API_KEY=<key>] scripts/contract-live.sh
# 缺少必需的环境变量时以非零状态失败，不会静默跳过。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ -n "${YUANSHU_LIVE_BASE_URL:-}" ]] || { echo "缺少环境变量 YUANSHU_LIVE_BASE_URL" >&2; exit 2; }
[[ -n "${YUANSHU_LIVE_MODEL:-}" ]] || { echo "缺少环境变量 YUANSHU_LIVE_MODEL" >&2; exit 2; }

cd "$REPO/packages/server"
exec node test/live/smoke.ts
