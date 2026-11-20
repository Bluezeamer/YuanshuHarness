import { ApiError } from "../../../api/http";
import { describeError } from "../providers/errors";

// 本页两个接口的校验码 → 可读提示；其余沿用供应商页那一套（网络、401、429……）。
const CODE_TEXT: Record<string, string> = {
  invalid_directory_start:
    "起点不合法：不能为空，不能含 NUL 字符，最长 4096 个字符。",
  invalid_image_compression:
    "图片压缩参数不合法：尺寸 256–2000 像素、编码上限 64–4608 KiB、JPEG 质量 10–100。",
  unknown_model: "这个模型已不在供应商里，刷新页面后再试。",
  review_model_missing: "「模型」档要先配好审批模型。",
  invalid_review_model: "审批模型不合法，换一个再试。",
  invalid_thinking: "这个模型不支持所选的思考级别。",
};

export function messageOf(e: unknown): string {
  const code = e instanceof ApiError ? e.code : null;
  // 压缩与重试的 400 自带中文原因（范围、settings.json 不是合法 JSON 等）
  const detail = (e instanceof ApiError ? e.body : null) as {
    message?: unknown;
  } | null;
  if (code === "bad_request" && typeof detail?.message === "string")
    return detail.message;
  return (code && CODE_TEXT[code]) || describeError(e).message;
}
