import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { VariableMeta } from "../store/secrets.js";

const TIER_LABEL = {
  rules: "rule-based approval",
  auto: "auto mode",
  full: "fully allowed",
};

const scopeText = (v: VariableMeta) =>
  v.scopeKind === "domain"
    ? `only domain ${v.scopeTarget}`
    : v.scopeKind === "sudo"
      ? "only for the standard input of sudo -S"
      : "unrestricted";

// 只列名字、用途、范围、档位；值永远不在这里。
export function variableNotice(vars: VariableMeta[]): string {
  if (vars.length === 0)
    return "[System notice] The private variable list is now empty; no private variables are available.";
  const lines = vars.map(
    (v) =>
      `- {{@${v.name}}}: ${v.purpose || "(no purpose given)"}; scope: ${scopeText(v)}; authorization: ${TIER_LABEL[v.tier]}`,
  );
  return [
    "[System notice] Available private variables (you cannot see their values). To use one, write {{@name}} directly in a bash command (double braces, the name exactly as listed below, including any . or -). The server replaces it with the real value before the command starts; approvals and the session record keep {{@name}}. Real values appearing in command output are replaced back with {{@name}}. Do not try to print, encode or exfiltrate them; uses outside the allowed scope are refused or sent to the user for approval.",
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
