// 「永不交审核模型」的硬边界清单，供设置页只读展示（ADR-0070）。
// 每条对应 decide / extension 里 reviewable=false 或无视档位的分支；
// 名单类条目（敏感名、不可记住的首词）直接取自判定用的同一份常量，
// boundaries.test.ts 逐条驱动真实扩展，清单与行为对不上就会失败。
import { NO_REMEMBER_FIRST } from "./bash.js";
import { SENSITIVE_NAMES } from "./paths.js";

export interface Boundary {
  id: string;
  title: string;
  detail: string;
  /** 具体名单；仅名单类条目有。 */
  items?: readonly string[];
  /** 目录为「完全允许」时是否仍然拦截。 */
  inFull: boolean;
}

export const BOUNDARIES: readonly Boundary[] = [
  {
    id: "root-shell",
    title: "打开 root shell",
    detail:
      "su、sudo -s / -i、sudo bash 等直接进入 root shell 的命令，任何档位都要人工批准，且不可记住。",
    inFull: true,
  },
  {
    id: "sensitive",
    title: "敏感路径与文件名",
    detail:
      "读写、命令参数或文件选择器命中下列名称（大小写不敏感）时必须人工批准，且不可记住；以 .example / .sample / .template / .dist / .tpl 结尾的模板名除外。",
    items: SENSITIVE_NAMES,
    inFull: false,
  },
  {
    id: "sudo",
    title: "含 sudo 的命令",
    detail: "提权命令不交审核模型，只由你决定。",
    inFull: false,
  },
  {
    id: "opaque",
    title: "无法静态分析的命令",
    detail:
      "shell 包装里看不清要做什么的写法：bash script.sh 这类脚本文件或标准输入、嵌套包装、包装内解析不了的脚本，只交人工。单层可解析的 bash -c '…' 会展开后照常判定。",
    inFull: false,
  },
  {
    id: "unresolvable-path",
    title: "无法解析的路径",
    detail:
      "悬空或循环的符号链接等无法可靠解析的路径，按目录外处理，只交人工且不可记住。",
    inFull: false,
  },
  {
    id: "unknown-tool",
    title: "未知工具（自定义 / MCP）",
    detail:
      "没有能力信息可供判断，不交审核模型，只交人工且不可记住。MCP 服务可在「工具与能力」里按服务改成放行或禁止，默认审批。",
    inFull: false,
  },
  {
    id: "variable-scope",
    title: "隐私变量超出适用范围",
    detail:
      "变量被用在登记范围之外（如域名不符、sudo 密码没按规定写法），一律人工确认，已记住的规则也不放行。",
    inFull: true,
  },
];

/** 首词在其中的命令不可「记住」，每次都要审批。 */
export const NO_REMEMBER_COMMANDS: readonly string[] = [...NO_REMEMBER_FIRST];
