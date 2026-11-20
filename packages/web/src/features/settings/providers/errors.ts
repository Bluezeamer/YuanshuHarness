import { ApiError } from "../../../api/http";

export interface ActionError {
  /** 给人看的一句话。 */
  message: string;
  /** 服务端错误码；网络失败为 null。 */
  code: string | null;
  status: number;
}

// 服务端校验码 → 可读提示。码是稳定契约，文案在这里统一。
const CODE_TEXT: Record<string, string> = {
  invalid_body: "请求格式不对，刷新页面后重试",
  invalid_name: "名称不能为空，最多 64 个字符",
  invalid_slug:
    "标识只能用小写字母、数字和连字符，且以字母或数字开头（最多 63 位）",
  slug_taken: "这个标识已被其他供应商占用，换一个",
  invalid_api: "请求协议必须是四种之一",
  invalid_base_url: "Base URL 无效：需要以 http 或 https 协议开头的完整地址",
  invalid_method: "这个供应商不支持该认证方式",
  invalid_key_storage: "密钥保存位置无效",
  invalid_env_variable: "环境变量名只能含字母、数字和下划线，且不以数字开头",
  invalid_command: "命令不能为空",
  command_required: "认证方式为「命令」时必须先填写命令",
  env_variable_required: "认证方式为「环境变量」时必须填写变量名",
  invalid_api_key: "API Key 无效：不能为空，且不超过 16 KB",
  invalid_compat: "协议兼容项无效",
  invalid_auth_header:
    "鉴权头格式不对：写成「头名」或「头名: 前缀」，头名只能含字母、数字和 -_ 等符号，不能带空格或换行",
  invalid_models:
    "模型列表无效：id 不能重复，且思考档位必须与「思考」开关、映射一致",
  invalid_model: "测试用的模型 id 无效",
  builtin_immutable: "内置供应商的名称、标识、协议和环境变量名不可修改",
  builtin_provider: "内置供应商不能删除",
  in_use: "还有 Agent 在使用这个供应商，先把它们换到别的模型再删除",
  not_found: "供应商不存在，可能已被删除，刷新后再试",
  probe_unsupported: "这个协议不支持拉取模型列表，请手动添加模型",
  oauth_unsupported: "这个供应商不支持订阅登录，请改用 API Key",
};

// 502：探测阶段的上游错误。
const UPSTREAM_TEXT: Record<string, string> = {
  timeout: "端点响应超时",
  unreachable: "无法连接端点，检查 Base URL、网络与代理",
  unauthorized: "端点拒绝了密钥（401/403），检查密钥是否有效",
  bad_response: "端点返回的内容不是模型列表，检查协议与 Base URL 是否匹配",
  http_error: "端点返回了错误状态码",
};

/** 校验码对应的提示，供前端预校验与服务端返回共用同一套文案。 */
export const codeText = (code: string): string => CODE_TEXT[code] ?? code;

export function describeError(e: unknown): ActionError {
  if (!(e instanceof ApiError))
    return { message: "操作没有成功，请重试", code: null, status: 0 };
  const { status, code } = e;
  const detail = (e.body as { message?: unknown } | null)?.message;
  if (status === 0)
    return {
      message: "连不上元枢服务，检查网络后重试",
      code: null,
      status,
    };
  let message: string;
  if (status === 401) message = "登录已失效，请重新登录";
  else if (status === 429) message = "请求太频繁，稍等片刻再试";
  else if (status === 502 && code && UPSTREAM_TEXT[code])
    message = UPSTREAM_TEXT[code];
  else if (code === "no_credential" && typeof detail === "string")
    message = detail;
  else if (code && CODE_TEXT[code]) message = CODE_TEXT[code];
  else message = `操作失败（HTTP ${status}）`;
  return { message, code, status };
}
