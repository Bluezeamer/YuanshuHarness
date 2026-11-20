import type { LastTest, StageName } from "../../../api/providers";

export const STAGE_LABEL: Record<StageName, string> = {
  credential: "凭据",
  endpoint: "端点",
  models: "模型列表",
  token: "首 token",
};

// 阶段的一行说明；模型列表阶段点名“仅列表”，测试不探测能力。
export const STAGE_DESC: Record<StageName, string> = {
  credential: "按解析链找到可用凭据",
  endpoint: "Base URL 可达（不带凭据）",
  models: "GET /models，仅取模型 id 列表",
  token: "最小补全请求，收到第一个 token",
};

export interface Explained {
  title: string;
  hint: string;
}

// 先按错误码，再按阶段兜底。detail 是服务端给的错误文本（已遮掉密钥）。
const BY_CODE: Record<
  string,
  (stage: StageName, detail?: string) => Explained
> = {
  no_credential: (_s, d) => ({
    title: "没有可用凭据",
    hint: d || "先在「连接」里配置凭据，再测试。",
  }),
  timeout: (s) => ({
    title: s === "token" ? "首 token 超时" : "请求超时",
    hint:
      s === "token"
        ? "模型迟迟没有输出：检查模型 id 是否存在，或端点是否过载。"
        : "检查网络、代理，以及端点是否可达。",
  }),
  unreachable: (_s, d) => ({
    title: "无法连接端点",
    hint: `${d ? `${d}。` : ""}检查 Base URL 的主机和端口；自建端点确认服务已启动。`,
  }),
  unauthorized: () => ({
    title: "密钥被拒绝",
    hint: "检查密钥是否有效、有没有读取模型列表的权限。",
  }),
  http_error: (_s, d) => ({
    title: "端点返回了错误状态",
    hint: `${d ? `${d}。` : ""}确认 Base URL 带正确的版本路径（如 /v1），且请求协议与端点一致。`,
  }),
  bad_response: () => ({
    title: "响应不是模型列表",
    hint: "多半是 Base URL 或请求协议选错了：确认版本路径与协议。",
  }),
  empty_model_list: () => ({
    title: "端点返回了空的模型列表",
    hint: "端点可达但没有列出模型。手动添加模型 id 后再测首 token。",
  }),
  no_model: () => ({
    title: "没有可用于测试的模型",
    hint: "先添加一个模型，或在测试连接旁选定一个模型。",
  }),
  completion_failed: (_s, d) => ({
    title: "补全请求失败",
    hint: d || "端点拒绝了最小补全请求，检查模型 id 与协议。",
  }),
  no_token: () => ({
    title: "模型没有返回内容",
    hint: "请求成功但没有输出，检查模型 id 是否是对话模型。",
  }),
};

export function explainFailure(
  stage: StageName,
  code: string | null,
  detail?: string,
): Explained {
  const f = code ? BY_CODE[code] : undefined;
  if (f) return f(stage, detail);
  return {
    title: `${STAGE_LABEL[stage]}阶段失败`,
    hint: detail || "服务端没有给出原因，换个模型或检查配置后重试。",
  };
}

export const fmtMs = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;

/** ISO 时间 → “10-25 14:03”（本地时区）；解析失败原样返回。 */
export function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** “上次测试”的一句话摘要，如：通过 · 首 token 320 ms · 共 1.2 s。 */
export function summarizeLastTest(t: LastTest): string {
  if (t.ok) return `通过 · 首 token ${fmtMs(t.ttft)} · 共 ${fmtMs(t.total)}`;
  const e = explainFailure(t.stage, t.errorCode ?? null);
  return `失败于${STAGE_LABEL[t.stage]}阶段 · ${e.title}`;
}
