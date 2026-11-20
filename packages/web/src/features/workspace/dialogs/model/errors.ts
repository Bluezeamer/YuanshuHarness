import { ApiError } from "../../../../api/http";

/** 服务端 400 的可读码 → 面向用户的说明 */
const TABLE: Record<string, string> = {
  unknown_agent: "所选 Agent 预设不存在，请重新选择。",
  agent_mismatch: "配置里的预设与会话不一致。",
  agent_immutable: "会话创建后不能更换 Agent。",
  unknown_model:
    "服务端没有登记这个模型（会话配置按模型登记校验，供应商页的模型需先登记）。",
  bad_reasoning: "所选思考级别不被支持，请重新选择。",
  unknown_capability: "有能力在库里已不存在。",
  duplicate_capability: "能力列表里有重复项。",
  unknown_tool: "能力里有内置工具在服务端不存在。",
  unknown_mcp: "能力里有 MCP 服务在库里已不存在。",
  unknown_field: "提交了服务端不认识的字段，请刷新页面后重试。",
  invalid_path: "目录不存在或不是目录，请重新选择。",
  invalid_environment: "所选主机当前不可用，请重新选择。",
  env_unreachable: "连不上所选主机，请确认连接已激活。",
  invalid_name: "名称不合法。",
  path_exists: "该目录已被其他主机上的目录占用。",
  name_exists: "这台主机上已有同名目录，请换一个名字。",
  local_immutable: "主目录不能更换或移除。",
  unknown_directory: "有目录已不存在，请移除后重试。",
  duplicate_directory: "目录里有重复项（同一台主机的同一目录只能挂一次）。",
  too_many_directories: "目录太多了，一个工作区最多 12 个（含主目录）。",
  unknown_group: "分组已不存在，请刷新后重试。",
  session_running: "有会话正在运行，先停下它再试。",
};

export function describeError(code: string | null): string {
  if (code && TABLE[code]) return TABLE[code];
  return code ? `提交失败（${code}）。` : "提交失败，请稍后重试。";
}

/** 任意失败 → 说明：断网单说，服务端的可读码查表 */
export const failureText = (err: unknown): string =>
  err instanceof ApiError && err.status === 0
    ? "无法连接服务器，请检查网络后重试。"
    : describeError(err instanceof ApiError ? err.code : null);
