// 站点授权与目标放行的判定：纯逻辑，不管审批怎么弹、批准记在哪。
// 调用方（S5 的权限层）把已批准的站点表与审批函数接进来，这里只回答「放行 / 要问 / 拒绝」。
import type { Target } from "../net/target.js";

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "ask"; origin: string; reason: string; service?: true } // 需要用户批准这个站点 / 服务
  | { kind: "deny"; reason: string };

export interface AccessState {
  /** 本工作区已批准的外部站点（协议+主机+端口） */
  approved(workspaceKey: string, origin: string): boolean;
  /** 本工作区在这个环境上见过这个端口（bash 输出里认出来的，或上面批准过） */
  known(workspaceKey: string, envId: string, port: number): boolean;
}

// 内置的一小批高敏感站点（邮箱、云控制台、支付、代码托管、银行）：先定一小批，之后可调。
// 这些站点将来每个动作都要确认（接线在 S5），判定只看主机名。
const HIGH_VALUE_HOSTS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "console.aws.amazon.com",
  "console.cloud.google.com",
  "portal.azure.com",
  "paypal.com",
  "stripe.com",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "alipay.com",
  "pay.weixin.qq.com",
] as const;

// 主机名前缀规则：银行与支付类站点太多，逐个列不现实。
const HIGH_VALUE_PREFIXES = ["bank.", "banking.", "pay."] as const;

/** 后缀匹配要在标签边界上：`github.com` 命中 `gist.github.com`，不命中 `notgithub.com`。 */
function endsWithHost(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isHighValueHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  if (HIGH_VALUE_HOSTS.some((h) => endsWithHost(host, h))) return true;
  return HIGH_VALUE_PREFIXES.some((p) => host.startsWith(p));
}

const originOf = (url: string): string => new URL(url).origin;

/**
 * 打开一个目标要不要审批：
 * - 本工作区的文件免审批；
 * - agent 自己起过的服务（见过的端口）或已批准的来源免审批，其余服务要问；
 * - 公网站点已批准就放行，否则要问。
 * 目标解析阶段就被拒的（TargetError）由调用方处理，这里不管。
 */
export function decideOpen(
  target: Target,
  workspaceKey: string,
  state: AccessState,
  shown = target.url,
): AccessDecision {
  if (target.kind === "file") return { kind: "allow" };
  if (target.kind === "service") {
    const origin = originOf(target.url);
    if (
      state.known(workspaceKey, target.envId, target.port) ||
      state.approved(workspaceKey, origin)
    )
      return { kind: "allow" };
    return {
      kind: "ask",
      origin,
      reason: `agent 要访问 ${shown} 上的服务（这个端口没在命令输出里出现过）`,
      service: true,
    };
  }
  const origin = originOf(target.url);
  if (state.approved(workspaceKey, origin)) return { kind: "allow" };
  return {
    kind: "ask",
    origin,
    reason: `agent 要访问外部站点 ${origin}`,
  };
}
