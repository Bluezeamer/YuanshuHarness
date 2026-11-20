import { ApiError } from "../../../api/http";

export interface ActionError {
  /** 给人看的一句话。 */
  message: string;
  code: string | null;
}

// 服务端校验码 → 可读提示。
const CODE_TEXT: Record<string, string> = {
  invalid_name:
    "名称需小写字母开头，3–48 位，可含小写字母、数字、下划线、点与连字符",
  invalid_desc: "写一句描述：agent 只靠它判断什么时候该引用",
  invalid_value: "值至少 4 个字符，最多 16 KB",
  invalid_kind: "类型创建后不能改",
  invalid_file: "文件名无效，或这个变量不是文件型",
  invalid_policy: "引用策略无效",
  invalid_expiry: "有效期无效：天数 1–365，或一个有效的到期时间",
  invalid_group: "变量组名称 1–32 个字符，不能含控制字符",
  invalid_workspace: "有工作区不存在，可能已被删除，刷新后再试",
  invalid_variable: "有变量不存在，可能已被删除，刷新后再试",
  limit_exceeded: "变量数量或总大小已到上限，先删掉不用的",
  name_exists: "这个名称已被占用（变量名全局唯一），换一个名称",
  not_found: "变量不存在，可能已被删除，刷新后再试",
};

/** 前端预校验与服务端返回共用同一套文案。 */
export const codeText = (code: string): string => CODE_TEXT[code] ?? code;

export function describeError(e: unknown): ActionError {
  if (!(e instanceof ApiError))
    return { message: "操作没有成功，请重试", code: null };
  const { status, code } = e;
  if (status === 0)
    return { message: "连不上元枢服务，检查网络后重试", code: null };
  if (status === 401) return { message: "登录已失效，请重新登录", code };
  if (status === 429) return { message: "请求太频繁，稍等片刻再试", code };
  return {
    message:
      code && CODE_TEXT[code] ? CODE_TEXT[code] : `操作失败（HTTP ${status}）`,
    code,
  };
}
