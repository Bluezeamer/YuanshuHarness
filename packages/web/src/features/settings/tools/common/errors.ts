import { ApiError } from "../../../../api/http";

export interface ActionError {
  /** 给人看的一句话。 */
  message: string;
  /** 服务端错误码；网络失败为 null。 */
  code: string | null;
  status: number;
  /** 服务端错误体，调用方需要额外字段时取（如改名被引用的 references）。 */
  body: unknown;
}

type Failed = { ok: false } & ActionError;
export type Outcome<T> = { ok: true; data: T } | Failed;

// 服务端没有给 message 时的兜底文案。技能 / MCP 的业务错误多数自带 message，优先用它。
const CODE_TEXT: Record<string, string> = {
  invalid_rule: "内、外两档都要是 放行 / 审批 之一",
  not_found: "这一项不存在，可能已被删除，刷新后再试",
  name_exists: "同名条目已存在",
  invalid_source: "来源格式不对",
  locked: "已锁定在某一版，先解除锁定再更新",
  invalid_version: "版本号不合法",
  mcp_referenced: "这个服务正被其他位置引用，先移除引用",
  invalid_config: "配置不合法",
  binary_file: "二进制文件，不提供预览",
};

export const fail = (e: unknown): Failed => ({
  ok: false,
  ...describeError(e),
});

export function describeError(e: unknown): ActionError {
  if (!(e instanceof ApiError))
    return {
      message: "操作没有成功，请重试",
      code: null,
      status: 0,
      body: null,
    };
  const { status, code, body } = e;
  const detail = (body as { message?: unknown } | null)?.message;
  const mk = (message: string): ActionError => ({
    message,
    code,
    status,
    body,
  });
  if (status === 0) return mk("连不上元枢服务，检查网络后重试");
  if (status === 401) return mk("登录已失效，请重新登录");
  if (status === 429) return mk("请求太频繁，稍等片刻再试");
  if (typeof detail === "string" && detail !== "") return mk(detail);
  if (code && CODE_TEXT[code]) return mk(CODE_TEXT[code]);
  return mk(`操作失败（HTTP ${status}）`);
}
