import { ApiError } from "../../../api/http";

export interface ActionError {
  /** 给人看的一句话。 */
  message: string;
  /** 服务端错误码；网络失败为 null。 */
  code: string | null;
  status: number;
}

// 服务端校验与冲突码 → 可读提示。码是稳定契约，文案在这里统一。
const CODE_TEXT: Record<string, string> = {
  invalid_label: "名称不能为空，最多 64 个字符",
  invalid_host: "主机名或 IP 无效：不能为空，最多 253 个字符",
  invalid_user: "登录用户无效：不能为空，最多 64 个字符",
  invalid_port: "端口必须是 1–65535 的整数",
  invalid_os: "操作系统类型无效",
  invalid_auth: "认证凭据无效，重新选择一把私钥或重新输入密码",
  auth_kind_mismatch: "认证方式与所选凭据的类型不一致",
  invalid_policy: "连接策略无效",
  invalid_jump: "跳板机无效：只能选择一台",
  jump_not_found: "跳板机不存在，可能已被删除，刷新后再试",
  jump_cycle: "这样选会形成环路：跳板机不能（间接）经由当前连接",
  jump_too_deep: "跳板链最多 4 跳，这样选会超过",
  name_exists: "这个名称已被占用，换一个",
  activating: "正在激活，地址类字段暂时锁定，等激活结束后再改",
  already_active: "这条连接已经激活",
  verify_required: "主机密钥待核对，先核对指纹再激活",
  active: "连接处于激活状态，先断开再删除",
  nothing_to_trust: "没有待核对的主机密钥",
  not_found: "连接不存在，可能已被删除，刷新后再试",
  invalid_name: "名称不能为空，最多 64 个字符",
  invalid_kind: "凭据类型无效",
  invalid_value: "内容无效：私钥或密码不能为空",
  invalid_private_key:
    "这不是可用的私钥：格式不认识，或带口令（暂不支持带口令的私钥，请先去掉口令）",
};

// 激活失败时服务端给的阶段错误码（activation.code），不是 HTTP 错误。
const ACTIVATION_TEXT: Record<string, string> = {
  secret_missing: "连接引用的凭据已不存在，重新选择认证方式",
  dns_failed: "解析不了主机名，检查拼写与 DNS",
  tcp_refused: "目标端口拒绝连接，检查端口与 sshd 是否在运行",
  tcp_timeout: "连接超时，检查网络、防火墙或跳板链",
  tcp_failed: "TCP 连接失败",
  timeout: "握手超时",
  handshake_failed: "SSH 握手失败，检查端口是否真的是 SSH 服务",
  hostkey_unknown: "首次连接，主机密钥待核对",
  hostkey_changed: "主机密钥与记录不符，已阻断，凭据没有发出",
  auth_failed: "认证被拒绝，检查用户名与私钥或密码",
  auth_error: "认证过程出错",
  probe_failed: "远端探测失败，目标主机可能没有可用的 shell",
  channel_failed: "控制通道建立失败",
  not_found: "连接已被删除",
  error: "激活失败",
};

export const activationText = (code: string): string =>
  ACTIVATION_TEXT[code] ?? code;

const brief = (list: unknown): string =>
  Array.isArray(list)
    ? list
        .map((r) => (r as { label?: unknown }).label)
        .filter((l): l is string => typeof l === "string")
        .map((l) => `「${l}」`)
        .join("、")
    : "";

export function describeError(e: unknown): ActionError {
  if (!(e instanceof ApiError))
    return { message: "操作没有成功，请重试", code: null, status: 0 };
  const { status, code } = e;
  const body = (e.body ?? {}) as Record<string, unknown>;
  if (status === 0)
    return { message: "连不上元枢服务，检查网络后重试", code: null, status };
  let message: string;
  if (status === 401) message = "登录已失效，请重新登录";
  else if (status === 429) message = "请求太频繁，稍等片刻再试";
  else if (code === "jump_inactive")
    message = `跳板机${brief([body.jump]) || ""}还没有激活，先激活跳板机再激活它`;
  else if (code === "busy")
    message = `同一时间只能激活一个连接，${brief([body.activating]) || "另一条连接"}正在激活，等它结束后再试`;
  else if (code === "referenced")
    message = `被${brief(body.referencedBy)}当作跳板机，先把它们改成别的跳板或直连`;
  else if (code === "in_use" && typeof body.directories === "number")
    message = `还有 ${body.directories} 个目录挂在这条连接上，先在目录里移除`;
  else if (code === "in_use")
    message = "还有连接在使用这个凭据，先把它们换成别的认证方式";
  else if (code && CODE_TEXT[code]) message = CODE_TEXT[code];
  else message = `操作失败（HTTP ${status}）`;
  return { message, code, status };
}
