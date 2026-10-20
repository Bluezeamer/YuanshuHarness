import type { CallFailure, Tier } from "../api";

export const TIERS: { id: Tier; label: string; hint: string }[] = [
  {
    id: "rules",
    label: "规则审批",
    hint: "规则外的动作逐次弹窗审批，可选择记住",
  },
  {
    id: "auto",
    label: "自动模式",
    hint: "规则外的动作先交审核模型判断，拿不准会交给你决定",
  },
  {
    id: "full",
    label: "完全允许",
    hint: "不再审批，agent 可在该目录内外读写文件、执行任意命令",
  },
];

export const FULL_RISK =
  "风险：完全允许会跳过全部权限判定，agent 可读写任意文件、执行任意命令（含删除），且不会再询问你。";

// 失败原因转成可读提示；ctx 给 400/409 的场景化说明。
export function describe(
  f: CallFailure,
  ctx: { bad_request?: string; conflict?: string; not_found?: string } = {},
): string {
  switch (f.kind) {
    case "bad_request":
      return ctx.bad_request ?? "请求无效";
    case "conflict":
      return ctx.conflict ?? "操作冲突，请刷新后重试";
    case "not_found":
      return ctx.not_found ?? "对象不存在，可能已被删除";
    case "unauthorized":
      return "令牌失效，请重新登录";
    case "forbidden":
      return "当前来源不被允许";
    case "rate_limited":
      return "操作过于频繁，请稍后再试";
    case "network":
      return "无法连接 Server";
    case "server":
      return "Server 返回了错误";
  }
}

export const field =
  "rounded-md border border-line bg-bg px-3 py-2 text-ink disabled:opacity-60";
export const actionBtn =
  "rounded-md border border-line bg-panel px-4 py-2 font-medium transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-deep disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-panel disabled:hover:text-ink";
export const dangerBtn =
  "rounded-md border border-danger px-4 py-2 font-medium text-danger transition-colors hover:bg-danger hover:text-bg disabled:cursor-not-allowed disabled:opacity-50";
