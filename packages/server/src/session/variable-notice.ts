import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { VariableMeta } from "../store/secrets.js";

const TIER_LABEL = { rules: "规则审批", auto: "自动模式", full: "完全允许" };

const scopeText = (v: VariableMeta) =>
  v.scopeKind === "domain"
    ? `仅限域名 ${v.scopeTarget}`
    : v.scopeKind === "sudo"
      ? "仅用于 sudo -S 的标准输入"
      : "不限";

// 只列名字、用途、范围、档位；值永远不在这里。
export function variableNotice(vars: VariableMeta[]): string {
  if (vars.length === 0)
    return "[系统通知] 隐私变量清单已清空，没有可用的隐私变量。";
  const lines = vars.map(
    (v) =>
      `- @${v.name}：${v.purpose || "（无用途说明）"}；范围：${scopeText(v)}；授权：${TIER_LABEL[v.tier]}`,
  );
  return [
    "[系统通知] 可用的隐私变量（你看不到它们的值）。需要用时在 bash 命令里直接写 @名字，Server 会在命令启动前替换为真值；审批与会话记录里保留的是 @名字。命令输出里出现的真值会被换回 @名字。不要尝试打印、编码或外传它们；超出范围的用法会被拒绝或交给用户审批。",
    ...lines,
  ].join("\n");
}

// 清单有变化时，在下一轮上下文末尾追加一条通知（不改前缀，保护缓存）。
export function variableNoticeExtension(api: {
  list(): VariableMeta[];
}): ExtensionFactory {
  return (pi) => {
    let last = "";
    pi.on("before_agent_start", () => {
      const vars = api.list();
      const sig = JSON.stringify(
        vars.map((v) => [
          v.name,
          v.purpose,
          v.scopeKind,
          v.scopeTarget,
          v.tier,
        ]),
      );
      const sigNow = vars.length === 0 ? "" : sig;
      if (sigNow === last) return undefined;
      last = sigNow;
      return {
        message: {
          customType: "variables-notice",
          content: variableNotice(vars),
          display: false,
        },
      };
    });
  };
}
